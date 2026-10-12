# Upstream protocol requests: summary

Eleven drafts for the atproto core team, written from what a Slack-style team app (workspaces, public and private channels, direct messages, up to 200 members per workspace and 100 per group DM) hit while building on proposal 0016 and PDS PR #5187 (commit `787a730f`). Each draft is a self-contained issue body in this folder. The index with the app machinery each one would remove is in [README.md](README.md).

**Nothing has been filed.** Filing needs an explicit go-ahead.

| # | Request | Priority |
|---|---|---|
| U1 | [Writer eviction](U1-writer-eviction.md): remove writers from a space's tracked writer set | High |
| U2 | [Client-direct change subscription](U2-client-direct-subscription.md): so no server relay learns who follows which spaces | High |
| U3 | [Member-readable roster](U3-member-readable-roster.md), opt-in | High |
| U4 | [Delegated space management](U4-delegated-management.md): so the app need not hold the workspace account's OAuth session | High |
| U10 | [Invitation discovery](U10-invitation-discovery.md): a way for an added member to learn the space exists | High |
| U5 | [Host-assigned per-record rev and range bound](U5-record-rev.md): ordering without trusting author-chosen keys | Medium |
| U6 | [Credential lifetime and revocation](U6-credential-revocation.md): we run a patch that makes credentials expire exactly at `exp` | Medium |
| U7 | [Batch membership calls](U7-batch-membership.md): hundreds of sequential calls per invite or group today | Medium |
| U8 | [Third-party validation and key filter](U8-validation-and-key-filter.md) | Medium |
| U11 | [Write-target existence](U11-write-target-existence.md): tell a writer whether the space they wrote into exists | Medium |
| U9 | [Optional hidden spaces](U9-hidden-spaces.md) | Low |

**Endorse only:** an account and identity events endpoint for space-only syncers, and dynamic scope resolution like permission sets. The proposal already lists both as future work; a +1 is enough.

## Which requests came from the executable-Gherkin exercise

- **U10, invitation discovery.** An invited member who accepted and signed in saw an empty dashboard: `listSpaces` returns only spaces the user has written to, so there is no way to ask which spaces you were added to. The app ships an invite link as the workaround.
- **U11, write-target existence.** The pinned PDS accepts a `putRecord` into a space that does not exist, on the same host and across hosts, so a DM sender cannot tell delivered from lost. The workaround, asking the inbox for a credential first, needs a wider browser grant (`space:org.slack.dm.inbox?authority=*&action=read`) and two extra calls per recipient.
- **U5, range bound (extended earlier).** An interim app-side ordering rule made reads worse and was backed out, so U5 now also asks for a bound that lets a client skip a hostile key range.

## Before filing

1. Strip the "Internal references" footer from each draft.
2. Re-run the pinned-PDS reproduction against the then-current revision; the protocol is still a draft.
3. Suggested venue: comments on PR #5187 and the proposal's discussion thread, one topic per issue. Suggested order: U1 to U4 and U10 first, since they remove the most application-side machinery.

Context: `.ai/reviews/2026-09-28-app-and-protocol-review.md` maps each request to the app finding it would resolve, and `.ai/reviews/2026-10-08-bdd-binding-review.md` records what running every scenario found.
