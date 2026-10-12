# Let a user discover the spaces they have been added to

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
- **Pending state**: a separate "invited, not yet accepted" state before the member can mint credentials. A bigger change to `simplespace` semantics, so listed as an open question and not required here.

## Compatibility
Additive. A host that does not implement `notifyMembership` simply produces no entries, and applications keep falling back to share links.

## Open questions
- Abuse: an authority can add arbitrary accounts, so the member's PDS needs per-sender rate limits, and probably a way for the user to dismiss or block an authority.
- Should membership be pending until the user accepts, as in most invitation systems, instead of granting read access immediately on `putMember`?
- Retention: entries should disappear on `removeMember` and `deleteSpace`.

## Internal references (remove before filing)
`src/app/ui/invite-banner.tsx` and `src/app/ui/client-api.ts` (`inviteLinkFor`), the BDD scenario "An invited member opens the link and sees the workspace" in `features/workspaces.feature`, and the investigation notes in `.ai/reviews/2026-10-07-invite-discovery.md`.
