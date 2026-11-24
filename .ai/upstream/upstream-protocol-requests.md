# Upstream protocol requests: summary

Twelve drafts for the atproto core team, written from what Flock (workspaces, public and private channels, Tasks, and sovereign Direct Messages—up to 200 members per workspace and 100 participants per group DM) hit while building on proposal 0016 and PDS PR #5187 (`787a730f` → `5b95b2f2` → `619c6e85` → `5d88b414` → `6747610566`) and updated in **R13 (2026-11-21)** after adopting **`opensocial.group` atmospheric groups** (`8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`). Each draft is a self-contained issue body in this folder; the index is in [README.md](README.md), and full Spaces + `opensocial.group` synthesis lives in [`protocol-authors-feedback.md`](../../protocol-authors-feedback.md).

**Nothing has been filed.** Filing needs an explicit go-ahead.

| # | Request | R13 Status (`6747610566` + `opensocial.group` `8df0cc82`) | Priority for core Spaces |
|---|---|---|---|
| U1 | [Writer eviction](U1-writer-eviction.md) | Solved on `apps/group-host` (any lost `write` grant evicts); upstream `removeWriter` shipped; narrow `updateSpace` / `publicWrite` residual on `memberspace` DMs | Low / Medium |
| U2 | [Client-direct change subscription](U2-client-direct-subscription.md) | Orthogonal / open (`authorizeSpaceSync.notify` still requires an HTTPS webhook relay) | High |
| U3 | [Member-readable roster](U3-member-readable-roster.md) | Solved for groups by `opensocial.group` (`members/self` `role/*` + `membership/*` + `acceptance/self`) | Low (plain `memberspace` only) |
| U4 | [Delegated space management](U4-delegated-management.md) | Solved for groups by `opensocial.group` (two-sided Group-DID OAuth + live `effectiveMemberPermissions` narrowing) | Medium (plain `memberspace` only) |
| U5 | [Host-assigned per-record rev and range bound](U5-record-rev.md) | Orthogonal / open (`spaceRev` exists; per-record `rev` and `listRecords` range bounds remain) | Medium |
| U6 | [Credential expiry at `exp`](U6-credential-revocation.md) | Narrowly open (`notifyCredentialsRevoked` is upstream; `5s` post-`exp` skew on `credential` still requires `strict-credential-expiry.patch`) | Medium |
| U7 | [Batch membership calls](U7-batch-membership.md) | **Resolved** (upstream `6747610566` shipped batched `putMembers`/`removeMembers` `<= 100`; `opensocial.group` makes 100-channel membership `O(1)`) | Done |
| U8 | [Third-party validation and key filter](U8-validation-and-key-filter.md) | Solved on `apps/group-host` for governance/label schemas; open on personal PDSes (`validationStatus: unknown` + `rkey` slur filter) | Medium |
| U9 | [Optional hidden spaces](U9-hidden-spaces.md) | **Done** (`SpaceNotFound` for unauthorized non-members + `opensocial.group` `publicMeta: false` & `unlisted: true`) | Done |
| U10 | [Invitation discovery](U10-invitation-discovery.md) | Solved at the cross-app standard layer by `opensocial.group` (`group.opensocial.invites/self` + `ensureInvitesSpace` + `inv1` wakes) | Low / Medium (pre-onboarding PDS discovery only) |
| U11 | [Write-target existence](U11-write-target-existence.md) | Orthogonal / open on core Spaces (`apps/group-host` tracks async `notifyRepoUpdate` delivery for `invites/self`; DMs still need `dm.declaration`) | High |
| U12 | [Oplog reset signal](U12-oplog-reset-signal.md) | Orthogonal / open (`clearRecords` / `importRepo` wipe oplogs without `SinceUnavailable` or `#repoReset`) | Medium |

## Status against `6747610566` (R12) and `opensocial.group` `8df0cc82` (R13 — 2026-11-21)

- **Upstream `6747610566` (R12):** Replaced standalone `getSpaceCredential`/`registerNotify` with `authorizeSpaceSync` (`{ credential, spaceRev }`, inline `notify`), renamed `listRepos` to `listWriters` (`#repoWrite` / `#repoRemoved`), shipped batched `com.atproto.memberspace.{putMembers,removeMembers}` (`<= 100`, resolving **U7** for personal-PDS DMs), extracted `@atproto/star`, and signed/MAC'd every `listRepoOps` page.
- **R13 `opensocial.group` adoption (`apps/group-host`):** Flock adopted `opensocial.group` atmospheric groups (`1 Group == 1 DID`), retiring bespoke `com.atproto.memberspace` workspace governance, shadow roster/admin/acceptance lexicons, and `reconcile-workspaces` while keeping personal-PDS sovereign Direct Messages (`new.flock.dm.*`) on `com.atproto.memberspace.policy`:
  - **Resolved by `opensocial.group` in Flock:** **U3** (member-readable `role/*`, `membership/*`, and bilateral `acceptance/self` in `group.opensocial.members/self`), **U4** (two-sided Group-DID OAuth 2.1 AS authenticating personal PDS accounts and narrowing tokens live via `effectiveMemberPermissions` and `assignable`), **U7** (`O(1)` single-record `membership/<did>` writes across 100 channels), and **U10** (standardized `at://<userDid>/space/group.opensocial.invites/self` cross-PDS inbox with tracked `invite_delivery` + `getSpaceNotifyTarget` `inv1` wakes), plus Group-Host-side **U1** (atomic writer eviction on any lost `write` grant), **U8** (unconditional runtime Lexicon validation of governance/moderation records without slur-filtering hash keys), and **U9** (`publicMeta: false` + `policy.unlisted: true`).
  - **Remaining orthogonal core ATProto Spaces requests:** **U2** (`subscribeSpace` browser-direct streaming), **U5** (host-assigned per-record `rev` and `listRecords` range bounds), **U6** (`expirationSkew = 0` on `credential` `exp`), **U8** (dynamic third-party validation & machine-key filter exemption on personal PDSes), **U11** (write-target existence signal on cross-host `putRecord`, especially for DMs and unprovisioned `invites/self` spaces), and **U12** (`listRepoOps` reset signal after `clearRecords` / `importRepo`).

## Adopted in R13: `opensocial.group`

Flock implements `opensocial.group/proposal` (`8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`) end-to-end across `apps/group-host` (`42` SQLite tables), `packages/protocol` (`27` vendored `group.opensocial.*` lexicons), `packages/client` (`WorkspaceClient` + `GroupClient`), `packages/reader` (`independent.ts`), `apps/operator`, and `apps/web` (`GroupBrowserOAuthClient`). Concrete feedback and spec recommendations surfaced during R13 implementation—including `requestJoin` idempotency & `If-Join-Request-Present`, `membership`/`acceptance` incarnation counters, multi-key host migration provenance & Coordinated v1 cutover, `createReport` `space_writer` & `<groupDid>` subject rules, `com.atproto.label.record` same-space invariants, and `_lexicon.opensocial.group` DNS publication—are documented in [`protocol-authors-feedback.md`](../../protocol-authors-feedback.md).

## Historical status checkpoints (`5b95b2f2`, `619c6e85`, `5d88b414`)

- **`5b95b2f2` (2026-10-09):** `600 s` default / `3600 s` max credential TTL and `notifyCredentialRevoked` landed (narrowing U6 to zero-skew `exp`); `spaceRev` landed (narrowing U5).
- **`619c6e85` (2026-10-21):** Authority writes to own missing/deleted space return `SpaceNotFound`; cross-authority `putRecord` stays deliberately unchecked (reframing U11 as an optional signal).
- **`5d88b414` (2026-10-30):** `removeWriter` and `removeMember` eviction landed (narrowing U1); `SpaceNotFound` for unauthorized callers closed U9 and made `new.flock.dm.declaration` necessary for U11.

## Before filing

1. Strip the "Internal references" footer from each draft.
2. Re-run the pinned reproduction against the latest PR #5187 or `opensocial.group/proposal` commit.
3. Suggested order for core Spaces: **U2**, **U11**, **U6**, **U12**, **U5**, and **U8**.
