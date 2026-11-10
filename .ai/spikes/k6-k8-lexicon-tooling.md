> Retained from R0 of `.ai/plans/platform-refactor.md` as the evidence for K6 and K8. The scripts were throwaway (they hard-coded local paths); the method, versions, commands and results are below, the per-rule disagreement table is `k8-disagreements-pinned.md`, and R2's schema-parity test is the executable successor of the K8 corpus.

# K6 and K8 lexicon-tooling spikes

Paths below use `<repo>` (the platform-refactor worktree), `<scratch>` (the spikes directory), and `<pin>` (the atproto checkout at the pinned commit `5d88b414`, used read-only). Nothing inside `<repo>` was created, modified or deleted by this work (verified: `src/protocol`, `lexicons/`, `scripts/codegen-lex.mjs` have no diff; other files in the worktree are being changed by another process, not by me). No packages installed, no lockfile change, no test suite run, no state-changing git command. Node 22.17.0 throughout.

Scripts: `<scratch>/k6/run.sh` and `<scratch>/k8/run.sh` and `<scratch>/k8/bundle/run.sh` replay everything. Exhaustive per-item output: `<scratch>/k8/disagreements-{release,alpha-npm,pinned-checkout}.tsv` (+ grouped `.md`), `<scratch>/k8/rows.json`.

---

## K6: does `@atproto/lex-cli` output for `new.flock.*` compile?

**Answer: yes. tsc passes, runtime import passes, no workaround needed.**

### What I ran
- `scripts/codegen-lex.mjs` runs the lex-cli at `$ATPROTO_PIN_CHECKOUT/packages/lex-cli/dist/index.js` (must be at commit `5d88b414a98de1ada22c94c78fa0667a7028163c`) as `gen-api --yes <outdir> <inputs...>`, then rewrites two lines of the generated `lexicons.ts` (the `satisfies Record<string, LexiconDoc>` type gate). `ATPROTO_PIN_CHECKOUT` is unset in this shell. I used the existing pinned checkout (`<pin>`, `git rev-parse HEAD` = `5d88b414...`, lex-cli package version 0.10.12) and a copy of the script's logic (`<scratch>/k6/gen.mjs`: same input list, same `PUBLISHED_RECORD_TYPES` filter, same type-gate patch).
- **Control:** the same pipeline over the current `org.slack` tree reproduces the checked-in `src/lexicons/api` byte for byte (`diff -r` empty), so the method is faithful.
- Scratch lexicon tree: `com/atproto/**` copied from `<repo>/lexicons`, plus `new/flock/operator/{execute,getOperation,listInboxWriters}.json`, `new/flock/channel/message.json`, `new/flock/workspace/profile.json` (key `literal:self`), `new/flock/dm/declaration.json` (key `literal:self`); `id` renamed by `sed` (`org.slack.` to `new.flock.`; file path matches the NSID).
  - **Variant A** = exactly the app's input set with the operator trio renamed (the app's real codegen never includes records).
  - **Variant B2** = A + three records + `com.atproto.repo.*` lexicons copied from `<pin>/lexicons` (the generated record clients need them).
- Type-check: `node_modules/.bin/tsc -p` (TypeScript 5.9.3) with a scratch tsconfig copying the repo's compiler options (strict, ES2022, bundler resolution, isolatedModules) plus a consumer file that calls the generated client and types. Runtime: `node --import tsx` (scratch `package.json` has `"type":"module"` like the repo; without it tsx loads the files as CJS and fails on `multiformats/cid`, which is unrelated and fails identically for the `org.slack` control).

### Results
| Check | Result |
|---|---|
| `tsc --noEmit` variant A (41 inputs) | exit 0, no errors |
| `tsc --noEmit` variant B2 (56 inputs, 3 records) | exit 0, no errors |
| `node --import tsx` import + call of `client.new.flock.operator.execute(...)` with a stub fetch handler | OK: `post /xrpc/new.flock.operator.execute`; response parsed |
| `lexicons.assertValidRecord("new.flock.channel.message", ...)`, `validateRecord`, `isRecord` | work |
| esbuild browser ESM bundle of the B2 output | builds clean |
| Normalized diff of A against the `org.slack` control | identical modulo the rename |

### Generated identifiers (variant A, `index.ts` / `lexicons.ts`)
```
index.ts:50  import * as NewFlockOperatorExecute from './types/new/flock/operator/execute.js'
index.ts:51  import * as NewFlockOperatorGetOperation from './types/new/flock/operator/getOperation.js'
index.ts:52  import * as NewFlockOperatorListInboxWriters from './types/new/flock/operator/listInboxWriters.js'
index.ts:92-94  export * as NewFlockOperatorExecute | NewFlockOperatorGetOperation | NewFlockOperatorListInboxWriters from './types/new/flock/operator/*.js'

index.ts:96  export class AtpBaseClient extends XrpcClient {
index.ts:97    com: ComNS
index.ts:98    new: NewNS                       // reserved word used as a class field name: legal
index.ts:102   this.com = new ComNS(this)
index.ts:103   this.new = new NewNS(this)       // property assignment: legal

export class NewNS          { _client; flock: NewFlockNS;            this.flock = new NewFlockNS(client) }
export class NewFlockNS     { _client; operator: NewFlockOperatorNS; this.operator = new NewFlockOperatorNS(client) }
export class NewFlockOperatorNS { execute(...), getOperation(...), listInboxWriters(...) }
      .call('new.flock.operator.execute', opts?.qp, data, opts)
      .call('new.flock.operator.getOperation', params, undefined, opts)
      .call('new.flock.operator.listInboxWriters', params, undefined, opts)

lexicons.ts:2209  NewFlockOperatorExecute: { id: 'new.flock.operator.execute', ... ref: 'lex:new.flock.operator.execute#operationRequest'
lexicons.ts:2548  NewFlockOperatorExecute: 'new.flock.operator.execute'       (in `ids`)
types/new/flock/operator/execute.ts   const id = 'new.flock.operator.execute'
```
Variant B2 additionally: `types/new/flock/channel/message.ts` (`$type: 'new.flock.channel.message'`, `Record`/`isRecord`/`validateRecord` aliases), `NewFlockChannelNS.message: NewFlockChannelMessageRecord`, `NewFlockDmNS.declaration`, `NewFlockWorkspaceNS.profile`, and `ids.NewFlockChannelMessage = 'new.flock.channel.message'`. At runtime `Object.keys(client.new.flock)` = `['_client','channel','dm','operator','workspace']`.

The only place the token `new` appears as a name is the `new: NewNS` field and the `this.new = ...` assignment. Property names and member access after `.` may be reserved words in ES2022 class fields and in TypeScript, so nothing breaks. `client.new.flock...` is the call path. (A `const { new } = client` destructure would not compile; the app has no such code.)

### Things that are not rename-related but you will hit
- Generating **record** types without the `com.atproto.repo.*` lexicons fails tsc with 15 errors (`Cannot find namespace 'ComAtprotoRepoListRecords'`, etc.), identically for `org.slack` and `new.flock` (control run: 15 vs 15). This is why the script comments that the app does not generate record types. Space-type lexicons (`type: "space"`) crash gen-api: `Error: genLexUserType() called with wrong definition type (space) in new.flock.workspace#main` (same for `org.slack.workspace#main`).
- The repo's installed `@atproto/lex-cli` 0.10.13 cannot process the app's lexicons: 35 `Invalid lexicon ...` messages (`received 'space-ref'`, `Invalid discriminator value`), and its output has no `types/new/flock/operator`. The pinned checkout's CLI is mandatory (as the script already requires).
- The app imports generated code only as type modules by path (`@/lexicons/api/types/org/slack/operator/{execute,getOperation,listInboxWriters}`, 4 import sites) and has **zero** references to `OrgSlack*` identifiers or `client.org.slack` outside `src/lexicons/api`. A rename changes only those import paths. NSID strings elsewhere (`src/auth/permission-sets.ts:114-115`, `src/app/xrpc/org.slack.operator.*/route.ts` directory names) are plain strings and URL path segments, not identifiers.
- Lexicon file layout: the repo's `channelMessage.json`, `channelReaction.json`, `channelRoster.json`, `acceptance.json` etc. do not sit at the path implied by their NSID (`org/slack/channel/message.json`); for `new.flock` the task asked for NSID-matching paths and gen-api accepts them.

---

## K8: `@atproto/lexicon` shape validation vs the hand validator

### Runtimes compared
1. **release** `@atproto/lexicon@0.7.14` (what the app has installed; uses `@atproto/syntax@0.7.6`).
2. **alpha-npm** `@atproto/lexicon@0.0.0-spaces-alpha-20261029171913`: exists on npm (`npm view` dist-tag `alpha` is a newer build, `...20261105160032`). I only downloaded the tarball into scratch (`npm pack`, no install), unpacked it, and symlinked its dependencies from the repo's pnpm store (alpha `@atproto/syntax`, which the repo already has; `@atproto/common-web` 0.5.12 because no alpha copy is installed).
3. **pinned-checkout** dist at `<pin>/packages/lexicon` (0.7.13 + space support).

alpha-npm and pinned-checkout agree on **every one of the 1,693 items (same verdict and same message)**, so the alpha snapshot is a faithful stand-in for the pin. The alpha runtime is the one that knows about space URIs; release does not (see 1 below). Detail uses alpha; release deltas are called out.

### Loading all `lexicons/**/*.json` into `new Lexicons()`
- 66 files. `Lexicons.add()` does not parse or validate documents (it only registers and rewrites refs), so **65 load** in all three runtimes; the 66th throws (duplicate, below).
- The `lexiconDoc` zod schema (what lex-cli applies) **rejects 41 of 66 files in release** (e.g. `defs/main/record/properties/workspace/format: Invalid enum value ... received 'space-ref'`; `org/slack/channel.json: defs/main: Invalid type: space must be one of: record, query, procedure, ...`; `defs/main/input/schema: Invalid input`), and **0 of 66 in alpha/pinned**. Affected `org.slack` files (9): `acceptance`, the 5 space types (`channel`, `inbox`, `workspace`, `dm/conversation`, `dm/inbox`), and `operator/{execute,getOperation,listInboxWriters}`; the other 32 rejects are `com.atproto.*`. Because `add()` does not parse, release still loads them.
- **Duplicate `org.slack.channel.roster`:** `lexicons/org/slack/channelRoster.json` and `lexicons/org/slack/channel/roster.json` are **byte-identical** (`cmp` clean, both SHA-256 `f6d98ad7...3bb3f3b`; record, key `any`, required `subject`/`active`/`updatedAt`). Loading both does not "pick one": the second `add()` throws `Error: lex:org.slack.channel.roster has already been registered`. The first registered wins; with a sorted walk that is `channel/roster.json`, and `channelRoster.json` is the one that throws. Neither path is referenced anywhere in the repo (only the plan doc mentions them); both came in the initial commit. One file must go; `channel/roster.json` is the one whose path matches its NSID.

### Corpus
1,693 items: 86 record literals taken from `src/protocol/records.test.ts` + `dm-declaration.test.ts` + the literals other tests pass (`bdd/steps/dm-policy.steps.ts:402`, `protocol-tests/app-acceptance.test.ts:238`) (for each, the hand validator's verdict equals what the test asserts: 86 of 86, which validates my contexts), 1,325 generated shape variants, 224 envelope items, 58 semantic scenarios. Shape variants per property: missing required, wrong type (null/number/boolean/array/object/string), datetime probes (46), DID probes (21), TID probes (15), skey probes (15), reference-URI probes (15 per reference field), space-ref probes (10), enum probes, array probes (16), boolean probes, unknown extra fields, and boundary strings (ASCII, 2-byte, 3-byte, 4-byte, combining mark, ZWJ family) at both the lexicon byte limit and the hand limit, +1, plus empty/whitespace oddities. Contexts are computed from each value so every semantic rule that can pass does pass, so remaining rejections on shape items come from shape rules or reference-target rules. Semantic scenarios deliberately sabotage the context (wrong author, space type, key, reference).

Classification: hand rejection of a valid reference string the lexicon accepts, or a sabotaged context = SEMANTIC; lexicon rejects = SHAPE (lexicon has no semantics); `$type`/non-object/prototype items = ENVELOPE.

| | release 0.7.14 | alpha / pinned |
|---|---|---|
| agree | 1,257 | 1,286 |
| hand rejects, lexicon accepts, SEMANTIC | 75 | 116 |
| hand rejects, lexicon accepts, SHAPE | 128 | 154 |
| lexicon rejects, hand accepts, SHAPE | 174 | 81 |
| ENVELOPE (hand-only / lexicon-only) | 22 / 37 | 28 / 28 |

### The two release-runtime blockers (alpha does not have them)
1. **`format: "at-uri"` rejects space record URIs.** `isAtUriString("at://did:plc:owner/space/org.slack.channel/general/did:plc:alice/org.slack.channel.message/2222222222222")` is `false` in `@atproto/syntax@0.7.6` (`true` in the alpha syntax). Result: `Record/parent must be a valid at-uri` for a canonical, hand-valid reply. The **valid baseline record is rejected** for `org.slack.channel.reaction` (subject), `org.slack.dm.reaction` (subject), `org.slack.joinDecision` (request), and any `channel.message` / `dm.message` carrying a `parent`. Of the 20 test literals the hand tests assert valid, **7 are rejected by the release lexicon** (`message: top-level parent`, `message: 10000 emoji`, `dm.message: other-half parent`, `dm.message: participants unknown`, `dm.reaction: valid`, `dm.reaction: 32-char emoji`, `dm.reaction: participants include owner`); under alpha only `message: 10000 emoji` is rejected (A1).
2. **`format: "space-ref"` is unchecked.** The format switch has no `space-ref` case, so it falls through to success: `org.slack.acceptance.workspace` accepts `"bogus"`, `""`, `"https://example.com"` (9 of 10 probes hand-rejected). Alpha validates it (`space ref missing skey`, `trailing slash`, a space record URI, plain at:// URI all rejected).

Moving to the alpha lexicon snapshot (the way `@atproto/space`/`crypto`/`lex-data` are already pinned) removes both; I did not test installing it in the repo.

### Disagreement table (alpha runtime; every distinct rule, counts are corpus items)
Lexicon error strings are verbatim (`Record/` prefix dropped). "Hand" is the `reason` returned.

**A. Lexicon rejects, hand accepts (lexicon stricter), all SHAPE unless noted**

| # | Collections / field | Case | Lexicon | Hand | n |
|---|---|---|---|---|---|
| A1 | `channel.message.text` | `"😀"×10000` (10,000 cp, 40,000 B), `"字"×3334`, `"é"×5001`, `"e\u0301"×3334`, ZWJ-family×401 | `text must not be longer than 10000 characters` (this counts **UTF-8 bytes**, the message says "characters") | accepts: limit is 10,000 code points | 10 + 1 test |
| A2 | `workspace.profile.name`, `directory.name` | `"é"×41` (82 B), `"字"×27` (81 B), `"😀"×21` (84 B), ZWJ-family×4 | `name must not be longer than 80 characters` | accepts: limit is 80 UTF-16 units (`value.length`) | 10 + 10 |
| A3 | `channel.reaction.emoji`, `dm.reaction.emoji` | `"é"×17` (34 B), `"字"×11`, `"😀"×9` (36 B), ZWJ-family×2 | `emoji must not be longer than 32 characters` | accepts: limit is 32 UTF-16 units | 9 + 9 |
| A4 | every collection with a datetime (13) | `...T12:00:00-00:00` | `createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601)` | accepts | 13 |
| A5 | `workspace.roster/admin/channel.roster.subject` | `did:web3:example` (digit in method), `did:plc:abc:` (trailing colon), `did:plc:abc%` | `subject must be a valid did` | accepts (regex allows `[a-z0-9]` method, trailing `:`/`%`) | 9 |
| A6 | `dm.request/dm.header.participants` | a participant `did:web3:x` | `participants/2 must be a valid did` | accepts | 2 |
| A7 | `dm.request/dm.header.convKey`, `joinRequest/joinDecision.requestId` | TID whose first char is k..z (`kkkkkkkkkkkkk`, `zzzzzzzzzzzzz`) | `convKey must be a valid TID` | accepts (any 13 chars of `[2-7a-z]`) | 8 |
| A8 | all 14 space collections | record has no `$type` (or `$type: undefined`) | `Record/$type must be a string` (`assertValidRecord` only; `lexicons.validate()` does not check `$type`) | accepts and strips | 28, ENVELOPE |

**B. Hand rejects, lexicon accepts (hand stricter)**

| # | Collections / field | Case | Lexicon | Hand reason | Class | n |
|---|---|---|---|---|---|---|
| B1 | all 14 + `dm.declaration` | unknown field `note` / `extra` (`hasOnly`) | accepts (unknown keys ignored, kept by `validate()`) | `<collection> has unknown fields` (e.g. `message has unknown fields`) | SHAPE | 29 |
| B2 | all datetime fields (13 + declaration) | leap second `:60`, no timezone `2026-09-24T12:00:00`, basic `20260924T120000Z`, offset without colon `+0100`, comma fraction `,123Z` (lexicon uses the lenient ISO-8601 path) | accepts | e.g. `invalid message timestamp`, `invalid DM declaration timestamp` | SHAPE | 66 |
| B3 | `*.roster/admin.subject` | `did:plc:`+513 chars, +2040 chars, 65-char method | accepts (DID up to 2048 chars) | `roster key must equal the subject hash` (id over the app's 512 cap) | SHAPE | 9 |
| B4 | `directory.visibility`, `joinDecision.decision` | `"bogus"`, `""`, `"PUBLIC"`, `"public "` (`knownValues` is open) | accepts | `invalid channel visibility` / `invalid join decision fields` | SHAPE | 8 |
| B5 | `directory.skey`, `joinRequest.channelSkey` | `"a b"`, `"a/b"`, `"."`, `".."`, `"日本語"`, newline, `#`, `@`, `"é"×64` (128 B) | accepts (only 1..128 bytes) | `directory key must equal skey` / `invalid join request fields` (regex `[A-Za-z0-9._~:-]{1,128}`, not `.`/`..`) | SHAPE | 18 |
| B6 | `dm.message.text` | `""`, `" "`, `"\n\t "`, NBSP, BOM (hand `trim()`), and `"e\u0301"×5001` (10,002 cp / 5,001 graphemes), ZWJ-family×1429..1600 (>10,000 cp, 25 B each) | accepts (no `minLength`; `maxLength` 40000 B + `maxGraphemes` 10000 counts graphemes) | `DM message text must contain 1 to 10000 Unicode code points` | SHAPE | 8 + 2 test |
| B7 | `dm.request/dm.header.participants` | unsorted pair; sorted with a duplicate; one 521-char DID | accepts (only 2..100 items + did format) | `DM request participants must be canonical` (sorted + unique is not expressible in lexicon JSON) | SHAPE | 6 |
| B8 | all 14 | `$type: "lex:<nsid>"` (lexicon normalizes `lex:`) | accepts | `record type does not match its collection` | ENVELOPE | 14 |
| B9 | all 14 | class instance with the record's fields (not reachable from JSON) | accepts | `record must be an object` | ENVELOPE | 14 |
| B10 | `channel.message.parent`, `channel.reaction.subject`, `dm.message.parent`, `dm.reaction.subject`, `joinDecision.request` | valid at-uri that is not a record in this space/collection: other space's record, same space wrong collection segment, plain `at://did/app.bsky.feed.post/..`, authority-only `at://did`, bare space ref | accepts (valid at-uri) | `parent must be a canonical message URI in this channel`, `reaction target is not a message in this channel`, `parent must be a canonical DM message URI`, `join decision key must match a canonical request in this inbox` | SEMANTIC (same-space reference) | 25 |
| B11 | `acceptance.workspace` | space ref of a channel space | accepts (valid space-ref) | `acceptance key must match its workspace` | SEMANTIC (referenced space type) | 1 (+1 scenario) |

Everything not listed agrees, including: missing required properties (40/40), wrong primitive types (205/205), booleans (12/12), non-object values (84/84), enum members, array `minLength` 2 / `maxLength` 100 (100 ok, 101 rejected by both), non-string array items, malformed DIDs/TIDs/URIs of the ordinary kind, 128-byte skeys, `$type` mismatches.

**Release-only extra rows** (not in the table above): all five reference-field families flip to "lexicon rejects, hand accepts" for canonical space URIs (blocker 1), and `acceptance.workspace` flips to "hand rejects, lexicon accepts" for 8 more probes (blocker 2). `lex-stricter` count is 174 under release vs 81 under alpha.

### Semantic-only rejections (hand rejects, lexicon cannot know; all stay in hand code)
Alpha: 116 items = 58 sabotaged-context scenarios (the lexicon accepts all 58, the hand validator rejects all 58) + 25 reference-string rows (B10) + 1 (B11) + 32 test literals. Under release the lexicon accepts only 37 of the 58 scenarios (it rejects the rest for the at-uri reason above).
- **author**: authority collections (`directory`, `workspace.profile`, `workspace.roster`, `admin`, `joinDecision`, `channel.roster`) must be written by the authority (`authority record has the wrong author`); `dm.header/message/reaction` by the half owner (`DM message must be authored by the half owner`).
- **space type**: collection must belong to the space type (`collection does not belong to this space type`; `DM request must be scoped to a DM inbox space`).
- **derived keys**: roster/admin subject hash (`roster key must equal the subject hash`), acceptance, join request, join decision, reactions (`reaction key is not canonical`), `directory key must equal skey`, profile/header `self`, `DM request key must equal its conversation key`, `DM header conversation key must equal the half key`, message keys must be TIDs.
- **same-space / same-conversation references**: `parent must be a canonical message URI in this channel`, `parent message is not in this channel`, `reaction target is not a message in this channel`, `parent must be a message in this conversation`, `parent must be a message from a conversation participant`, `parent must not be the message itself`.
- **nested reply**: `nested replies are not supported`.
- **participants**: `DM request participants must include the sender and the inbox owner`, `DM header participants must include the half owner`.

### Collections with a validator but no lexicon / a lexicon but no validator
- Validator without lexicon: **none** (14 `case`s in `validateSpaceRecord` + `validateDmDeclaration` for `org.slack.dm.declaration`; all 15 have a lexicon).
- Record lexicon without a validator: `com.atproto.space.policy` and `com.atproto.memberspace.member` (PDS-published records the app never reads; they are on the codegen skip list). All 15 `org.slack` record lexicons have a validator.
- Not records and not validated by `records.ts`: 5 space types (but `collectionSpaceType()` in `records.ts:290-297` equals the `collections` arrays of the five `space` lexicons exactly, 5 of 5, so that rule is derivable from the lexicon JSON), 3 operator procedures, 2 permission sets, and the 15 queries / 19 procedures under `com.atproto.*`.
- Record `key` in the lexicon vs the hand rule: `tid` (`channel.message`, `dm.message`, `dm.request`) and `literal:self` (`workspace.profile`, `dm.header`, `dm.declaration`) match hand rules; the other nine collections are `key: any` while the hand code enforces derived keys. `assertValidRecord` does not check keys at all.
- Dead code: `validateRoster` (`records.ts:138-140`, `private roster must be authored by the workspace authority`) is unreachable: all three collections routed there are in `AUTHORITY_COLLECTIONS`, which already rejects a non-authority author at `records.ts:49`.

### Can the lexicon be tightened to close gaps? (in-memory patch, alpha runtime, shape corpus only; `<scratch>/k8/experiment.ts`)
| Patch | Effect |
|---|---|
| `knownValues` to `enum` (`directory.visibility`, `joinDecision.decision`) | removes all 8 B4 rows |
| `"format": "record-key"` on `directory.skey`, `joinRequest.channelSkey` | removes all 18 B5 rows |
| `channel.message.text`: `maxLength` 40000 + `maxGraphemes` 10000 (as `dm.message`) | removes A1 and the failing existing test literal; adds 2 rows where the lexicon is more permissive (graphemes vs code points) |
| name/emoji: byte cap 240/96 + `maxGraphemes` 80/32 | removes A2/A3, but then the lexicon is looser than the hand rule in 20 cases (UTF-16 units vs graphemes) |
Cannot be closed by lexicon JSON: datetime leniency and `-00:00` (library behavior), DID/TID syntax differences (A5-A7, B3), unknown fields (B1), canonical participants (B7), reference-target rules (B10, B11), and everything in the semantic list.

### Other facts worth knowing
- `maxLength`/`minLength` count UTF-8 bytes, `maxGraphemes` counts grapheme clusters (via `unicode-segmenter` inside `@atproto/common-web`, not `Intl.Segmenter`). The hand validator counts code points for message text (`records.ts:170, 220`) and UTF-16 units (`value.length`, `boundedString`, `records.ts:264`) for names and emoji, so the suspected byte-vs-code-point issue is **confirmed**, and the UTF-16-unit counting is a second, different unit.
- `lexicons.validate(nsid, value)` does not require `$type` and returns `{success, value}` (extra keys preserved); `assertValidRecord` requires a string `$type` equal to the NSID and throws. An unknown NSID throws `LexiconDefNotFoundError: Lexicon not found: lex:org.slack.nope`.
- The hand datetime check is `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$` plus `Date.parse` finite; hour 24, Feb 30, Feb 29 in a non-leap year, year 0000 are accepted by **both**.

### Bundle cost (esbuild 0.28.2 from `node_modules/.pnpm`, `--bundle --minify --platform=browser --format=esm`)
| Entry | Raw bytes | Gzip bytes |
|---|---|---|
| `import { Lexicons } from '@atproto/lexicon'; console.log(Lexicons)` (0.7.14) | 107,425 | 30,459 |
| same, npm alpha snapshot | 109,910 | 30,934 |
| `src/protocol/records.ts` alone (includes `keys.ts` and `@noble/hashes`) | 17,080 | 5,656 |
| for scale only: whole `@atproto/lex-schema` namespace (behavior not evaluated) | 62,780 | 20,175 |

Composition of the 107 KB `@atproto/lexicon` bundle: zod 59.5 KB (55.8%, pulled in by the `lexiconDoc` schemas in `types.js`; esbuild keeps it, and the package's `package.json` has no `sideEffects` field), `@atproto/lexicon` 16.6 KB, multiformats 12.9 KB, unicode-segmenter 6.6 KB, `@atproto/syntax` 4.6 KB, lex-data 2.3 KB, iso-datestring-validator 1.9 KB, common-web 1.5 KB. `records.ts` bundle: records.ts 9.4 KB, `@noble/hashes` 4.5 KB, keys.ts 2.9 KB.

**Marginal cost in the app's browser code is much smaller than the standalone number**, because the DM client already ships `@atproto/lexicon` (via `jsonToLex` in `src/atproto/space-credential-core.ts:17`) including all of zod. Bundling `src/dm/dm-client.ts` (which imports `validateSpaceRecord`): 237,269 raw / 71,950 gzip, with zod 59.7 KB and `@atproto/lexicon` 7.3 KB already in it. Adding `new Lexicons([...20 org.slack lexicon docs...])` to that entry: 260,171 raw / 78,934 gzip, i.e. **+22,902 raw / +6,984 gzip**. The 20 docs are 5.1 KB minified JSON for the 15 record lexicons (812 B gzip) and 12.4 KB for all 25 `org.slack` lexicons. `src/app/ui/channel-view.tsx` and `workspace-home.tsx` do not import `@atproto/lexicon` at all (0 lexicon files in their bundles, ~6 KB each); `dm-context.tsx` bundles to 424,390 raw / 129,852 gzip and already contains it.

### Not determined / caveats
- Whether `pnpm`-installing the alpha lexicon snapshot into the repo works with the existing `pnpm-workspace.yaml` overrides: not tried (instructions forbade installs). The alpha result used a symlinked `@atproto/common-web` 0.5.12; the pinned-checkout dist uses the checkout's own copy and agrees on all 1,693 items.
- `@atproto/lex-schema` (already a dependency) was only bundle-measured, not evaluated as a validator.
- Operator procedure schemas (`operator.execute` etc.) were not part of this comparison; `validateSpaceRecord` does not cover them.
- Verdicts for JS-only inputs (class instances, `$type: undefined`) are included for completeness; JSON-decoded records cannot produce them.
