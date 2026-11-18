# R11 Wave 0 Channel Baseline (`84cfff4`)

- **Date:** 2026-11-16 (UTC `2026-11-17T06:55:00Z`)
- **Branch / Commit Tested:** `feat/r11-tasks` @ `1602adfac6b8ca1c38186c46a23552162a5ed942` (identical code/test/config tree to `feat/r10-interactions` @ `84cfff4e5258e9a59b5ac8a0fe9a0eddf2643223`; `git diff 84cfff4..1602adf` adds only `.ai/plans/r11-tasks-progress.md` and `.ai/reviews/{codex,opus}-r11-plan-round-*.md`)
- **Pinned Protocol Checkout:** `../atproto-spaces-phase3` @ `5d88b414a98de1ada22c94c78fa0667a7028163c` (`strict-credential-expiry.patch` overlay on `packages/space/src/credential.ts` and `packages/space/tests/credential.test.ts`)
- **Purpose:** Authoritative same-host channel regression baseline required by `.ai/plans/r11-tasks-progress.md` (`D11.13 #6`).

---

## 1. Environment & Sequential Gate Run Summary

- **Host:** `macOS 27.2` (`26B123`), `Apple M3 Max`, `16` logical CPUs, `128 GiB` RAM (`137438953472` bytes)
- **Runtime:** Node `v22.17.0`, pnpm `11.11.0`
- **Execution Mode:** Sequential (one command at a time, never concurrently)

| Step | Command | Result | Details |
| :--- | :--- | :--- | :--- |
| 1 | `pnpm install --frozen-lockfile` | PASS (`0`) | 11 workspace projects, 603 packages, `4.1s` |
| 2 | `pnpm typecheck` | PASS (`0`) | Root + `@flock/protocol` + `@flock/client`; zero `@types/node` leaks |
| 3 | `pnpm lint` | PASS (`0`) | `eslint .` |
| 4 | `pnpm test` | PASS (`0`) | `762` tests, `762` passed, `0` failed, `0` skipped (`32174.8 ms`) |
| 5 | `ATPROTO_PINNED_CHECKOUT=../atproto-spaces-phase3 pnpm test:sync-budget` | PASS (`0`) | 10 runs per writer count (`20 / 100 / 200`); gate `reopen` calls = `1` |
| 6 | `ATPROTO_PINNED_CHECKOUT=../atproto-spaces-phase3 node --import tsx --test protocol-tests/performance-envelope.test.ts` | PASS (`0`) | `1` test passed (`1584004.5 ms` total; `1583832.6 ms` test duration) |

---

## 2. Sync Budget Baseline (`protocol-tests/sync-budget.ts`)

Measured with `SyncCore` reading the latest `100` `new.flock.channel.message` records alongside `new.flock.channel.reaction` across `10` runs per writer count (`5` messages per writer), enforcing a `6`-connection-per-origin semaphore against two in-memory pinned PDS instances and one PLC directory.

### 2.1 Structured Summary Table

| Writers | Phase | Total HTTP Calls | Median (ms) | p95 (ms) | Method Breakdown |
| ---: | :--- | ---: | ---: | ---: | :--- |
| 20 | `first open` | `105` | `718` | `771` | `getDelegationToken: 1`, `getSpaceCredential: 1`, `listRepos: 2`, `plc resolve: 21`, `getLatestCommit: 40`, `listRecords: 40` |
| 20 | `reopen` | `1` | `6` | `7` | `listRepos: 1` |
| 20 | `one new message` | `5` | `38` | `68` | `listRepos: 1`, `getLatestCommit: 2`, `listRecords: 2` |
| 100 | `first open` | `505` | `3432` | `3567` | `getDelegationToken: 1`, `getSpaceCredential: 1`, `listRepos: 2`, `plc resolve: 101`, `getLatestCommit: 200`, `listRecords: 200` |
| 100 | `reopen` | `1` | `8` | `10` | `listRepos: 1` |
| 100 | `one new message` | `5` | `39` | `44` | `listRepos: 1`, `getLatestCommit: 2`, `listRecords: 2` |
| 200 | `first open` | `1005` | `6908` | `7688` | `getDelegationToken: 1`, `getSpaceCredential: 1`, `listRepos: 2`, `plc resolve: 201`, `getLatestCommit: 400`, `listRecords: 400` |
| 200 | `reopen` | `1` | `11` | `26` | `listRepos: 1` |
| 200 | `one new message` | `5` | `42` | `45` | `listRepos: 1`, `getLatestCommit: 2`, `listRecords: 2` |

### 2.2 Write-Notice Authority Propagation Latency (25 ms polling, uncounted)

| Writers | Median (ms) | p95 (ms) |
| ---: | ---: | ---: |
| 20 | `24` | `47` |
| 100 | `25` | `29` |
| 200 | `25` | `32` |

### 2.3 Verbatim `pnpm test:sync-budget` Output

```text
$ node --import tsx protocol-tests/sync-budget.ts
20 writers, write notice reaches the authority (25 ms polling): median 24 ms, p95 47 ms
20 writers, first open: median 718 ms, p95 771 ms, 105 calls {"com.atproto.space.getDelegationToken":1,"com.atproto.space.getLatestCommit":40,"com.atproto.space.getSpaceCredential":1,"com.atproto.space.listRecords":40,"com.atproto.space.listRepos":2,"plc resolve":21}
20 writers, reopen: median 6 ms, p95 7 ms, 1 calls {"com.atproto.space.listRepos":1}
20 writers, one new message: median 38 ms, p95 68 ms, 5 calls {"com.atproto.space.getLatestCommit":2,"com.atproto.space.listRecords":2,"com.atproto.space.listRepos":1}
100 writers, write notice reaches the authority (25 ms polling): median 25 ms, p95 29 ms
100 writers, first open: median 3432 ms, p95 3567 ms, 505 calls {"com.atproto.space.getDelegationToken":1,"com.atproto.space.getLatestCommit":200,"com.atproto.space.getSpaceCredential":1,"com.atproto.space.listRecords":200,"com.atproto.space.listRepos":2,"plc resolve":101}
100 writers, reopen: median 8 ms, p95 10 ms, 1 calls {"com.atproto.space.listRepos":1}
100 writers, one new message: median 39 ms, p95 44 ms, 5 calls {"com.atproto.space.getLatestCommit":2,"com.atproto.space.listRecords":2,"com.atproto.space.listRepos":1}
200 writers, write notice reaches the authority (25 ms polling): median 25 ms, p95 32 ms
200 writers, first open: median 6908 ms, p95 7688 ms, 1005 calls {"com.atproto.space.getDelegationToken":1,"com.atproto.space.getLatestCommit":400,"com.atproto.space.getSpaceCredential":1,"com.atproto.space.listRecords":400,"com.atproto.space.listRepos":2,"plc resolve":201}
200 writers, reopen: median 11 ms, p95 26 ms, 1 calls {"com.atproto.space.listRepos":1}
200 writers, one new message: median 42 ms, p95 45 ms, 5 calls {"com.atproto.space.getLatestCommit":2,"com.atproto.space.listRecords":2,"com.atproto.space.listRepos":1}

| writers | phase | calls | median ms | p95 ms |
|---|---|---|---|---|
| 20 | first open | 105 | 718 | 771 |
| 20 | reopen | 1 | 6 | 7 |
| 20 | one new message | 5 | 38 | 68 |
| 100 | first open | 505 | 3432 | 3567 |
| 100 | reopen | 1 | 8 | 10 |
| 100 | one new message | 5 | 39 | 44 |
| 200 | first open | 1005 | 6908 | 7688 |
| 200 | reopen | 1 | 11 | 26 |
| 200 | one new message | 5 | 42 | 45 |

GATE reopen calls are the same at every writer count: 1
```

---

## 3. Channel Performance Envelope Baseline (`protocol-tests/performance-envelope.test.ts`)

Supported-size workload (`200` logical members, `100` channels, `20,000` messages and `20,000` reactions per channel = `2,000,000` messages + `2,000,000` reactions across two PDS instances, `199` explicit writer repos in the read channel, `10` timed read runs per mode).

### 3.1 Latest-100 Channel Read Timings

| Reader / Mode | Runs | Median (ms) | p95 (ms) | Per-Run Samples (ms) |
| :--- | ---: | ---: | ---: | :--- |
| `independentLatest100Reads` (cold from scratch) | 10 | `13676` | `14562` | `[14010, 13433, 13846, 13921, 13608, 13676, 14000, 14562, 13306, 13295]` |
| `engineLatest100ColdReads` (empty store) | 10 | `8634` | `9254` | `[9254, 8641, 8964, 8634, 8602, 8798, 8456, 8448, 8663, 7783]` |
| `engineLatest100WarmReads` (warm store reopen) | 10 | `81` | `113` | `[76, 79, 81, 79, 82, 82, 113, 85, 81, 81]` |

### 3.2 Provisioning, Envelope Operations & Reconciliation Metrics

| Metric | Value | Unit / Notes |
| :--- | ---: | :--- |
| `logicalMembers` | `200` | members |
| `channels` | `100` | channels |
| `messagesPerChannel` | `20000` | messages (`totalMessages: 2000000`) |
| `reactionsPerChannel` | `20000` | reactions (`totalReactions: 2000000`) |
| `explicitWriterRepos` | `199` | repos in target channel |
| `latestPage` | `100` | messages on latest page |
| `accountProvisioningMs` | `5328` | ms |
| `directMembershipSetupMs` | `64211` | ms |
| `journaledInviteAtEnvelopeMs` | `1607` | ms |
| `journaledChannelCreateAtEnvelopeMs` | `1058` | ms |
| `publicToPrivateTransitionAtEnvelopeMs` | `2494` | ms |
| `privateChannelArchiveAtEnvelopeMs` | `2402` | ms |
| `messageWriteMs` | `625252` | ms |
| `reactionWriteMs` | `642066` | ms |
| `privateRequestWriteMs` | `34` | ms |
| `inboxWriterReconciliationMs` | `2408` | ms (SLO `<= 60000`) |
| `independentLatest100ReadMs` | `14010` | ms (first uncached sample) |
| `machineLoadAverage.beforeReads` | `19.51318359375` | 1-min load avg before timed reads |
| `machineLoadAverage.afterReads` | `11.48193359375` | 1-min load avg after timed reads |

### 3.3 Verbatim `PERFORMANCE_ENVELOPE` Line & Progress Tail

```text
PERFORMANCE_PROGRESS two-PDS fixture ready
PERFORMANCE_PROGRESS accounts=200 elapsedMs=5328
PERFORMANCE_PROGRESS memberAndRosterSetup elapsedMs=64211
PERFORMANCE_PROGRESS messagesChannels=10/100 records=200000 elapsedMs=90872
PERFORMANCE_PROGRESS messagesChannels=20/100 records=400000 elapsedMs=149862
PERFORMANCE_PROGRESS messagesChannels=30/100 records=600000 elapsedMs=206156
PERFORMANCE_PROGRESS messagesChannels=40/100 records=800000 elapsedMs=262830
PERFORMANCE_PROGRESS messagesChannels=50/100 records=1000000 elapsedMs=321898
PERFORMANCE_PROGRESS messagesChannels=60/100 records=1200000 elapsedMs=385614
PERFORMANCE_PROGRESS messagesChannels=70/100 records=1400000 elapsedMs=446392
PERFORMANCE_PROGRESS messagesChannels=80/100 records=1600000 elapsedMs=505830
PERFORMANCE_PROGRESS messagesChannels=90/100 records=1800000 elapsedMs=562761
PERFORMANCE_PROGRESS messagesChannels=100/100 records=2000000 elapsedMs=625252
PERFORMANCE_PROGRESS reactionChannels=10/100 records=200000 elapsedMs=64973
PERFORMANCE_PROGRESS reactionChannels=20/100 records=400000 elapsedMs=126912
PERFORMANCE_PROGRESS reactionChannels=30/100 records=600000 elapsedMs=184606
PERFORMANCE_PROGRESS reactionChannels=40/100 records=800000 elapsedMs=247937
PERFORMANCE_PROGRESS reactionChannels=50/100 records=1000000 elapsedMs=308647
PERFORMANCE_PROGRESS reactionChannels=60/100 records=1200000 elapsedMs=375587
PERFORMANCE_PROGRESS reactionChannels=70/100 records=1400000 elapsedMs=436643
PERFORMANCE_PROGRESS reactionChannels=80/100 records=1600000 elapsedMs=508838
PERFORMANCE_PROGRESS reactionChannels=90/100 records=1800000 elapsedMs=575961
PERFORMANCE_PROGRESS reactionChannels=100/100 records=2000000 elapsedMs=642066
PERFORMANCE_ENVELOPE {"logicalMembers":200,"channels":100,"messagesPerChannel":20000,"totalMessages":2000000,"reactionsPerChannel":20000,"totalReactions":2000000,"explicitWriterRepos":199,"latestPage":100,"accountProvisioningMs":5328,"directMembershipSetupMs":64211,"journaledInviteAtEnvelopeMs":1607,"journaledChannelCreateAtEnvelopeMs":1058,"publicToPrivateTransitionAtEnvelopeMs":2494,"privateChannelArchiveAtEnvelopeMs":2402,"messageWriteMs":625252,"reactionWriteMs":642066,"privateRequestWriteMs":34,"inboxWriterReconciliationMs":2408,"independentLatest100ReadMs":14010,"independentLatest100Reads":{"runs":10,"medianMs":13676,"p95Ms":14562,"samplesMs":[14010,13433,13846,13921,13608,13676,14000,14562,13306,13295]},"engineLatest100ColdReads":{"runs":10,"medianMs":8634,"p95Ms":9254,"samplesMs":[9254,8641,8964,8634,8602,8798,8456,8448,8663,7783]},"engineLatest100WarmReads":{"runs":10,"medianMs":81,"p95Ms":113,"samplesMs":[76,79,81,79,82,82,113,85,81,81]},"machineLoadAverage":{"beforeReads":19.51318359375,"afterReads":11.48193359375}}
✔ supported-size workload: 200 members, 100 channels, 20,000 messages and reactions per channel (1583832.624834ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1584004.549833
```

---

## 4. Post-R11 Channel Regression Gate Targets (`D11.13 #6`)

Per `.ai/plans/r11-tasks-progress.md` (`D11.13 #6`), post-R11 verification on this host must assert:

| Gate Metric | `84cfff4` Baseline | Post-R11 Pass Criterion |
| :--- | :--- | :--- |
| `sync-budget.ts` — `20` writers (`first open` / `reopen` / `one new message`) | `105` / `1` / `5` HTTP calls | Identical (`105` / `1` / `5`) |
| `sync-budget.ts` — `100` writers (`first open` / `reopen` / `one new message`) | `505` / `1` / `5` HTTP calls | Identical (`505` / `1` / `5`) |
| `sync-budget.ts` — `200` writers (`first open` / `reopen` / `one new message`) | `1005` / `1` / `5` HTTP calls | Identical (`1005` / `1` / `5`) |
| `performance-envelope.test.ts` — `engineLatest100WarmReads` median | `81 ms` (`p95: 113 ms`) | `<= 250 ms` |
| `performance-envelope.test.ts` — `engineLatest100ColdReads` median | `8634 ms` (`p95: 9254 ms`) | Within `+15%` (`<= 9929 ms`) or `<= 15000 ms` |
| `performance-envelope.test.ts` — `inboxWriterReconciliationMs` | `2408 ms` | `<= 60000 ms` |
