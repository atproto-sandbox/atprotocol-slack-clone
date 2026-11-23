import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backupSqliteDatabase } from "../../../scripts/backup-db.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BACKUP_SCRIPT = join(REPO_ROOT, "scripts/backup-db.mjs");

function seedSqliteDb(dbPath: string): void {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import BetterSqlite3 from "better-sqlite3";
       const db = new BetterSqlite3(${JSON.stringify(dbPath)});
       db.pragma("journal_mode = WAL");
       db.exec("CREATE TABLE secrets (id TEXT PRIMARY KEY, secret TEXT NOT NULL)");
       db.prepare("INSERT INTO secrets (id, secret) VALUES (?, ?)").run("k1", "sensitive-rotation-material");
       db.prepare("INSERT INTO secrets (id, secret) VALUES (?, ?)").run("k2", "group-oauth-session");
       db.close();`,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(res.status, 0, `Failed to seed test SQLite DB: ${res.stderr}`);
}

function verifySqliteBackup(dbPath: string): { integrity: string; rows: Array<{ id: string; secret: string }> } {
  const res = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import BetterSqlite3 from "better-sqlite3";
       const db = new BetterSqlite3(${JSON.stringify(dbPath)}, { readonly: true, fileMustExist: true });
       const integrity = db.pragma("integrity_check", { simple: true });
       const rows = db.prepare("SELECT id, secret FROM secrets ORDER BY id ASC").all();
       db.close();
       process.stdout.write(JSON.stringify({ integrity, rows }));`,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(res.status, 0, `Failed to read backed-up SQLite DB: ${res.stderr}`);
  return JSON.parse(res.stdout) as { integrity: string; rows: Array<{ id: string; secret: string }> };
}

test("backup-db.mjs serializes uncheckpointed WAL frames via descriptor-bound O_CREAT|O_EXCL|O_NOFOLLOW 0600 file and publishes atomically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flock-backup-db-test-"));
  try {
    const srcPath = join(dir, "live.db");
    const backupDir = join(dir, "backups");
    mkdirSync(backupDir);
    seedSqliteDb(srcPath);

    // 1. Verify live uncheckpointed WAL frames (`wal_autocheckpoint = 0` while writer stays open in child script)
    //    are captured in full, staged at strict `0o600` (`nlink === 1`), and readable even in a `0o500` read-only vault!
    const walDest = join(backupDir, "uncheckpointed-wal-backup.db");
    const walRun = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import BetterSqlite3 from "better-sqlite3";
         import { lstatSync } from "node:fs";
         import { backupSqliteDatabase } from "./scripts/backup-db.mjs";
         const writer = new BetterSqlite3(${JSON.stringify(srcPath)});
         writer.pragma("journal_mode = WAL");
         writer.pragma("wal_autocheckpoint = 0");
         writer.prepare("INSERT INTO secrets (id, secret) VALUES (?, ?)").run("k3", "uncheckpointed-wal-secret");
         let observedTmpMode = 0;
         let observedTmpNlink = 0;
         let observedTmpPath = "";
         await backupSqliteDatabase(${JSON.stringify(srcPath)}, ${JSON.stringify(walDest)}, {
           _afterTempFileWritten(tmpPath) {
             observedTmpPath = tmpPath;
             const st = lstatSync(tmpPath);
             observedTmpMode = st.mode & 0o777;
             observedTmpNlink = st.nlink;
           },
         });
         writer.close();
         process.stdout.write(JSON.stringify({ observedTmpPath, observedTmpMode, observedTmpNlink }));`,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(walRun.status, 0, walRun.stderr);
    const walMeta = JSON.parse(walRun.stdout) as {
      observedTmpPath: string;
      observedTmpMode: number;
      observedTmpNlink: number;
    };
    assert.match(walMeta.observedTmpPath, /\.flock-backup-\d+-[0-9a-f-]+\.tmp$/);
    assert.equal(walMeta.observedTmpMode, 0o600, "descriptor-bound staging file must have strict 0600 mode");
    assert.equal(walMeta.observedTmpNlink, 1, "descriptor-bound staging file must have nlink === 1");
    assert.throws(() => lstatSync(walMeta.observedTmpPath), { code: "ENOENT" });
    assert.equal(statSync(walDest).mode & 0o777, 0o600);
    assert.equal(statSync(walDest).nlink, 1);

    // Open backed-up snapshot from a `0o500` read-only directory (proving zero -wal/-shm sidecar writes needed)
    const roVault = join(dir, "ro-vault");
    mkdirSync(roVault);
    const roCopy = join(roVault, "vault.db");
    linkSync(walDest, roCopy);
    chmodSync(roVault, 0o500);
    try {
      const verifiedWal = verifySqliteBackup(roCopy);
      assert.equal(verifiedWal.integrity, "ok");
      assert.deepEqual(verifiedWal.rows, [
        { id: "k1", secret: "sensitive-rotation-material" },
        { id: "k2", secret: "group-oauth-session" },
        { id: "k3", secret: "uncheckpointed-wal-secret" },
      ]);
    } finally {
      chmodSync(roVault, 0o700);
      unlinkSync(roCopy);
    }

    // 2. Default DATABASE_PATH CLI backup
    const dest1 = join(backupDir, "flock-backup.db");
    const run1 = spawnSync(process.execPath, [BACKUP_SCRIPT, dest1], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_PATH: srcPath },
      encoding: "utf8",
    });
    assert.equal(run1.status, 0, run1.stderr);
    assert.match(run1.stdout, /Database backup written to/);

    const st1 = statSync(dest1);
    assert.equal(st1.mode & 0o777, 0o600, "backup must have strict 0600 permissions");
    assert.equal(st1.nlink, 1, "temporary hard-link must be unlinked after publication");
    const verified1 = verifySqliteBackup(dest1);
    assert.equal(verified1.integrity, "ok");

    // 3. --group-host CLI backup
    const dest2 = join(backupDir, "group-host-backup.db");
    const run2 = spawnSync(process.execPath, [BACKUP_SCRIPT, "--group-host", dest2], {
      cwd: REPO_ROOT,
      env: { ...process.env, GROUP_HOST_DATABASE_PATH: srcPath },
      encoding: "utf8",
    });
    assert.equal(run2.status, 0, run2.stderr);
    assert.match(run2.stdout, /Group Host database backup written to/);
    assert.equal(statSync(dest2).mode & 0o777, 0o600);
    assert.equal(verifySqliteBackup(dest2).integrity, "ok");

    const leftovers = readdirSync(backupDir).filter(
      (name) => name.startsWith(".flock-backup-") || name.endsWith(".tmp"),
    );
    assert.deepEqual(leftovers, [], "zero staging .flock-backup-* files may remain in backup directory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup-db.mjs rejects existing files, directories, live symlinks, dangling symlinks, and symlinked parent dirs without clobbering targets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flock-backup-db-excl-"));
  try {
    const srcPath = join(dir, "live.db");
    seedSqliteDb(srcPath);

    // 1. Existing regular file at destination is preserved untouched
    const existingDest = join(dir, "existing.db");
    writeFileSync(existingDest, "original-bytes", { mode: 0o600 });
    const runExisting = spawnSync(process.execPath, [BACKUP_SCRIPT, existingDest], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_PATH: srcPath },
      encoding: "utf8",
    });
    assert.notEqual(runExisting.status, 0);
    assert.match(runExisting.stderr, /EEXIST/);
    assert.equal(readFileSync(existingDest, "utf8"), "original-bytes");

    // 2. Existing directory at destination is rejected with EEXIST
    const existingDir = join(dir, "existing-dir.db");
    mkdirSync(existingDir);
    const runExistingDir = spawnSync(process.execPath, [BACKUP_SCRIPT, existingDir], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_PATH: srcPath },
      encoding: "utf8",
    });
    assert.notEqual(runExistingDir.status, 0);
    assert.match(runExistingDir.stderr, /EEXIST/);
    assert.ok(lstatSync(existingDir).isDirectory());

    // 3. Dangling symlink at destination is rejected with EEXIST and never followed to create target
    const missingTarget = join(dir, "never-create-me.db");
    const danglingLink = join(dir, "dangling-dest.db");
    symlinkSync(missingTarget, danglingLink);
    const runDangling = spawnSync(process.execPath, [BACKUP_SCRIPT, danglingLink], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_PATH: srcPath },
      encoding: "utf8",
    });
    assert.notEqual(runDangling.status, 0);
    assert.match(runDangling.stderr, /EEXIST/);
    assert.ok(lstatSync(danglingLink).isSymbolicLink());
    assert.throws(() => lstatSync(missingTarget), { code: "ENOENT" });

    // 4. Live symlink pointing to victim file is rejected with EEXIST without modifying victim
    const victimFile = join(dir, "victim.txt");
    writeFileSync(victimFile, "do-not-clobber", { mode: 0o600 });
    const liveLink = join(dir, "live-link.db");
    symlinkSync(victimFile, liveLink);
    const runLiveLink = spawnSync(process.execPath, [BACKUP_SCRIPT, liveLink], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_PATH: srcPath },
      encoding: "utf8",
    });
    assert.notEqual(runLiveLink.status, 0);
    assert.match(runLiveLink.stderr, /EEXIST/);
    assert.equal(readFileSync(victimFile, "utf8"), "do-not-clobber");

    // 5. Symlinked parent directory is rejected with ELOOP before creating any staging file
    const realTargetDir = join(dir, "real-parent");
    mkdirSync(realTargetDir);
    const symlinkParentDir = join(dir, "symlink-parent");
    symlinkSync(realTargetDir, symlinkParentDir);
    await assert.rejects(
      () => backupSqliteDatabase(srcPath, join(symlinkParentDir, "out.db")),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.deepEqual(readdirSync(realTargetDir), []);

    // 6. Corrupt source DB fails cleanly before creating any staging file or destination
    const corruptSrc = join(dir, "corrupt.db");
    writeFileSync(corruptSrc, "not a sqlite database header!!", { mode: 0o600 });
    const failedDest = join(dir, "failed-dest.db");
    const runCorrupt = spawnSync(process.execPath, [BACKUP_SCRIPT, failedDest], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_PATH: corruptSrc },
      encoding: "utf8",
    });
    assert.notEqual(runCorrupt.status, 0);
    assert.throws(() => lstatSync(failedDest), { code: "ENOENT" });

    const leftovers = readdirSync(dir).filter(
      (name) => name.startsWith(".flock-backup-") || name.endsWith(".tmp"),
    );
    assert.deepEqual(leftovers, [], "zero .flock-backup-* files may remain after rejected or failed backups");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupSqliteDatabase rejects same-UID tmpPath symlink/inode replacement, extra hard-links, and parent-directory substitution with ELOOP without touching or unlinking unintended targets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flock-backup-db-swap-"));
  try {
    const srcPath = join(dir, "live.db");
    const backupDir = join(dir, "backups");
    mkdirSync(backupDir);
    seedSqliteDb(srcPath);

    const victimFile = join(dir, "victim-mode-644.txt");
    writeFileSync(victimFile, "untouched-victim", { mode: 0o644 });
    const origVictimMode = statSync(victimFile).mode & 0o777;

    // 1. Simulated same-UID symlink swap at `tmpPath` before `linkSync` -> rejected with `ELOOP`,
    //    victim file untouched & mode preserved, and substituted symlink entry is NEVER unlinked by cleanup!
    let injectedSymlinkPath = "";
    const symlinkDest = join(backupDir, "symlink-swap-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, symlinkDest, {
          _afterTempFileWritten(tmpPath: string) {
            injectedSymlinkPath = tmpPath;
            unlinkSync(tmpPath);
            symlinkSync(victimFile, tmpPath);
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.equal(readFileSync(victimFile, "utf8"), "untouched-victim");
    assert.equal(statSync(victimFile).mode & 0o777, origVictimMode, "victim file mode must not be altered");
    assert.throws(() => lstatSync(symlinkDest), { code: "ENOENT" });
    assert.ok(lstatSync(injectedSymlinkPath).isSymbolicLink(), "substituted entry must never be unlinked by backup cleanup");
    unlinkSync(injectedSymlinkPath);

    // 2. Simulated same-UID regular-file inode replacement at `tmpPath` -> rejected with `ELOOP` and bystander file NOT unlinked!
    let bystanderTmpPath = "";
    const inodeSwapDest = join(backupDir, "inode-swap-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, inodeSwapDest, {
          _afterTempFileWritten(tmpPath: string) {
            bystanderTmpPath = tmpPath;
            unlinkSync(tmpPath);
            writeFileSync(tmpPath, "bystander-regular-file", { mode: 0o640 });
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.throws(() => lstatSync(inodeSwapDest), { code: "ENOENT" });
    assert.equal(readFileSync(bystanderTmpPath, "utf8"), "bystander-regular-file", "substituted regular file must not be unlinked or overwritten");
    unlinkSync(bystanderTmpPath);

    // 3. Simulated extra hard-link (`nlink !== 1`) at `tmpPath` -> rejected with `ELOOP` and our staging inode wiped to 0 bytes via ftruncate!
    const extraLinkPath = join(dir, "extra-hardlink.db");
    const hardlinkDest = join(backupDir, "hardlink-swap-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, hardlinkDest, {
          _afterTempFileWritten(tmpPath: string) {
            linkSync(tmpPath, extraLinkPath);
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.throws(() => lstatSync(hardlinkDest), { code: "ENOENT" });
    assert.equal(statSync(extraLinkPath).size, 0, "aborted staging inode must be wiped to 0 bytes via inode-bound ftruncate");
    unlinkSync(extraLinkPath);

    // 4. Simulated same-UID parent-directory (`backupDir`) replacement before publish -> rejected with `ELOOP`
    //    without writing into or unlinking anything inside the replacement target directory!
    const displacedDir = join(dir, "backups-displaced");
    const decoyDir = join(dir, "decoy-target");
    mkdirSync(decoyDir);
    const decoyBystander = join(decoyDir, "keep-me.txt");
    writeFileSync(decoyBystander, "safe-in-decoy", { mode: 0o600 });
    const parentSwapDest = join(backupDir, "parent-swap-dest.db");
    let displacedTmpRel = "";
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, parentSwapDest, {
          _afterTempFileWritten(tmpPath: string) {
            displacedTmpRel = tmpPath.slice(backupDir.length + 1);
            renameSync(backupDir, displacedDir);
            symlinkSync(decoyDir, backupDir);
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.equal(readFileSync(decoyBystander, "utf8"), "safe-in-decoy");
    assert.deepEqual(readdirSync(decoyDir), ["keep-me.txt"], "nothing may be linked or created inside substituted parent target");
    // Restore original `backupDir`; our staging descriptor inside `displacedDir` was wiped to 0 bytes via inode-bound ftruncate!
    unlinkSync(backupDir);
    renameSync(displacedDir, backupDir);
    assert.equal(
      statSync(join(backupDir, displacedTmpRel)).size,
      0,
      "aborted staging inode inside displaced pinned dirFd must be wiped to 0 bytes without calling unlink",
    );

    // 4b. Parent-directory swap DURING `sourceDb.serialize()` (`_duringSerialize`, BEFORE `openat` is called!) —
    //     both symlink replacement and real-directory replacement -> `openat(dirFd, tmpBase, ...)` resolves strictly inside
    //     the pinned `dirFd`, so ZERO files or bytes ever touch the replacement directory!
    const displacedDuringSer = join(dir, "backups-displaced-during-serialize");
    const serializeSwapDest = join(backupDir, "during-serialize-swap.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, serializeSwapDest, {
          _duringSerialize() {
            renameSync(backupDir, displacedDuringSer);
            symlinkSync(decoyDir, backupDir);
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.deepEqual(readdirSync(decoyDir), ["keep-me.txt"], "zero files or bytes may touch symlinked replacement dir during serialize");
    unlinkSync(backupDir);
    renameSync(displacedDuringSer, backupDir);

    const replacementRealDir = join(dir, "replacement-real-dir");
    const serializeRealDirSwapDest = join(backupDir, "during-serialize-realdir-swap.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, serializeRealDirSwapDest, {
          _duringSerialize() {
            renameSync(backupDir, displacedDuringSer);
            mkdirSync(backupDir);
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.deepEqual(readdirSync(backupDir), [], "zero files or bytes may be created inside replacement real directory during serialize");
    renameSync(backupDir, replacementRealDir);
    renameSync(displacedDuringSer, backupDir);
    rmSync(replacementRealDir, { recursive: true, force: true });

    // 4c. Parent-directory swap right BEFORE `linkat` (`_beforeLinkAt`, AFTER pre-link checks!) ->
    //     `linkat(dirFd, tmpBase, dirFd, destBase, 0)` resolves strictly inside pinned `dirFd`, so ZERO entries ever touch
    //     the replacement directory, and post-link verification aborts & cleans up inside `dirFd` with `ELOOP`!
    const displacedBeforeLink = join(dir, "backups-displaced-before-linkat");
    const beforeLinkSwapDest = join(backupDir, "before-linkat-swap.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, beforeLinkSwapDest, {
          _beforeLinkAt() {
            renameSync(backupDir, displacedBeforeLink);
            mkdirSync(backupDir);
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.deepEqual(readdirSync(backupDir), [], "zero files or links may ever touch replacement directory during linkat");
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(displacedBeforeLink, backupDir);
    assert.throws(() => lstatSync(beforeLinkSwapDest), { code: "ENOENT" });

    // 5. Narrow-window substitution between `preLinkStat` and `linkSync` -> `postLinkStat` detects mismatch, unlinks `destinationPath`, and rejects with `ELOOP`!
    let postSwapBystanderPath = "";
    const narrowRaceDest = join(backupDir, "narrow-race-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, narrowRaceDest, {
          _betweenPreLinkStatAndLink(tmpPath: string) {
            postSwapBystanderPath = tmpPath;
            unlinkSync(tmpPath);
            writeFileSync(tmpPath, "narrow-race-bystander", { mode: 0o600 });
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.throws(() => lstatSync(narrowRaceDest), { code: "ENOENT" }, "aborted pre-link tmp mismatch must never create destination link");
    assert.equal(readFileSync(postSwapBystanderPath, "utf8"), "narrow-race-bystander");
    unlinkSync(postSwapBystanderPath);

    // 5b. Post-link destination replacement (`_afterLinkAt` replaces `dest` with a bystander file BEFORE post-link verification!) ->
    //     `backupSqliteDatabase` MUST reject with `ELOOP`, clean up its private `.flock-backup-*.tmp` staging file, and leave
    //     the raced-in bystander at `dest` 100% untouched (NEVER unlinking unknown destination entries)!
    const postLinkBystanderDest = join(backupDir, "post-link-bystander-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, postLinkBystanderDest, {
          _afterLinkAt(destPath: string) {
            const replacementTmp = join(backupDir, "external-writer-replacement.tmp");
            writeFileSync(replacementTmp, "raced-in-destination-bystander", { mode: 0o600 });
            renameSync(replacementTmp, destPath);
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.equal(
      readFileSync(postLinkBystanderDest, "utf8"),
      "raced-in-destination-bystander",
      "post-link mismatch MUST leave raced-in destination bystander untouched",
    );
    unlinkSync(postLinkBystanderDest);

    // 6. Concurrent destination appearance right before `linkSync` -> rejected with `EEXIST` without following symlink at `dest`
    const raceDest = join(backupDir, "race-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, raceDest, {
          _afterTempFileWritten() {
            symlinkSync(victimFile, raceDest);
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "EEXIST",
    );
    assert.ok(lstatSync(raceDest).isSymbolicLink());
    assert.equal(readFileSync(victimFile, "utf8"), "untouched-victim");
    unlinkSync(raceDest);

    // 7. Round 17 Fix #6, #7, #9:
    //    - `backup-db.mjs` uses online `sourceDb.backup(...)` (never `.serialize()`),
    //    - contains ZERO `os.unlink(` / `unlinkSync(` calls anywhere (only `AT_REMOVEDIR` `os.rmdir` on empty stage dir on success),
    //    - wipes kept-open `stage_fd` to 0 bytes via inode-bound `ftruncate` on abort while leaving any bystander at `tmpPath` untouched!
    const backupScriptSrc = readFileSync(BACKUP_SCRIPT, "utf8");
    assert.equal(/\.backup\s*\(/.test(backupScriptSrc), true, "backup-db.mjs must use better-sqlite3 db.backup(...)");
    assert.equal(/\.serialize\s*\(/.test(backupScriptSrc), false, "backup-db.mjs must not buffer full DB via serialize()");
    assert.equal(
      /os\.unlink\s*\(|unlinkSync\s*\(/.test(backupScriptSrc),
      false,
      "backup-db.mjs must contain zero file unlink calls",
    );

    let abortRaceTmpPath = "";
    const abortRaceDest = join(backupDir, "abort-race-dest.db");
    writeFileSync(abortRaceDest, "already-exists", { mode: 0o600 });
    await assert.rejects(
      () =>
        backupSqliteDatabase(
          srcPath,
          join(backupDir, "abort-race-fresh-dest.db"),
          {
            _afterTempFileWritten() {
              writeFileSync(join(backupDir, "abort-race-fresh-dest.db"), "concurrent-dest", { mode: 0o600 });
            },
            _beforeAbortCleanup(tmpPath: string) {
              abortRaceTmpPath = tmpPath;
              unlinkSync(tmpPath);
              writeFileSync(tmpPath, "abort-cleanup-bystander", { mode: 0o600 });
            },
          },
        ),
      (err: NodeJS.ErrnoException) => err.code === "EEXIST",
    );
    assert.equal(
      readFileSync(abortRaceTmpPath, "utf8"),
      "abort-cleanup-bystander",
      "abort cleanup MUST NOT delete or truncate a same-directory bystander placed at tmpPath",
    );
    unlinkSync(abortRaceTmpPath);
    unlinkSync(join(backupDir, "abort-race-fresh-dest.db"));
    unlinkSync(abortRaceDest);

    // Every aborted `.flock-backup-stage-*` directory from fault-injected tests above may contain ONLY 0-byte wiped files (zero sensitive residue)!
    for (const entry of readdirSync(backupDir)) {
      if (!entry.startsWith(".flock-backup-stage-")) continue;
      const stageSubdir = join(backupDir, entry);
      for (const child of readdirSync(stageSubdir)) {
        assert.equal(
          statSync(join(stageSubdir, child)).size,
          0,
          `aborted staging file ${entry}/${child} must have 0 bytes of sensitive data`,
        );
      }
    }

    // 8. Round 18 Fix #5:
    //    (a) Even if a same-UID race replaces `tmpName` with a symlink OR hardlink to another writable SQLite DB
    //        right between `lstatSync` and `sqlite3_open_v2` inside `db.backup(...)`, `progress(#1)` (`transfer(0)`)
    //        verifies the kernel descriptor `(dev, ino, nlink === 1)` BEFORE transferring a single page, leaving
    //        the target SQLite DB 100% byte-identical!
    const victimSqliteDb = join(dir, "victim-precious.db");
    seedSqliteDb(victimSqliteDb);
    // Add distinct marker row so any overwrite by `srcPath` would be immediately visible
    const markRun = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import BetterSqlite3 from "better-sqlite3";
         const db = new BetterSqlite3(${JSON.stringify(victimSqliteDb)});
         db.pragma("journal_mode = DELETE");
         db.prepare("INSERT INTO secrets (id, secret) VALUES (?, ?)").run("victim-only", "NEVER_OVERWRITE_ME");
         db.close();`,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(markRun.status, 0, markRun.stderr);
    const victimBytesBefore = Buffer.from(readFileSync(victimSqliteDb));

    for (const raceMode of ["symlink", "hardlink"] as const) {
      const hookCode =
        raceMode === "symlink"
          ? `import { symlinkSync, unlinkSync } from "node:fs";
             export default (tmpName) => { unlinkSync(tmpName); symlinkSync(${JSON.stringify(victimSqliteDb)}, tmpName); };`
          : `import { linkSync, unlinkSync } from "node:fs";
             export default (tmpName) => { unlinkSync(tmpName); linkSync(${JSON.stringify(victimSqliteDb)}, tmpName); };`;
      const hookUrl = `data:text/javascript,${encodeURIComponent(hookCode)}`;
      const openRaceDest = join(backupDir, `sqlite-open-${raceMode}-race-dest.db`);
      await assert.rejects(
        () =>
          backupSqliteDatabase(srcPath, openRaceDest, {
            _sqliteOpenHookUrl: hookUrl,
          }),
        (err: NodeJS.ErrnoException) => err.code === "ELOOP",
        `sqlite3_open_v2 ${raceMode} swap must fail closed with ELOOP before transferring any pages`,
      );
      assert.throws(() => lstatSync(openRaceDest), { code: "ENOENT" });
      const victimBytesAfter = Buffer.from(readFileSync(victimSqliteDb));
      assert.equal(
        victimBytesBefore.equals(victimBytesAfter),
        true,
        `victim SQLite database must remain 100% byte-identical on ${raceMode} swap`,
      );
    }

    //    (b) Round 18 Fix #5 & Round 19 Fix #5:
    //        (i) Active mid-transfer `SIGKILL` of the Python helper process WHILE the child Node SQLite worker
    //            is mid-backup (`remainingPages > 0`, holding its open SQLite destination descriptor, and with
    //            self-exit disabled so ONLY parent process-group supervision can stop it from finishing):
    //            parent terminates & reaps the entire `-helperPid` process group (`ESRCH`) BEFORE `ftruncateSync`,
    //            leaving 0 bytes in `tmpPath` and zero sensitive bytes anywhere in the staging directory!
    const largeSrcPath = join(dir, "live-multipage.db");
    const seedLarge = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import BetterSqlite3 from "better-sqlite3";
         const db = new BetterSqlite3(${JSON.stringify(largeSrcPath)});
         db.pragma("journal_mode = WAL");
         db.exec("CREATE TABLE secrets (id INTEGER PRIMARY KEY, secret TEXT NOT NULL)");
         const ins = db.prepare("INSERT INTO secrets (secret) VALUES (?)");
         const tx = db.transaction(() => {
           for (let i = 0; i < 400; i++) ins.run("ACTIVE_MID_TRANSFER_SECRET_" + "x".repeat(800));
         });
         tx();
         db.close();`,
      ],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(seedLarge.status, 0, seedLarge.stderr);

    const midMarkerPath = join(dir, "mid-transfer-marker.json");
    const midTransferHookCode = `import { writeFileSync } from "node:fs";
      export default ({ parentPid, totalPages, remainingPages }) => {
        writeFileSync(${JSON.stringify(midMarkerPath)}, JSON.stringify({
          childPid: process.pid,
          parentPid,
          totalPages,
          remainingPages,
        }));
        process.kill(parentPid, "SIGKILL");
        // Pause 120ms while holding open SQLite destination FD: without process-group quiescing BEFORE
        // truncation, this orphaned worker would wake up and flush all pages into tmpPath after parent wiped!
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      };`;
    const midTransferHookUrl = `data:text/javascript,${encodeURIComponent(midTransferHookCode)}`;
    let midKillTmpPath = "";
    let midKillHelperPid = 0;
    const midKillDest = join(backupDir, "sigkill-mid-transfer-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(largeSrcPath, midKillDest, {
          _beforeSqliteOpen(tmpPath: string, helperPid?: number) {
            midKillTmpPath = tmpPath;
            midKillHelperPid = helperPid ?? 0;
          },
          _duringTransferHookUrl: midTransferHookUrl,
          _disablePpidSelfExit: true,
        }),
    );
    const midMarker = JSON.parse(readFileSync(midMarkerPath, "utf8")) as {
      childPid: number;
      parentPid: number;
      totalPages: number;
      remainingPages: number;
    };
    assert.equal(midMarker.parentPid, midKillHelperPid);
    assert.equal(midMarker.remainingPages > 0, true, "hook must fire during active multi-page SQLite transfer");
    assert.throws(() => process.kill(midMarker.childPid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(-midKillHelperPid, 0), { code: "ESRCH" });

    // Sleep 150ms past the 120ms worker pause window to prove no late orphan write can ever occur!
    await new Promise((r) => setTimeout(r, 150));
    assert.throws(() => lstatSync(midKillDest), { code: "ENOENT" });
    assert.equal(
      statSync(midKillTmpPath).size,
      0,
      "staged snapshot MUST remain 0 bytes after mid-transfer helper SIGKILL",
    );
    const midStageDir = join(backupDir, midKillTmpPath.slice(backupDir.length + 1).split("/")[0]!);
    for (const child of readdirSync(midStageDir)) {
      const bytes = readFileSync(join(midStageDir, child));
      assert.equal(
        bytes.includes("ACTIVE_MID_TRANSFER_SECRET"),
        false,
        `staging entry ${child} must contain zero sensitive source DB bytes`,
      );
    }

    //        (ii) Post-transfer `SIGKILL` of the Python helper AFTER `db.backup(...)` committed all pages:
    //             parent's surviving `parentStageFd` zeroes the staged inode to 0 bytes in-process!
    let killedStageTmpPath = "";
    const sigkillDest = join(backupDir, "sigkill-helper-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, sigkillDest, {
          _afterTempFileWritten(tmpPath: string, _fdStat, helperPid?: number) {
            killedStageTmpPath = tmpPath;
            assert.equal(statSync(tmpPath).size > 0, true, "staged snapshot is non-empty before helper SIGKILL");
            assert.equal(typeof helperPid, "number");
            process.kill(helperPid!, "SIGKILL");
          },
        }),
    );
    assert.throws(() => lstatSync(sigkillDest), { code: "ENOENT" });
    assert.equal(
      statSync(killedStageTmpPath).size,
      0,
      "parent-held surviving descriptor MUST zero staged snapshot to 0 bytes even after abrupt helper SIGKILL",
    );

    //        (iii) Round 20 Fix #3: If a same-UID race replaces `tmpPath` with a non-empty bystander regular file
    //              BEFORE `parentStageFd = openSync(tmpPath)` validates `(dev, ino)`, `candidateStageFd` is closed
    //              without assigning `parentStageFd` so cleanup NEVER truncates the bystander file!
    let prePinBystanderPath = "";
    const prePinDest = join(backupDir, "pre-parent-pin-bystander-dest.db");
    await assert.rejects(
      () =>
        backupSqliteDatabase(srcPath, prePinDest, {
          _beforeParentStagePin(tmpPath: string) {
            prePinBystanderPath = tmpPath;
            unlinkSync(tmpPath);
            writeFileSync(tmpPath, "precious-bystander-before-parent-pin", { mode: 0o600 });
          },
        }),
      (err: NodeJS.ErrnoException) => err.code === "ELOOP",
    );
    assert.throws(() => lstatSync(prePinDest), { code: "ENOENT" });
    assert.equal(
      readFileSync(prePinBystanderPath, "utf8"),
      "precious-bystander-before-parent-pin",
      "rejected candidateStageFd MUST NOT truncate a bystander regular file swapped before parent pin",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
