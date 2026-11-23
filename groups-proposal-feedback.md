# `opensocial.group` Proposal Feedback

**From:** The Flock engineering team ([`atproto-sandbox/atprotocol-slack-clone`](https://github.com/atproto-sandbox/atprotocol-slack-clone))  
**Target Proposal Revision:** [`tangled.org/opensocial.group/proposal`](https://tangled.org/opensocial.group/proposal) @ `8df0cc82eb7708f090aa43522adf1d3ada3ed7e7`  
**Underlying ATProto Spaces Pin:** Proposal 0016 / [`bluesky-social/atproto#5187`](https://github.com/bluesky-social/atproto/pull/5187) @ `6747610566eee1b6d743617bd8eb1136adccb362` (`0.0.0-spaces-alpha-20261117141222`)

---

## 1. Implementation Context

To test `opensocial.group` under realistic product, security, multi-app, and migration requirements, we adopted the proposal end-to-end across **Flock**, an ATProto Spaces Slack-style collaboration app with channels, threads, reactions, bots/webhooks, a collaborative Tasks extension, and independent zero-lock-in readers:

- **Full reference Group Host (`apps/group-host`):** `1 Group == 1 did:plc:...` accounts publishing `#atproto`, `#atproto_kem`, `rotationKeys`, and `#atproto_pds`; signed `@atproto/repo` public repository (`declaration/self`); core `group.opensocial.{meta,members}/self` + modality spaces; flat union RBAC (`group.opensocial.policy`); two-sided ATProto OAuth 2.1 Authorization Server (`prompt=create`, `prompt=login` step-up, `recovery`, and sovereign PLC `rotationKeys` custody); cross-PDS `invites/self` delivery; all 9 `group.opensocial.*` XRPC methods; `<groupDid>`-authored `com.atproto.label.record` moderation; and full two-GroupHost Standard + Coordinated migration.
- **Browser & Node Clients (`@flock/client`, `apps/web`, `apps/operator`):** Both per-user Group-DID browser sessions (isolated alongside the user's personal PDS OAuth session in IndexedDB) and a shared-session modality Operator, plus 3 standalone readers (`@flock/reader`) built strictly on `@flock/protocol` and `@atproto/{space,star}`.
- **Verification:** `1,066` unit/integration/parity tests (including 16 real-`GroupHostServer` vs in-memory `FakeNetwork` parity suites), real multi-PDS + two-GroupHost protocol tests, `86/86` real-browser E2E scenarios, and 33 rounds of adversarial dual-model protocol/security review.

Everything below is grounded in concrete issues we hit while implementing the spec verbatim against real `@atproto/pds` and `@atproto/oauth-scopes`. We tried to keep every recommendation aligned with the proposal's own design posture (**minimal, 90% case, clean group/app boundary**).

---

## 2. What Worked Exceptionally Well

Before listing gaps, it is worth emphasizing how well the core model held up in practice:

1. **`1 Group == 1 DID` + `group.opensocial.policy` (`O(1)` membership):** Moving from per-space `com.atproto.memberspace` member lists to role-based `group.opensocial.policy` reduced adding or removing a member across 100 channels from `~102` sequential XRPC calls plus a background reconciliation cron job to **a single `putRecord(membership/<did>)` write**. That single design decision eliminated an entire class of partial-failure drift.
2. **Flat union RBAC + `assignable` anti-escalation (`proposal.md:40–48, 102`):** Having no deny rules, no role hierarchy, and pure set union made permission evaluation straightforward to audit identically across the Group Host, browser client, Operator, and independent readers.
3. **Two-sided OAuth with live role narrowing (`proposal.md:73–106`):** Authenticating users via their own personal PDS and narrowing group-DID sessions dynamically on every request cleanly supported *both* per-user moderation/admin clients and a shared-session Operator without shared passwords or custody workarounds.
4. **Personal-PDS `invites/self` (`proposal.md:151–159`) & in-space `com.atproto.label.record` (`proposal.md:143`):** Hosting `invites/self` on each user's PDS (`publicWrite`, private read) and placing moderation labels in the same space as their subject worked cleanly across independent apps with no centralized invite or moderation index.
5. **Implicit `<groupDid>` self-membership (`proposal.md:46`):** Keeping `<groupDid>` out of `membership/*` and `acceptance/self` avoided circular bootstrap problems and cleanly separated sovereign DID control from human membership.

---

## 3. High-Priority Spec Gaps & Security Sharp Edges

### 3.1 Real Personal PDS OAuth Blockers (`_lexicon.opensocial.group` & `authParticipate.json`)

We ran into two immediate interoperability failures when authenticating against a real pinned `@atproto/pds`:

1. **`OAuthProvider.authorize()` resolves every non-wildcard `space:<spaceType>` NSID via DNS:**  
   In `@atproto/pds`, `lexiconManager.getSpacesFromScope()` resolves both `include:` permission sets *and* every concrete `space:<spaceType>` NSID (`group.opensocial.meta`, `group.opensocial.members`, `group.opensocial.invites`) via `_lexicon.opensocial.group` DNS TXT → `com.atproto.lexicon.schema`. Expanding `include:group.opensocial.authParticipate` client-side does **not** bypass this check.  
   - **Recommendation:** Publish official `_lexicon.opensocial.group` DNS TXT + `com.atproto.lexicon.schema` records for all 27 lexicons before 1.0, and document this prerequisite in the spec's deployment notes.

2. **`group.opensocial.authParticipate` `"skey": "self"` breaks `com.atproto.space.listSpaces`:**  
   `authParticipate.json:20–27` declares:
   ```json
   {
     "type": "permission",
     "resource": "space",
     "spaceType": "group.opensocial.members",
     "authority": "*",
     "skey": "self",
     "collection": ["group.opensocial.acceptance"],
     "action": ["read", "create", "update", "delete"]
   }
   ```
   On `@atproto/pds`, `com.atproto.space.listSpaces({ spaceType: "group.opensocial.members" })` (which clients use to discover which groups a user has written `acceptance/self` records in) asserts `{ spaceType: "group.opensocial.members", authority: "*", skey: "*" }` with `{ action: "read_self" }`. Because `authParticipate` constrains `skey` to `"self"`, `@atproto/oauth-scopes` rejects `listSpaces` with `Missing required scope "space:group.opensocial.members?authority=*&action=read_self"`.  
   - **Recommendation:** Add an `skey`-unconstrained `{ "type": "permission", "resource": "space", "spaceType": "group.opensocial.members", "authority": "*", "action": ["read_self"] }` entry to `authParticipate.json` (or coordinate with core Spaces to allow an optional `skey` filter on `listSpaces`).

---

### 3.2 Two-GroupHost Migration: Capability Discovery, Endpoint Binding & Multi-Key Custody (`proposal.md:9, 161–165`)

Migration was by far the sharpest area of the spec during implementation and accounted for the majority of our adversarial security review findings. The proposal currently devotes only five lines to migration (`proposal.md:161–165`), leaving four critical interoperability and security gaps:

1. **No verifiable pre-cutover `group.opensocial.policy` capability advertisement:**  
   `proposal.md:9` and `proposal.md:163` state that a group *"can only migrate to a host that implements `group.opensocial.policy`."* However, `com.atproto.server.describeServer` looks identical on an ordinary ATProto PDS and an OpenSocial Group Host. Without a standard capability signal, a source Group Host signing a PLC cutover op can silently migrate—and effectively brick—a group onto a plain PDS that does not enforce `group.opensocial.policy`.  
   - **Recommendation:** Standardize a DID-bound host capability advertisement—at minimum a service entry `{ id: "#opensocial_group", type: "OpenSocialGroupHost", serviceEndpoint }` on the Group Host's `did:web` document (and optionally a signed metadata endpoint advertising supported policy NSIDs and import/blob size limits).

2. **Client & source target origin ↔ service DID binding before `getServiceAuth`:**  
   In Standard ATProto migration, a client fetching `GET <targetOrigin>/xrpc/com.atproto.server.describeServer` and passing the returned `did` into `com.atproto.server.getServiceAuth({ aud: did, lxm: "com.atproto.server.createAccount" })` is vulnerable to credential capture if `<targetOrigin>` is malicious and returns a legitimate Group Host's service DID: the source mints a group-signed `createAccount` JWT for the legitimate DID, and the client hands it directly to the malicious origin.  
   - **Recommendation:** Normatively require clients (and source hosts) to resolve `targetServiceDid`'s authoritative DID document and verify that its `#atproto_pds` endpoint matches the normalized `targetOrigin` **before** minting or transmitting any migration JWT or bearer token—and again verify that `getRecommendedDidCredentials`'s proposed `#atproto_pds` matches `targetOrigin` before `signPlcOperation`.

3. **Ambiguous multi-key `did:plc` `rotationKeys` provenance during `createAccount`:**  
   For groups with a single rotation key (`rotationKeys = [K_0]`), Standard `createAccount({ did, handle, recoveryKey? })` is unambiguous: `K_0` is the retiring source host's key unless the caller explicitly preserves it via `recoveryKey`. For groups with **2 or more `rotationKeys`** (e.g., `[sourceHostKey, externalSovereignKey]`), PLC's untagged `rotationKeys` array gives the target host no way to tell which key belongs to the retiring source host. A target host guessing wrong will either leave the old host with permanent PLC control (`SourceRotationKeyRetained`) or strip a sovereign custody key (`SovereignRotationKeyDropped`).  
   - **Recommendation:** Standardize a lightweight host-rotation-key provenance mechanism (e.g., an endpoint signed by `<groupDid>#atproto` declaring the source host's own `localRotationKey`, and/or an optional sovereign-key-signed provenance JWS header on `createAccount`).

4. **Pre-cutover staging integrity, concurrent writes, and zero-human post-cutover custody:**  
   - Without a source freeze or manifest check during `getRepo` → `importRepo`, concurrent writes (new channels, membership edits, invites) silently land on the source host after export and vanish at PLC cutover. Even if an opt-in coordinated migration profile stays an extension, the base spec should state **mandatory pre-cutover validation** before `submitPlcOperation` / `activateAccount` (staged `meta/self`, `members/self`, valid `group.opensocial.policy` & role references, all referenced blobs present, and non-empty `membership.roles`) so hosts do not commit a PLC cutover to a broken group repo.
   - For zero-human / externally governed groups (`proposal.md:46, 169`), once a migration commits to PLC (or if a staging bearer token is lost mid-cutover), there is no human member to authenticate via two-sided personal-PDS OAuth to call `activateAccount` or administer the group. Documenting a standard PLC `rotationKeys` controller-session bootstrap (or clarifying how externally governed groups authenticate after cutover) closes this custody gap.

---

### 3.3 `requestJoin`, Approval Races, `leaveGroup`, and Bilateral Membership/Acceptance Pairing

Implementing realistic mobile/browser retry and multi-device flows surfaced four race conditions in the join/leave lifecycle:

1. **Non-idempotent `requestJoin` on invite redemption (`requestJoin.json`):**  
   Redeeming a single-use `invite` record deletes or marks the invite consumed. If the client loses the HTTP response and retries `group.opensocial.requestJoin`, the server returns `400 InvalidInvite` even though the user was already admitted.  
   - **Recommendation:** Recommend optional `Idempotency-Key` support on `requestJoin` (scoped to `(group, callerDid, key)` + parameter hash, upgrading `'pending'` to `'admitted'` once `membership/<callerDid>` exists).

2. **No member-readable status query for pending join requests:**  
   When `requestJoin` returns `{ status: "pending" }` (`joinPolicy === "approval"`), the requester holds no Group-DID `authModerate` session and cannot call `listJoinRequests`. Clients have no way to distinguish *"still pending"*, *"approved"*, *"denied"*, or *"orphaned because the group migrated to a new Group Host where private `join_request` state did not migrate (`proposal.md:165`)."*  
   - **Recommendation:** Add a small personal-auth query (e.g., `group.opensocial.getJoinStatus`) that checks live `membership/<callerDid>` in `members/self` **first** (so approvals right before migration still resolve as `admitted` on the new host) before falling back to private queue state (`pending` / `denied` / `cancelled` / `unknown`).

3. **Cancel-vs-approve race on `join_request`:**  
   `proposal.md:226` specifies approving a join request by writing `membership/<member>` via `com.atproto.space.putRecord`. If a user calls `cancelJoinRequest` milliseconds before a moderator submits `putRecord(membership/<member>)`, the moderator silently admits a user who already withdrew their request.  
   - **Recommendation:** Either standardize an optional conditional header (e.g., `If-Join-Request-Present: true`) checked atomically with the `membership` write (`409 JoinRequestNotFound` if cancelled/denied), or add an explicit `group.opensocial.approveJoinRequest` procedure.

4. **Bilateral `acceptance` spoofing & stale offline `leaveGroup` replays (`acceptance.json`, `membership.json`, `leaveGroup.json`):**  
   - `acceptance.createdAt` (`acceptance.json:13`) is an unverified client-supplied timestamp with no upper bound. A user who writes `acceptance/self` with `createdAt: "2099-01-01T00:00:00Z"`, gets ejected (deleting `membership/<did>` while `acceptance/self` remains on their personal PDS), and is later re-admitted will appear as having freshly accepted if apps compare `acceptance.createdAt >= membership.createdAt`.
   - If Device A queues `leaveGroup` offline and replays it *after* Device B rejoined the group, an unconditional `leaveGroup` silently deletes the newer membership.
   - `leaveGroup.json:21–25` only declares `GroupNotFound` and does not address what happens when the sole/last admin calls `leaveGroup`.
   - **Recommendation:**
     - Add `"minLength": 1` to `membership.json:13` (`roles`) to match `proposal.md:40` (*"assigns one or more roles to each member"*).
     - Add an optional host-generated `incarnation` (opaque string/UUID minted when `membership/<did>` transitions absent → present, preserved across role edits) on `group.opensocial.membership`, echoed as `incarnation` on `group.opensocial.acceptance`, and accepted as an optional precondition (`If-Match-Membership-Incarnation` or input field) on `group.opensocial.leaveGroup` (returning `409 MembershipIncarnationMismatch` when stale).
     - Document `LastAdmin` (or `CannotLeave`) as a standard error on `leaveGroup` so clients can guide sole admins cleanly into transfer/deactivation/deletion flows.

---

### 3.4 Anti-Escalation Edge Cases & Destructive Step-Up Auth (`proposal.md:54–55, 73–106`)

The anti-escalation paragraph in `proposal.md:102` is one of the strongest parts of the spec. Implementing and fuzz-testing it surfaced four subtle edge cases worth codifying explicitly:

1. **Excluded-admin privilege escalation on private/unlisted spaces:**  
   Suppose Role A grants `space:*?manage=update` (so an admin can manage policies across spaces) *without* granting `read` or `write` on a particular existing private or `unlisted: true` space S. `proposal.md:102` states *"Any `read` or `write` access they grant on a space must already be theirs on that space,"* which catches direct role grants—but what about flipping `publicRead: true` or `unlisted: false` on space S? If an excluded admin can set `publicRead: true` or `unlisted: false`, they can expose or read a private space they were intentionally excluded from.  
   - **Recommendation:** Explicitly state that a user who lacks `read` on an existing space cannot set `publicRead: true`, cannot clear `unlisted: true`, and cannot enumerate an `unlisted` space in admin helpers.

2. **Confining `policy.grants[].scopes` to the space itself (`proposal.md:54–55`):**  
   `proposal.md:54` says *"Grants apply only to that space,"* while `proposal.md:55` notes `manage=create`, `rpc:`, and cross-space `space:*` live on `role` records. Because `policy.json` accepts arbitrary scope strings (including `include:` permission sets), a buggy host that expands `policy.grants[].scopes` without containment checks could let a space policy smuggle `manage=create`, `rpc:`, `account:`, `identity:`, or another space's `(spaceType, authority, skey)`!  
   - **Recommendation:** Normatively require Group Hosts to expand any `include:` permission sets inside `policy.grants[].scopes` and reject (at `createSpace`, `updateSpace`, and `importSpaceMeta`) any scope that is not a `space:` scope strictly matching that space's `(spaceType, authority, skey)` or that requests `manage=create`.

3. **Role deletion & wildcard scope containment:**  
   - Clarify whether deleting a `role/<rkey>` requires `<rkey>` to be in the caller's `assignable` union (we enforced this, plus rejecting deletion if any member still references `<rkey>` or if it would leave zero effective admins in a human-governed group).
   - Clarify that anti-escalation scope checks compare *structural* scope containment after expanding permission sets (not literal string equality), so a caller holding `space:*?collection=com.atproto.label.record` can grant `space:group.opensocial.meta?collection=com.atproto.label.record`, whereas a caller holding `action=create` cannot grant `action=delete`.

4. **Fresh `prompt=login` step-up for destructive Group-DID operations:**  
   Ordinary Group-DID OAuth sessions can live for weeks via refresh tokens. We found it essential to require a **fresh `prompt=login` step-up (`<= 5 min`)**—tracked separately from ordinary `authenticated_at` so `prompt=consent` and `prompt=create` cannot satisfy it—before permitting `signPlcOperation`, `requestAccountDelete` / `deleteAccount`, or migration preparation.  
   - **Recommendation:** Add a short security-considerations paragraph recommending fresh `prompt=login` step-up (and commit-point live-role revalidation) on destructive account/identity operations.

---

### 3.5 Moderation (`createReport`) & `com.atproto.label.record` Normative Rules (`proposal.md:135–149`)

1. **`createReport` subject validation for member-authored personal-PDS records:**  
   `proposal.md:19` establishes that member records live on members' personal PDSes, not on the Group Host. Yet `createReport.json:18–23` validates `subject` (`at-uri` or account DID) with `InvalidSubject: "The subject isn't in this group."` Implementers need explicit guidance on *how* a Group Host validates a space-record subject without doing unbounded remote PDS fetches:
   - If `subject` is a space record `at://<groupDid>/space/<type>/<skey>/<repoDid>/<collection>/<rkey>`: verify the caller currently has `read` access to that space (returning uniform `InvalidSubject` on missing or inaccessible private spaces to avoid a private-space existence oracle!), check local `space_record` + optional `cid` when `repoDid === groupDid`, and check the space's `space_writer` index (+ syntactically valid `cid` when supplied) when `repoDid !== groupDid`.
   - If `subject` is an account DID (`cid` forbidden): accept any DID with a `membership/<did>` record **or** `subject === groupDid` (`proposal.md:46`), placing its queue/label context in `members/self`.
   - Reject `iss === groupDid` on all four personal service-auth methods (`requestJoin`, `cancelJoinRequest`, `leaveGroup`, `createReport`).

2. **Label record invariants & `!takedown` projection semantics (`proposal.md:143`):**  
   - `group/opensocial/defs.json:129` (`labelEvent.val`) requires `minLength: 1`, whereas `com.atproto.label.defs` allows an empty string. Specifying `val.length >= 1` and `isValidTid(rkey)` at write/import time prevents moderation history serialization failures (`getModSubjectHistory`).
   - State explicitly that account labels (`uri` is a DID, `cid` absent) may **only** be written in `group.opensocial.members/self`, and record labels may **only** be written in the exact space matching the subject URI (rejecting cross-space labels at write and `space.importRepo` time).
   - Clarify `proposal.md:143`'s sentence *"a `!takedown` label removes content from the space"*: because member records live in personal PDS repos verified by `LtHash` commits, Group Hosts cannot delete records from a member's repo. Clarifying that `!takedown` / `!hide` are **read/projection rules** (resolved by latest `cts` / record deletion) while writer repos retain cryptographic integrity avoids confusion for both Group Host and reader implementers.

---

### 3.6 `meta/self` `publicRead` ↔ `declaration/self` Coupling & Non-Human App Principals

Two practical app-integration patterns came up immediately in Flock:

1. **Public `meta/self` vs `group.opensocial.declaration/self` atomicity (`proposal.md:131–133`):**  
   Making a group discoverable requires both `updateSpace(meta/self, { publicRead: true })` and `putRecord(group.opensocial.declaration/self)` in the public repo. On hosts that don't couple these, concurrent toggles across tabs/clients easily leave a public `declaration/self` pointing to a private `meta/self` space. Recommending (or allowing) Group Hosts to atomically synchronize `declaration/self` when `meta/self.publicRead` changes—or documenting that clients should check `meta/self` `publicRead` rather than trusting `declaration/self` alone—eliminates a real race condition.
2. **Non-human service principals (bots / integrations / webhooks):**  
   Many groups install automated apps (bots, webhooks, bridges) that need scoped `write` access to specific modality spaces without appearing as human members in rosters, holding `assignable` authority, or counting toward `LastAdmin` human-custody checks. Even if kept deliberately out of the minimal core lexicons, a brief note in `proposal.md` on recommended conventions (e.g., dedicated non-default role per app principal without `acceptance/self`, or keeping app principals distinct from human roster counts) would help ecosystem apps interoperate cleanly.

---

## 4. Concrete Fixes for Draft Proposal Artifacts (`8df0cc82`)

Every item below is a small, verified defect or contradiction in the current draft repository:

| File & Location | Current Issue | Suggested Fix |
|---|---|---|
| `scripts/validate-lexicons.mjs:251` | References removed `#atproto_space_host` service fragment (`aud: `${group}#atproto_space_host``) | Update to `${group}#atproto_pds` (or bare `${group}`) |
| `examples/records.json:88–94` | `group.opensocial.space` example indexes `group.opensocial.meta/self`, contradicting `proposal.md:36` (*"indexes the group's modality spaces"*) | Point the example at a modality space (e.g., `at://.../space/com.atmoboards.forum/self`) and explicitly state `meta/self` and `members/self` are excluded from the index |
| `lexicons/group/opensocial/membership.json:13` | `roles` array has `maxLength: 100` but omits `minLength: 1`, contradicting `proposal.md:40` (*"one or more roles"*) | Add `"minLength": 1` to `roles` |
| `lexicons/group/opensocial/authParticipate.json:20–27` | `"skey": "self"` blocks `com.atproto.space.listSpaces({ spaceType: "group.opensocial.members" })` on real `@atproto/pds` | Add an `skey`-unconstrained `action: ["read_self"]` permission entry for `group.opensocial.members` (or support `skey` on `listSpaces`) |
| `lexicons/group/opensocial/profile.json:38–41` | `url` uses `format: "uri"`, which allows `javascript:` / `data:` URIs in browsers | Restrict or normatively require `http:` / `https:` schemes |
| `lexicons/group/opensocial/leaveGroup.json:21–25` | Only declares `GroupNotFound`; omits last-admin / sole-member leave error and stale-leave precondition | Add `LastAdmin` (or `CannotLeave`) error and optional incarnation precondition |
| `lexicons/group/opensocial/defs.json:129` vs `com.atproto.label.record` | `labelEvent.val` requires `minLength: 1`, while `com.atproto.label.defs` allows `""` | Normatively require `val.length >= 1` and `tid` `rkey` on group label writes |
| DNS / Lexicon resolution | `_lexicon.opensocial.group` not yet published; blocks real personal PDS OAuth via `getSpacesFromScope()` | Publish official `_lexicon.opensocial.group` DNS TXT + `com.atproto.lexicon.schema` records for all 27 lexicons |

---

## 5. Priority Triage Summary

| Priority | Item | Why It Matters Before 1.0 |
|---|---|---|
| **P0 (Blocker)** | Publish `_lexicon.opensocial.group` + fix `authParticipate.json` `listSpaces` scope | Required for *any* app to complete OAuth sign-in and group discovery against a real ATProto PDS |
| **P0 (Security)** | Migration capability discovery (`#opensocial_group`), DID↔origin binding before `getServiceAuth`, and multi-key `rotationKeys` provenance | Prevents silently bricking groups onto plain PDSes, credential theft by malicious origins, and losing/retaining PLC custody keys |
| **P1 (Correctness)** | `membership` `minLength: 1`, `incarnation` / `generation` on `membership` & `acceptance`, conditional `leaveGroup`, and `requestJoin` idempotency + `getJoinStatus` + cancel/approve CAS | Eliminates mobile/multi-device retry bugs, `acceptance.createdAt` spoofing after ejection, and post-migration pending-request ambiguity |
| **P1 (Security)** | Codify excluded-admin `publicRead`/`unlisted` rule, `policy.grants[].scopes` containment, and `prompt=login` step-up on destructive ops | Prevents subtle privilege escalations across independent Group Host implementations |
| **P2 (Interoperability)** | Normative `createReport` (`space_writer` + uniform `InvalidSubject` + `subject === groupDid`) and `label.record` placement/`!takedown` projection rules | Ensures moderation works identically across Group Hosts, apps, bots, and independent readers |
| **P2 (Polish)** | Fix `validate-lexicons.mjs:251`, `examples/records.json:88–94`, `profile.url` scheme rule, and `meta/self` ↔ `declaration/self` guidance | Removes direct spec/example contradictions for new implementers |
