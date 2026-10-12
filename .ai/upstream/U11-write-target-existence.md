# Tell a writer whether the space they wrote into exists

## Summary
`com.atproto.space.putRecord` into a space hosted on another account succeeds whether or not that space exists: the record is stored in the writer's own repo and the authority host's `SpaceNotFound` is never reported back. A sender cannot tell "delivered" from "wrote into nothing", and the only workaround needs a read-level grant the sender should not need.

## Problem
Reproduced in a team-chat app built on `787a730f` (direct-message requests are written into the recipient's inbox space):
1. `did:plc:alice` has never enabled direct messages, so `at://did:plc:alice/space/org.slack.dm.inbox/self` does not exist.
2. `did:plc:bob` calls `putRecord` for a request into that inbox, on the same host and across hosts. Both return HTTP 200 with a record URI and `validationStatus: unknown`.
3. Bob's app reports the request as delivered. It never will be: nothing tracks Bob as a writer of a space that does not exist.

The workaround is to mint a space credential for the inbox first and read the error (`SpaceNotFound` means no inbox, `UserNotAuthorized` means it exists). That requires the OAuth grant `space:<type>?authority=*&action=read`, i.e. permission to ask any account of that type for read credentials, purely to find out whether a write will land. It is also two extra round trips per recipient (a 100-person group conversation makes 99 of them).

## Proposed change
Either of these, whichever fits the host's trust model better:
- **Report it on the write.** When the repo host can resolve the space host, `putRecord` returns `spaceStatus: "confirmed" | "unknown"`, and `unknown` is documented as "the write is stored locally and may never be tracked". A host that cannot check says so instead of implying success.
- **A write-scoped existence check.** `com.atproto.space.getSpaceStatus` (params `{ space }`) answers `{ exists, deleted }` for any caller holding a *write* grant on that space type. The answer discloses nothing a successful write would not.

## Alternatives considered
- Keep the credential probe (what we ship). Works, but widens the browser grant to read-credential requests against every inbox and costs two calls per recipient.
- Treat all requests as best-effort and never show delivery state. Loses the one signal a sender has that the recipient is unreachable.

## Compatibility
Additive: a new optional response field or a new method.

## Open questions
- Does confirming existence let a stranger enumerate which accounts enabled a feature? The credential probe already allows that today, so this does not make it worse, and the write path discloses it anyway once the recipient tracks the writer.

## Internal references (remove before filing)
`src/dm/dm-client.ts` (`sendRequest`), the scope comment in `src/auth/permission-sets.ts` (`DM_BROWSER_SCOPES`), and the BDD scenario "Enable DMs" in `features/direct-messages.feature`.
