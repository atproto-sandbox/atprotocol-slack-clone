# Upstream requests for atproto permissioned data

Drafts for the atproto core team, written from what a Slack-style team app (channels, private channels, DMs, up to 200 members per workspace and 100 per group DM) hit while building on proposal 0016 and PDS PR #5187 (commit `787a730f`). Each file is a self-contained issue body.

**Nothing here has been posted.** Filing needs an explicit go-ahead. Suggested venue: comments on PR #5187 and the proposal's discussion thread, one topic per issue.

| # | Request | Priority | Removes from our app |
|---|---|---|---|
| U1 | [Writer eviction](U1-writer-eviction.md) | High | Scan bounds that only defend, an ever-growing writer set |
| U2 | [Client-direct change subscription](U2-client-direct-subscription.md) | High | A server relay that learns who follows which spaces |
| U3 | [Member-readable roster (opt-in)](U3-member-readable-roster.md) | High | Shadow roster records and a reconciliation operator |
| U4 | [Delegated space management](U4-delegated-management.md) | High | Custody of the workspace account's OAuth session |
| U5 | [Host-assigned per-record rev and range bound](U5-record-rev.md) | Medium | Trust in author-chosen keys for ordering; no way to skip a hostile key range |
| U6 | [Credential lifetime and revocation](U6-credential-revocation.md) | Medium | A patch that makes credentials expire exactly at `exp` |
| U7 | [Batch membership calls](U7-batch-membership.md) | Medium | Hundreds of sequential calls per invite or group |
| U8 | [Third-party validation and key filter](U8-validation-and-key-filter.md) | Medium | Colon-delimited hash keys, local-only validation |
| U9 | [Optional hidden spaces](U9-hidden-spaces.md) | Low | Random unguessable space keys as the only defense |
| U10 | [Invitation discovery](U10-invitation-discovery.md) | High | Invite links as the only way a member learns they were added |
| U11 | [Write-target existence](U11-write-target-existence.md) | Medium | A read-level grant and two extra calls per recipient just to learn whether a request can land |

**Endorse only.** The proposal already lists an account and identity events endpoint for space-only syncers as future work and describes dynamic scope resolution like permission sets. Both would help us; a +1 is enough.

Suggested order: U1 to U4 and U10 first, since they remove the most application-side machinery.

Before filing: strip the "Internal references" footer from each file, and re-run the pinned-PDS reproduction against the then-current revision, because the protocol is still a draft.

Context: `.ai/reviews/2026-09-28-app-and-protocol-review.md` maps each request to the app finding it would resolve.
