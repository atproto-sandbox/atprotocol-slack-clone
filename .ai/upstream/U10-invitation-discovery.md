# Let a user discover the spaces they have been added to

Status against `6747610566` + `opensocial.group` `8df0cc82` (R13, 2026-11-21): **Solved at the cross-app standard layer by `opensocial.group` (`group.opensocial.invites/self`).** In R13, Flock adopted `opensocial.group` end-to-end: `WorkspaceClient.ensureInvitesSpace()` idempotently provisions `at://<viewerDid>/space/group.opensocial.invites/self` (`com.atproto.memberspace.policy` `{ publicRead: false, publicWrite: true }`, zero members) on sign-in, registers real-time `inv1` push wakes (`new.flock.operator.getSpaceNotifyTarget`), and discovers `<groupDid>`-authored `group.opensocial.invite/<tid>` records across any OpenSocial-compatible client (with `apps/group-host` tracking `notifyRepoUpdate` delivery in `invite_delivery` and supporting admin retry). Shareable invite links remain available for brand-new accounts that have not yet provisioned `invites/self`; a core PDS-level `listJoinedSpaces` would still remove that first-time bootstrap step.

Status against `5d88b414` (2026-10-30): Unchanged. `listSpaces` still lists only the caller's own spaces (a `read_self` grant covers it) and there is still no membership lookup.

Status against `5b95b2f2`: Unchanged. `listSpaces` still returns only spaces the user holds a repo in (the `type` filter is now `spaceType`); there is still no membership lookup.

## Summary
A member's PDS tracks only the spaces its user has *written to*, and the authority's member list is host-internal and readable only by the owner. So an account that has been added to a space has no protocol-level way to learn the space exists. Applications must deliver the space URI out of band.

## Problem
Reproduced in a team-chat app built on `787a730f`:
1. An admin adds `did:plc:alice` to a workspace space (`putMember`, read and write). The PDS member list now contains her.
2. Alice signs in to the app, which holds a valid OAuth session for her. Nothing lists the workspace: `com.atproto.space.listSpaces` on her PDS returns `[]`, because the lexicon defines it as "spaces the user has written to ... not 'spaces I'm a member of'". She has no URI to ask for a credential with.
3. Adding her therefore does nothing visible for her until someone hands her the `at://` URI. A user who was invited, signed in, and saw an empty dashboard reported it as "I don't see the workspace I was invited to."

Every application ends up inventing its own delivery channel for this: share links, e-mail, or an app-defined "invitation inbox" space owned by the invitee (which only works once the invitee has already created one, so it cannot reach a brand-new user).

## Proposed change
A member-side notification and listing, both best-effort and additive:

```
com.atproto.space.notifyMembership    (authority host -> member's PDS, service auth)
  input: { space, member, read, write, removed? }
  effect: the member's PDS records (or removes) one entry for that account.

com.atproto.space.listMemberships     (member's PDS, OAuth)
  params: { type?, limit, cursor }
  output: { memberships: [{ space, read, write, addedAt }] }
  auth:   a `space:<type>?...&action=read_self` grant for the listed type
```

- `putMember` and `removeMember` (and `deleteSpace`) cause the authority host to notify the member's PDS, the same best-effort path as `notifyWrite`. A dropped notification is recoverable because the owner can re-put the member.
- An entry carries only the space URI, the access bits and a timestamp. The PDS operator already sees that an account fetches delegation tokens for a given space, so this adds no new metadata class.
- An application can then show "you were added to X" the moment the user signs in, with no out-of-band link.

## Alternatives considered
- **Application-level invitation records** in an invitee-owned space. Works only for accounts that already enabled it, and every app reinvents it.
- **Share links** (what we ship). Fine as a convenience, but it means being added is invisible without the link.
- **Pending state**: a separate "invited, not yet accepted" state before the member can mint credentials. A bigger change to member-space (`memberspace`) semantics, so listed as an open question and not required here.

## Compatibility
Additive. A host that does not implement `notifyMembership` simply produces no entries, and applications keep falling back to share links.

## Open questions
- Abuse: an authority can add arbitrary accounts, so the member's PDS needs per-sender rate limits, and probably a way for the user to dismiss or block an authority.
- Should membership be pending until the user accepts, as in most invitation systems, instead of granting read access immediately on `putMember`?
- Retention: entries should disappear on `removeMember` and `deleteSpace`.

## Related work: opensocial.group
Adopted in Flock R13 (`apps/group-host`, `packages/client/src/workspace-client.ts`, `apps/operator/src/operator/space-notification.ts`): Flock implements `opensocial.group`'s `at://<inviteeDid>/space/group.opensocial.invites/self` inbox (`ensureInvitesSpace`), `<groupDid>`-authored `group.opensocial.invite/<tid>` writes with tracked `invite_delivery` (`pending` / `delivered` / `failed` + `retry-invite-delivery`), `getSpaceNotifyTarget` `inv1` push wakes, tombstone-aware invite pruning, and `group.opensocial.requestJoin` redemption. Only accounts that have never signed into any OpenSocial app (and thus have not yet provisioned `invites/self`) still rely on an out-of-band link or post-onboarding retry.

## Internal references (remove before filing)
`packages/client/src/workspace-client.ts` (`ensureInvitesSpace`), `apps/group-host/src/methods.ts` (`invite_delivery`), `apps/web/src/app/ui/invite-banner.tsx`.
