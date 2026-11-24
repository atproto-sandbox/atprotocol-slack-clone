# Tell a writer whether the space they wrote into exists

Status against `6747610566` + `opensocial.group` `8df0cc82` (R13, 2026-11-21): **Still open on core ATProto Spaces; mitigated on `apps/group-host` for outbound group invites.** Cross-host `com.atproto.space.putRecord` still commits locally first by design. In R13, Flock's `opensocial.group` Group Host (`apps/group-host`) mitigates this for cross-PDS `group.opensocial.invites/self` writes by recording the invitee PDS's `notifyRepoUpdate` outcome in `invite_delivery` (`pending` / `delivered` / `failed (lastError)`) and exposing `/group-admin/invite-deliveries` + `/group-admin/retry-invite-delivery` in `GroupGovernancePanel`. Browser-to-PDS Direct Messages (`new.flock.dm.*`), where the writer is an unmodified personal PDS that swallows `SpaceNotFound` internally, still rely on reading public `new.flock.dm.declaration`.

Status against `5d88b414` (2026-10-30): Now blocking for applications. The workaround this draft describes (asking the recipient's inbox for a credential and reading `SpaceNotFound` versus `UserNotAuthorized`) no longer works, because the authority answers a non-member with `SpaceNotFound` for an existing space too (U9 was implemented). `putRecord` into another authority's space still succeeds either way. Our app now has recipients publish a small public declaration record in their own repo and has senders read it first, which drifts if a space is deleted by other means. A protocol-level signal is still the right fix; a minimal one would be an optional `delivered`/`spaceExists` hint in the `putRecord` response when the writer's PDS happens to know, or a way for a writer to ask a space host whether it accepts writes from them without a read grant.

Status against `5b95b2f2`: Still open. `putRecord` declares `SpaceNotFound` but the handler never checks the space host: it stores the record locally, and `spaceNotifications.notify` swallows a non-retryable `SpaceNotFound` from the authority with a log line. The writer still gets HTTP 200.

Status against `619c6e85` and proposal `c76714ac` (2026-10-21): Still open, but now specified behavior rather than an oversight. The proposal's new "Repo lifecycle" section says that when the space authority is another DID, the writer's PDS "does not need to check whether the space exists before accepting the write", and PDS PR #5655 pins it with a test (`creates a repo in another authority's space without checking it exists`). The same change makes an authority's write to its *own* missing or deleted space fail with `SpaceNotFound`. So the request is no longer "fix the missing check"; it is "add an optional signal to a deliberately unchecked write", and both proposed options below leave the unchecked-write rule intact.

## Summary
`com.atproto.space.putRecord` into a space hosted on another account succeeds whether or not that space exists: the record is stored in the writer's own repo and the authority host's `SpaceNotFound` is never reported back. A sender cannot tell "delivered" from "wrote into nothing", and the only workaround needs a read-level grant the sender should not need.

## Problem
Reproduced in a team-chat app built on `787a730f` (direct-message requests are written into the recipient's inbox space):
1. `did:plc:alice` has never enabled direct messages, so `at://did:plc:alice/space/org.slack.dm.inbox/self` does not exist.
2. `did:plc:bob` calls `putRecord` for a request into that inbox, on the same host and across hosts. Both return HTTP 200 with a record URI and `validationStatus: unknown`.
3. Bob's app reports the request as delivered. It never will be: nothing tracks Bob as a writer of a space that does not exist.

The earlier workaround was to mint a space credential for the inbox first and read the error (`SpaceNotFound` meant no inbox, `UserNotAuthorized` meant it existed); `5d88b414` closed it by answering `SpaceNotFound` for both. It had required the OAuth grant `space:<type>?authority=*&action=read`, i.e. permission to ask any account of that type for read credentials, purely to find out whether a write will land. It is also two extra round trips per recipient (a 100-person group conversation makes 99 of them).

## Proposed change
Either of these, whichever fits the host's trust model better:
- **Report it on the write.** When the repo host can resolve the space host, `putRecord` returns `spaceStatus: "confirmed" | "unknown"`, and `unknown` is documented as "the write is stored locally and may never be tracked". A host that cannot check says so instead of implying success.
- **A write-scoped existence check.** `com.atproto.space.getSpaceStatus` (params `{ space }`) answers `{ exists, deleted }` for any caller holding a *write* grant on that space type. The answer discloses nothing a successful write would not.

## Alternatives considered
- A public declaration record in the recipient's own repo (what we ship since `5d88b414`, `org.slack.dm.declaration`, read with a plain public `getRecord` before sending). It works for an app that controls both sides, and it can go stale: an inbox deleted outside the app leaves the declaration behind, so a request to it still reads as delivered. It also puts the burden on every recipient app, which is what a host-side answer would remove.
- Treat all requests as best-effort and never show delivery state. Loses the one signal a sender has that the recipient is unreachable.

## Compatibility
Additive: a new optional response field or a new method.

## Open questions
- Does confirming existence let a stranger enumerate which accounts enabled a feature? The credential probe already allows that today, so this does not make it worse, and the write path discloses it anyway once the recipient tracks the writer.

## Related work: opensocial.group
Adopted in Flock R13 (`apps/group-host`): because Group Host itself sends `com.atproto.space.notifyRepoUpdate` to the invitee's personal PDS when writing `group.opensocial.invite/<tid>` into `at://<inviteeDid>/space/group.opensocial.invites/self`, Group Host directly observes `SpaceNotFound` / `AccountNotAuthorized` / network errors from the invitee's PDS, persists `pending` / `delivered` / `failed (lastError)` in `invite_delivery`, and exposes `/group-admin/invite-deliveries` + `/group-admin/retry-invite-delivery` so admins can retry once the invitee signs in and `WorkspaceClient.ensureInvitesSpace()` provisions `invites/self`. Exposing that same `notifyRepoUpdate` delivery outcome to personal-PDS writers would eliminate `new.flock.dm.declaration` for DMs as well.

## Internal references (remove before filing)
`apps/group-host/src/methods.ts` (`invite_delivery`), `packages/client/src/dm/dm-client.ts`, `packages/protocol/src/scopes.ts` (`DM_BROWSER_SCOPES`).
