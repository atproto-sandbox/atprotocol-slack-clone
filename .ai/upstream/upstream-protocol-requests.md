# Upstream protocol requests: summary

Eleven drafts for the atproto core team, written from what a Slack-style team app (workspaces, public and private channels, direct messages, up to 200 members per workspace and 100 per group DM) hit while building on proposal 0016 and PDS PR #5187 (commit `787a730f`, re-checked against `5b95b2f2` on 2026-10-09, `619c6e85` on 2026-10-21 and `5d88b414` on 2026-10-30). Each draft is a self-contained issue body in this folder. The index with the app machinery each one would remove is in [README.md](README.md).

**Nothing has been filed.** Filing needs an explicit go-ahead.

| # | Request | Priority |
|---|---|---|
| U1 | [Writer eviction](U1-writer-eviction.md): remove writers from a space's tracked writer set (mostly resolved by `removeWriter`) | Medium |
| U2 | [Client-direct change subscription](U2-client-direct-subscription.md): so no server relay learns who follows which spaces | High |
| U3 | [Member-readable roster](U3-member-readable-roster.md), opt-in (`publishMembers` covers the read/write bits) | Medium |
| U4 | [Delegated space management](U4-delegated-management.md): so the app need not hold the workspace account's OAuth session | High |
| U10 | [Invitation discovery](U10-invitation-discovery.md): a way for an added member to learn the space exists | High |
| U5 | [Host-assigned per-record rev and range bound](U5-record-rev.md): ordering without trusting author-chosen keys (`spaceRev` is now host-assigned; per-record rev and range bound remain) | Medium |
| U6 | [Credential expiry at `exp`](U6-credential-revocation.md): we run a patch that makes credentials expire exactly at `exp`; lifetime and revocation are now upstream | Medium |
| U7 | [Batch membership calls](U7-batch-membership.md): hundreds of sequential calls per invite or group today | Medium |
| U8 | [Third-party validation and key filter](U8-validation-and-key-filter.md) | Medium |
| U11 | [Write-target existence](U11-write-target-existence.md): tell a writer whether the space they wrote into exists (now blocking) | High |
| U9 | [Optional hidden spaces](U9-hidden-spaces.md) (resolved for non-members) | Done |

**Endorse only:** an account and identity events endpoint for space-only syncers, and dynamic scope resolution like permission sets. The proposal already lists both as future work; a +1 is enough.

## Which requests came from the executable-Gherkin exercise

- **U10, invitation discovery.** An invited member who accepted and signed in saw an empty dashboard: `listSpaces` returns only spaces the user has written to, so there is no way to ask which spaces you were added to. The app ships an invite link as the workaround.
- **U11, write-target existence.** The pinned PDS accepts a `putRecord` into a space that does not exist, on the same host and across hosts, so a DM sender cannot tell delivered from lost. The workaround, asking the inbox for a credential first, needs a wider browser grant (`space:org.slack.dm.inbox?authority=*&action=read`) and two extra calls per recipient.
- **U5, range bound (extended earlier).** An interim app-side ordering rule made reads worse and was backed out, so U5 now also asks for a bound that lets a client skip a hostile key range.

## Status against `5b95b2f2`

Re-read on 2026-10-09 against the upstream lexicons and `packages/pds` handlers.

- **U6:** the default lifetime is now 600 s with a 3600 s ceiling, and `notifyCredentialRevoked` exists. Only exact-at-`exp` expiry remains.
- **U5:** `spaceRev` is host-assigned per space update; per-record rev and a range bound are still missing.
- **U1, U11:** still open. `removeMember` does not evict a writer; `putRecord` still returns success for a missing space.
- **U10:** unchanged (`listSpaces` has only a `spaceType` rename).
- **U2, U3, U4, U7, U8, U9:** not affected.

## Status against `619c6e85` and proposal `c76714ac`

Re-read on 2026-10-21. Since `5b95b2f2` PR #5187 (still a draft, 167 commits) gained four commits: `fb2cf002` adds `spacesAlpha: true` to `describeServer`, and `7bad5ee2` (merged as #5655) rejects a space write with `SpaceNotFound` when the writer is the space authority and the space is missing or deleted. The proposal gained "Repo lifecycle" (#121): a repo is created by the first write, an empty repo equals a missing one, and a user deletes a repo by deleting its records.

- **U11:** still open, but the unchecked write to another authority's space is now specified and tested behavior. The request is reframed as adding an optional signal, not fixing a missing check.
- **U1, U10:** unchanged (no member, writer or listing changes in the new commits).
- **U5, U6:** unchanged.
- **U2, U3, U4, U7, U8, U9:** not affected.
- **Our app:** no change was needed. Upstream's space and PDS suites (including our three conformance suites), our unit, acceptance and browser suites pass on `619c6e85`; the fake PDS used by unit tests now mirrors the new authority-write rule.

## Status against `5d88b414` (the October 29 alpha)

Re-read on 2026-10-30 against the upstream migration prompts for the October 22 and 29 releases and the merged lexicons and handlers.

- **U1:** `removeWriter` is new, and `removeMember` / `putMember write:false` evict. Left: `updateSpace` does not re-evaluate the writer set, and `publicWrite` re-tracks an evicted writer on its next write.
- **U3:** `publishMembers` publishes `{ read, write }` per member as records; roles are not covered.
- **U9:** closed for non-members (`SpaceNotFound` for unauthorized and missing alike; `SpaceDeleted` still distinguishable).
- **U11:** now blocking. The credential workaround stopped working because of U9, so the app relies on a public declaration record; a protocol signal is still wanted.
- **U6:** unchanged (credential expiry at `exp`); the exchange is no longer signed.
- **U5, U10, U2, U4, U7, U8:** unchanged. `listSpaces` now also lists spaces the caller is the authority of, which does not answer U10.
- **New upstream items we do not use:** MACs on credentialed reads (we adopted them), STAR repos, account migration, `clearRecords`, published policy and member records, `personalspace` and `managedspace` policies.
- **Possible new request:** commits carry no signature any more (a leaked response proves nothing to a third party). That is deliberate upstream; a third-party verifier cannot check a forwarded commit.

## Related work: opensocial.group

A peer proposal (`opensocial.group`, tangled.org/opensocial.group/proposal, draft from 2026-09-23) standardizes groups as a DID with `meta`, `members` and per-user `invites` spaces, flat role-based access, two-sided membership (`membership` plus member `acceptance`), a group service that is an OAuth server for the group DID, and moderation. It is not layered on simplespace and needs its own host, so this app does not implement it. It touches four drafts: U10 (its `invites` space is the application-level answer to invitation discovery), U4 (role-scoped group-DID grants are delegated management at the host level), U11 and U1 (same silent-delivery and eviction gaps). Each draft has a "Related work" section. Our private-roster-after-consent behavior already matches its `acceptance` model.

## Before filing

1. Strip the "Internal references" footer from each draft.
2. Re-run the pinned-PDS reproduction against the then-current revision; the protocol is still a draft.
3. Suggested venue: comments on PR #5187 and the proposal's discussion thread, one topic per issue. Suggested order: U1 to U4 and U10 first, since they remove the most application-side machinery.

Context: `.ai/reviews/2026-09-28-app-and-protocol-review.md` maps each request to the app finding it would resolve, and `.ai/reviews/2026-10-08-bdd-binding-review.md` records what running every scenario found.
