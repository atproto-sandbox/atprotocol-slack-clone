import { getDeskConfig } from "@flock/deployment/config";
import { deskMemberScopes } from "@flock/protocol/scopes";
import { DeskClient } from "./ui/desk-client";

export const dynamic = "force-dynamic";

export default async function DeskHomePage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string | string[] }>;
}) {
  const config = getDeskConfig();
  const resolved = await searchParams;
  const invite = typeof resolved.invite === "string" ? resolved.invite : null;
  return (
    <DeskClient
      config={{
        appUrl: config.appUrl.origin,
        plcUrl: config.plcDirectoryUrl.origin,
        scope: deskMemberScopes().join(" "),
      }}
      initialInviteUri={invite}
    />
  );
}
