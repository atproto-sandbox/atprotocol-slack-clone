import { NextResponse, type NextRequest } from "next/server";
import type * as GetRecord from "@/lexicons/api/types/com/atproto/space/getRecord";
import { listBoundedRepos } from "@/atproto/record-pages";
import { isMissingXrpcResource } from "@/atproto/xrpc";
import { requireSession } from "@/auth/session";
import { resolvePds } from "@/atproto/identity";
import { mintSpaceCredential } from "@/atproto/space-credential";
import { registerSpaceNotifications } from "@/atproto/notifications";
import { fetchInboxWriters } from "@/operator/client";
import { decisionRecordKey, inboxUri } from "@/protocol/keys";
import { validateSpaceRecord } from "@/protocol/records";
import { readWriterJoinRequests } from "@/workspaces/inbox-requests";
import { requireWorkspaceSummary, WorkspaceEnvelopeError, workspaceDegradedMessage } from "@/workspaces/read-model";
import { mapLimited } from "@/lib/map-limited";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const workspace = request.nextUrl.searchParams.get("workspace") ?? "";
    const summary = await requireWorkspaceSummary(session, workspace);
    if (!summary.isAdmin) return NextResponse.json({ error: "Active workspace admin permission is required." }, { status: 403 });
    if (summary.degradedReasons.length > 0) {
      return NextResponse.json({ error: workspaceDegradedMessage(summary.degradedReasons) }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    const candidates = await fetchInboxWriters(session, workspace);
    const inbox = inboxUri(summary.authorityDid, summary.skey);
    const inboxCredential = await mintSpaceCredential(session, inbox);
    await registerSpaceNotifications(inboxCredential, inbox);
    const authorityClient = inboxCredential.client(await resolvePds(summary.authorityDid));
    const repoScan = await listBoundedRepos(authorityClient, { space: inbox, maxRepos: 2_000 });
    if (repoScan.truncated) throw new WorkspaceEnvelopeError("Inbox writer set exceeds the 2,000-repo scan limit; inbox results are incomplete.");
    const repos = repoScan.repos;
    const candidateDids = new Set([...candidates.writers, ...repos.map((repo) => repo.did)]);
    const perWriter = await mapLimited([...candidateDids], 8, (repoDid) => readWriterJoinRequests({
      clientFor: async () => inboxCredential.client(await resolvePds(repoDid)),
      inbox, repoDid, authorityDid: summary.authorityDid, channels: summary.channels,
    }));
    const requests = perWriter.map((result) => result.requests);
    const skipped = perWriter.flatMap((result) => result.skipped ? [result.skipped] : []);
    const currentRequests = await mapLimited(requests.flat(), 8, async (joinRequest) => {
      try {
        const rkey = decisionRecordKey(joinRequest.uri);
        const decision = await authorityClient.query<GetRecord.OutputSchema>("com.atproto.space.getRecord", {
          space: inbox, repo: summary.authorityDid, collection: "org.slack.joinDecision", rkey,
        });
        const valid = validateSpaceRecord("org.slack.joinDecision", decision.value, {
          authorityDid: summary.authorityDid, spaceUri: inbox, repoDid: summary.authorityDid, rkey,
        }).valid;
        return valid && decision.value.request === joinRequest.uri && decision.value.requestId === joinRequest.requestId
          ? null
          : joinRequest;
      } catch (error) {
        if (isMissingXrpcResource(error)) return joinRequest;
        throw error;
      }
    });
    return NextResponse.json({ requests: currentRequests.flatMap((joinRequest) => joinRequest ? [joinRequest] : []).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), skipped }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to sync the admin inbox.";
    const status = message === "Unauthorized" ? 401 : error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : 400;
    return NextResponse.json({ error: message.slice(0, 500) }, { status, headers: { "cache-control": "no-store" } });
  }
}
