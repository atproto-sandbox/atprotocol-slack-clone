import BetterSqlite3 from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const PYTHON_BIN = process.env.PYTHON3 ?? "python3";
const REPO_PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));

const PY_CHECK_DEST_ABSENT = `
import errno, json, os, sys
name = sys.argv[1]
if "/" in name or "\\\\" in name or name in ("", ".", ".."):
    sys.stdout.write(json.dumps({"ok": False, "code": "EINVAL", "message": "invalid basename"}))
    sys.exit(2)
try:
    os.stat(name, dir_fd=3, follow_symlinks=False)
    sys.stdout.write(json.dumps({"ok": False, "code": "EEXIST", "message": "backup destination already exists"}))
    sys.exit(2)
except FileNotFoundError:
    sys.stdout.write(json.dumps({"ok": True}))
except OSError as e:
    sys.stdout.write(json.dumps({"ok": False, "code": errno.errorcode.get(e.errno, "EIO"), "message": str(e)}))
    sys.exit(2)
`;

const JS_CHILD_SQLITE_BACKUP = `
import { existsSync, fstatSync, lstatSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(process.argv[1]);
const BetterSqlite3 = require("better-sqlite3");
const sourcePath = process.argv[2];
const tmpName = process.argv[3];
const expDev = BigInt(process.argv[4]);
const expIno = BigInt(process.argv[5]);
const STAGE_FD = 4;
const fdDir = existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";

function makeEloop(msg) {
  const err = new Error(msg);
  err.code = "ELOOP";
  return err;
}

const stFd0 = fstatSync(STAGE_FD, { bigint: true });
if (!stFd0.isFile() || stFd0.dev !== expDev || stFd0.ino !== expIno || stFd0.nlink !== 1n || stFd0.size !== 0n) {
  throw makeEloop("ELOOP: inherited stage_fd failed initial regular-file / dev-ino / nlink / zero-size check");
}

const stPath0 = lstatSync(tmpName, { bigint: true });
if (
  stPath0.isSymbolicLink() ||
  !stPath0.isFile() ||
  stPath0.dev !== expDev ||
  stPath0.ino !== expIno ||
  stPath0.nlink !== 1n
) {
  throw makeEloop("ELOOP: staged filename was replaced before sqlite3_open_v2");
}

const expectedParentPid = process.ppid;
const disablePpidSelfExit = process.env.FLOCK_TEST_DISABLE_PPID_SELF_EXIT === "1";

const testHookUrl = process.env.FLOCK_TEST_SQLITE_OPEN_HOOK_URL || "";
if (testHookUrl) {
  const mod = await import(testHookUrl);
  await mod.default(tmpName);
}

const duringTransferHookUrl = process.env.FLOCK_TEST_DURING_TRANSFER_HOOK_URL || "";
const duringTransferHook = duringTransferHookUrl ? (await import(duringTransferHookUrl)).default : null;

const sourceDb = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true, timeout: 5000 });
let stepCount = 0;
try {
  await sourceDb.backup(tmpName, {
    progress(info) {
      stepCount += 1;
      if (!disablePpidSelfExit && process.ppid !== expectedParentPid) {
        process.exit(43);
      }
      const stSelf = fstatSync(STAGE_FD, { bigint: true });
      if (!stSelf.isFile() || stSelf.dev !== expDev || stSelf.ino !== expIno || stSelf.nlink !== 1n) {
        throw makeEloop("ELOOP: stage_fd inode or hard-link count changed during db.backup");
      }
      if (stepCount === 1) {
        // better-sqlite3 calls progress() after backup.transfer(0), BEFORE transferring a single page!
        // Verify sqlite3_open_v2 opened our exact (expDev, expIno) inode before allowing any page write.
        if (stSelf.size !== 0n) {
          throw makeEloop("ELOOP: stage_fd unexpectedly non-empty before first backup transfer");
        }
        let matched = 0;
        for (const entry of readdirSync(fdDir)) {
          const n = Number(entry);
          if (!Number.isInteger(n) || n === STAGE_FD) continue;
          try {
            const st = fstatSync(n, { bigint: true });
            if (st.isFile() && st.dev === expDev && st.ino === expIno && st.nlink === 1n) {
              matched += 1;
            }
          } catch {
            // Descriptor closed while scanning fdDir (e.g. readdirSync's own dirfd).
          }
        }
        if (matched < 1) {
          throw makeEloop("ELOOP: sqlite3_open_v2 did not open the pre-staged inode");
        }
        if (duringTransferHook) {
          return 1;
        }
      } else if (stepCount === 2 && duringTransferHook) {
        duringTransferHook({
          stepCount,
          tmpName,
          parentPid: expectedParentPid,
          totalPages: info.totalPages,
          remainingPages: info.remainingPages,
        });
        if (!disablePpidSelfExit && process.ppid !== expectedParentPid) {
          process.exit(43);
        }
      }
      return 100;
    },
  });
  if (stepCount < 1) {
    throw makeEloop("ELOOP: db.backup completed without invoking pre-write inode verification");
  }
} catch (err) {
  if (err && typeof err === "object" && err.code === "ELOOP") {
    process.stderr.write(\`ELOOP_MARKER:\${err.message}\\n\`);
    process.exit(42);
  }
  throw err;
} finally {
  sourceDb.close();
}
`;

const PY_BACKUP_SESSION = `
import ctypes, ctypes.util, errno, json, os, platform, stat, subprocess, sys
os.setpgid(0, 0)

_libc = ctypes.CDLL(ctypes.util.find_library("c") or None, use_errno=True)

def rename_noreplace(src_dfd, src_name, dst_dfd, dst_name):
    src_b = os.fsencode(src_name)
    dst_b = os.fsencode(dst_name)
    if sys.platform == "darwin":
        fn = _libc.renameatx_np
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        ctypes.set_errno(0)
        rc = fn(src_dfd, src_b, dst_dfd, dst_b, 0x00000004)
    elif sys.platform.startswith("linux"):
        if hasattr(_libc, "renameat2"):
            fn = _libc.renameat2
            fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            fn.restype = ctypes.c_int
            ctypes.set_errno(0)
            rc = fn(src_dfd, src_b, dst_dfd, dst_b, 1)
        else:
            mach = platform.machine().lower()
            nr = 316 if mach in ("x86_64", "amd64") else (276 if mach in ("aarch64", "arm64") else -1)
            if nr < 0:
                raise OSError(errno.ENOSYS, f"unsupported Linux architecture for renameat2: {mach}")
            fn = _libc.syscall
            fn.argtypes = [ctypes.c_long, ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            fn.restype = ctypes.c_long
            ctypes.set_errno(0)
            rc = fn(nr, src_dfd, src_b, dst_dfd, dst_b, 1)
    else:
        raise OSError(errno.ENOSYS, f"atomic non-replacing renameat unsupported on {sys.platform}")
    if rc != 0:
        err = ctypes.get_errno() or errno.EIO
        raise OSError(err, os.strerror(err))

stage_dir_name = sys.argv[1]
tmp_name = sys.argv[2]
dest_name = sys.argv[3]
node_bin = sys.argv[4]
repo_pkg_json = sys.argv[5]
source_path = sys.argv[6]
js_backup_code = sys.argv[7]

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\\n")
    sys.stdout.flush()

for nm in (stage_dir_name, tmp_name, dest_name):
    if "/" in nm or "\\\\" in nm or nm in ("", ".", ".."):
        send({"ok": False, "code": "EINVAL", "message": "basenames must not contain path separators"})
        sys.exit(2)

stage_dfd = -1
stage_fd = -1
exp_dev = -1
exp_ino = -1
published = False
wiped = False

def wipe_stage_fd_strict():
    global wiped
    if stage_fd < 0 or published or wiped:
        return None
    try:
        os.ftruncate(stage_fd, 0)
        os.fsync(stage_fd)
        wiped = True
        return None
    except OSError as e:
        return f"{errno.errorcode.get(e.errno, 'EIO')}: {e}"

try:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        cmd = json.loads(line)
        op = cmd.get("op")

        if op == "create_stage":
            try:
                os.mkdir(stage_dir_name, 0o700, dir_fd=3)
                stage_dfd = os.open(
                    stage_dir_name,
                    os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=3,
                )
                d_st = os.fstat(stage_dfd)
                if (
                    not stat.S_ISDIR(d_st.st_mode)
                    or d_st.st_uid != os.geteuid()
                    or (d_st.st_mode & 0o777) != 0o700
                ):
                    raise OSError(errno.ELOOP, "staging directory failed ownership or 0700 mode check")

                open_flags = os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
                stage_fd = os.open(tmp_name, open_flags, 0o600, dir_fd=stage_dfd)
                st0 = os.fstat(stage_fd)
                if not stat.S_ISREG(st0.st_mode) or st0.st_nlink != 1 or st0.st_size != 0:
                    raise OSError(errno.ELOOP, "staged backup descriptor is not an unshared empty regular file")
                exp_dev = st0.st_dev
                exp_ino = st0.st_ino
                send({
                    "ok": True,
                    "dev": str(exp_dev),
                    "ino": str(exp_ino),
                    "mode": st0.st_mode,
                    "nlink": st0.st_nlink,
                    "size": 0,
                })
            except OSError as e:
                wipe_err = wipe_stage_fd_strict()
                if stage_fd < 0 and stage_dir_name:
                    try:
                        if stage_dfd >= 0:
                            os.close(stage_dfd)
                            stage_dfd = -1
                        os.rmdir(stage_dir_name, dir_fd=3)
                    except OSError:
                        pass
                code = "ELOOP" if e.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)) else errno.errorcode.get(e.errno, "EIO")
                msg = str(e) if not wipe_err else f"{e} (cleanup wipe error: {wipe_err})"
                send({"ok": False, "code": code, "message": msg, "cleanupError": wipe_err, "cleanedUp": wipe_err is None})
                sys.exit(2)

        elif op == "run_backup":
            hook_url = cmd.get("hookUrl") or ""
            during_transfer_hook_url = cmd.get("duringTransferHookUrl") or ""
            disable_ppid_exit = bool(cmd.get("disablePpidSelfExit"))
            helper_pid_before = os.getpid()
            try:
                pre_st = os.stat(tmp_name, dir_fd=stage_dfd, follow_symlinks=False)
                pre_fd = os.fstat(stage_fd)
                if (
                    stat.S_ISLNK(pre_st.st_mode)
                    or not stat.S_ISREG(pre_st.st_mode)
                    or pre_st.st_dev != exp_dev
                    or pre_st.st_ino != exp_ino
                    or pre_st.st_nlink != 1
                    or pre_fd.st_nlink != 1
                    or pre_fd.st_size != 0
                ):
                    raise OSError(errno.ELOOP, "staged backup file changed before db.backup")

                def _prep_child():
                    if sys.platform.startswith("linux") and not disable_ppid_exit and hasattr(_libc, "prctl"):
                        _libc.prctl(1, 9, 0, 0, 0)
                        if os.getppid() != helper_pid_before:
                            os._exit(43)
                    os.fchdir(stage_dfd)
                    os.close(stage_dfd)
                    if stage_fd != 4:
                        os.dup2(stage_fd, 4)
                        os.close(stage_fd)

                child_env = dict(os.environ)
                if hook_url:
                    child_env["FLOCK_TEST_SQLITE_OPEN_HOOK_URL"] = hook_url
                if during_transfer_hook_url:
                    child_env["FLOCK_TEST_DURING_TRANSFER_HOOK_URL"] = during_transfer_hook_url
                if disable_ppid_exit:
                    child_env["FLOCK_TEST_DISABLE_PPID_SELF_EXIT"] = "1"

                proc = subprocess.run(
                    [
                        node_bin,
                        "--input-type=module",
                        "-e",
                        js_backup_code,
                        repo_pkg_json,
                        source_path,
                        tmp_name,
                        str(exp_dev),
                        str(exp_ino),
                    ],
                    pass_fds=(stage_dfd, stage_fd),
                    preexec_fn=_prep_child,
                    env=child_env,
                    capture_output=True,
                    text=True,
                )
                if proc.returncode != 0:
                    err_txt = (proc.stderr or proc.stdout or f"db.backup exited {proc.returncode}").strip()
                    if proc.returncode == 42 or "ELOOP_MARKER:" in err_txt:
                        raise OSError(errno.ELOOP, err_txt)
                    raise OSError(errno.EIO, err_txt)

                hdr = os.pread(stage_fd, 100, 0)
                if len(hdr) < 100 or hdr[:16] != b"SQLite format 3\\x00":
                    raise OSError(errno.EIO, "backed-up SQLite header is invalid")
                if hdr[18] == 2 or hdr[19] == 2:
                    b18 = 1 if hdr[18] == 2 else hdr[18]
                    b19 = 1 if hdr[19] == 2 else hdr[19]
                    os.pwrite(stage_fd, bytes([b18, b19]), 18)

                os.fchmod(stage_fd, 0o600)
                os.fsync(stage_fd)

                st_fd = os.fstat(stage_fd)
                st_path = os.stat(tmp_name, dir_fd=stage_dfd, follow_symlinks=False)
                if (
                    stat.S_ISLNK(st_path.st_mode)
                    or not stat.S_ISREG(st_path.st_mode)
                    or st_fd.st_dev != exp_dev
                    or st_fd.st_ino != exp_ino
                    or st_path.st_dev != exp_dev
                    or st_path.st_ino != exp_ino
                    or st_fd.st_nlink != 1
                    or st_path.st_nlink != 1
                    or st_fd.st_size < 100
                ):
                    raise OSError(errno.ELOOP, "staged backup inode/nlink verification failed after db.backup")

                send({
                    "ok": True,
                    "dev": str(exp_dev),
                    "ino": str(exp_ino),
                    "mode": st_fd.st_mode,
                    "nlink": st_fd.st_nlink,
                    "size": st_fd.st_size,
                })
            except OSError as e:
                wipe_err = wipe_stage_fd_strict()
                code = "ELOOP" if e.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)) else errno.errorcode.get(e.errno, "EIO")
                msg = str(e) if not wipe_err else f"{e} (cleanup wipe error: {wipe_err})"
                send({"ok": False, "code": code, "message": msg, "cleanupError": wipe_err, "cleanedUp": wipe_err is None})
                sys.exit(2)

        elif op == "verify_staged":
            try:
                st = os.stat(tmp_name, dir_fd=stage_dfd, follow_symlinks=False)
                st_fd = os.fstat(stage_fd)
                if (
                    stat.S_ISLNK(st.st_mode)
                    or not stat.S_ISREG(st.st_mode)
                    or st.st_dev != exp_dev
                    or st.st_ino != exp_ino
                    or st.st_nlink != 1
                    or st_fd.st_nlink != 1
                ):
                    raise OSError(errno.ELOOP, "staged backup file failed regular-file / nlink / dev-ino verification")
                send({"ok": True})
            except OSError as e:
                wipe_err = wipe_stage_fd_strict()
                msg = str(e) if not wipe_err else f"{e} (cleanup wipe error: {wipe_err})"
                send({"ok": False, "code": "ELOOP", "message": msg, "cleanupError": wipe_err, "cleanedUp": wipe_err is None})
                sys.exit(2)

        elif op == "publish":
            parent_path = cmd.get("parentPath", "")
            try:
                dir_fd_st = os.fstat(3)
                try:
                    parent_st = os.stat(parent_path, follow_symlinks=False)
                except OSError:
                    raise OSError(errno.ELOOP, "backup parent directory disappeared or became inaccessible before publish")
                if (
                    stat.S_ISLNK(parent_st.st_mode)
                    or not stat.S_ISDIR(parent_st.st_mode)
                    or parent_st.st_dev != dir_fd_st.st_dev
                    or parent_st.st_ino != dir_fd_st.st_ino
                ):
                    raise OSError(errno.ELOOP, "backup parent directory was replaced before publish")

                tmp_st = os.stat(tmp_name, dir_fd=stage_dfd, follow_symlinks=False)
                st_fd = os.fstat(stage_fd)
                if (
                    stat.S_ISLNK(tmp_st.st_mode)
                    or not stat.S_ISREG(tmp_st.st_mode)
                    or tmp_st.st_dev != exp_dev
                    or tmp_st.st_ino != exp_ino
                    or tmp_st.st_nlink != 1
                    or st_fd.st_nlink != 1
                ):
                    raise OSError(errno.ELOOP, "staging file inode changed before publish")

                rename_noreplace(stage_dfd, tmp_name, 3, dest_name)
                published = True
                send({"ok": True})
            except OSError as e:
                wipe_err = wipe_stage_fd_strict()
                code = "ELOOP" if e.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)) else errno.errorcode.get(e.errno, "EIO")
                msg = str(e) if not wipe_err else f"{e} (cleanup wipe error: {wipe_err})"
                send({"ok": False, "code": code, "message": msg, "cleanupError": wipe_err, "cleanedUp": wipe_err is None})
                sys.exit(2)

        elif op == "finalize":
            parent_path = cmd.get("parentPath", "")
            dir_fd_st = os.fstat(3)
            try:
                parent_st = os.stat(parent_path, follow_symlinks=False)
            except OSError:
                parent_st = None
            parent_ok = (
                parent_st is not None
                and not stat.S_ISLNK(parent_st.st_mode)
                and stat.S_ISDIR(parent_st.st_mode)
                and parent_st.st_dev == dir_fd_st.st_dev
                and parent_st.st_ino == dir_fd_st.st_ino
            )
            try:
                post_st = os.stat(dest_name, dir_fd=3, follow_symlinks=False)
            except OSError:
                post_st = None
            post_ok = (
                post_st is not None
                and not stat.S_ISLNK(post_st.st_mode)
                and stat.S_ISREG(post_st.st_mode)
                and post_st.st_dev == exp_dev
                and post_st.st_ino == exp_ino
            )
            # NOTE: NEVER unlink dest_name! POSIX lacks atomic inode-bound unlinkat; if a concurrent writer
            # replaced dest_name or parent_path was swapped during publish, wipe our own inode via stage_fd
            # and leave directory entries untouched.
            if not post_ok or not parent_ok:
                published = False
                wipe_err = wipe_stage_fd_strict()
                msg = (
                    "post-publish destination inode mismatch; leaving unknown destination entry untouched"
                    if not post_ok
                    else "backup parent directory was replaced during publish; staged inode wiped via descriptor"
                )
                if wipe_err:
                    msg = f"{msg} (cleanup wipe error: {wipe_err})"
                send({"ok": False, "code": "ELOOP", "message": msg, "cleanupError": wipe_err, "cleanedUp": wipe_err is None})
                sys.exit(2)

            try:
                os.close(stage_fd)
                stage_fd = -1
                os.close(stage_dfd)
                stage_dfd = -1
                # AT_REMOVEDIR: removes ONLY the now-empty 0700 staging directory; never deletes files or symlinks.
                os.rmdir(stage_dir_name, dir_fd=3)
                os.fsync(3)
                send({"ok": True})
                sys.exit(0)
            except OSError as e:
                code = errno.errorcode.get(e.errno, "EIO")
                send({"ok": False, "code": code, "message": str(e), "cleanedUp": False})
                sys.exit(2)

        elif op == "abort":
            wipe_err = wipe_stage_fd_strict()
            if wipe_err:
                send({"ok": False, "code": "EIO", "message": f"failed to zero aborted staging descriptor: {wipe_err}"})
                sys.exit(2)
            send({"ok": True})
            sys.exit(0)
finally:
    if not published and stage_fd >= 0 and not wiped:
        wipe_stage_fd_strict()
    if stage_fd >= 0:
        try:
            os.close(stage_fd)
        except OSError:
            pass
    if stage_dfd >= 0:
        try:
            os.close(stage_dfd)
        except OSError:
            pass
`;

function makeErrnoError(code, message, cause) {
  const err = new Error(message, cause !== undefined ? { cause } : undefined);
  err.code = code;
  return err;
}

function assertBareBasename(name, label) {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw makeErrnoError("EINVAL", `EINVAL: invalid ${label} basename: ${String(name)}`);
  }
}

function parentMatches(parentDir, expectedDirStatBigInt) {
  try {
    const st = lstatSync(parentDir, { bigint: true });
    return (
      !st.isSymbolicLink() &&
      st.isDirectory() &&
      st.dev === expectedDirStatBigInt.dev &&
      st.ino === expectedDirStatBigInt.ino
    );
  } catch {
    return false;
  }
}

function runDirFdHelper(dirFd, script, args) {
  const res = spawnSync(PYTHON_BIN, ["-c", script, ...args], {
    stdio: ["ignore", "pipe", "pipe", dirFd],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    throw res.error;
  }
  const stdoutText = res.stdout ? res.stdout.toString("utf8").trim() : "";
  const stderrText = res.stderr ? res.stderr.toString("utf8").trim() : "";
  let parsed = null;
  if (stdoutText !== "") {
    try {
      parsed = JSON.parse(stdoutText);
    } catch {
      parsed = null;
    }
  }
  if (res.status !== 0 || !parsed || parsed.ok !== true) {
    const code = parsed && typeof parsed.code === "string" ? parsed.code : "EIO";
    const msg =
      parsed && typeof parsed.message === "string"
        ? parsed.message
        : stderrText || stdoutText || `dir_fd helper exited with status ${String(res.status)}`;
    throw makeErrnoError(code, `${code}: ${msg}`);
  }
  return parsed;
}

function startBackupSession(dirFd, args) {
  // Spawn in the SAME POSIX session (never `detached: true` / `setsid()`, which triggers Darwin `killpg` EPERM
  // after the session leader is reaped!) while `PY_BACKUP_SESSION` immediately calls `os.setpgid(0, 0)` so
  // `child.pid` leads dedicated process group `-child.pid` covering both Python AND its child Node SQLite worker!
  const child = spawn(PYTHON_BIN, ["-u", "-c", PY_BACKUP_SESSION, ...args], {
    stdio: ["pipe", "pipe", "pipe", dirFd],
  });
  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lineQueue = [];
  const waiters = [];
  let closed = false;
  let spawnErr = null;
  let cleanedUpByHelper = false;

  child.on("error", (err) => {
    spawnErr = err;
    closed = true;
    while (waiters.length > 0) {
      waiters.shift().reject(err);
    }
  });
  rl.on("line", (line) => {
    if (waiters.length > 0) {
      waiters.shift().resolve(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) {
      waiters
        .shift()
        .reject(spawnErr ?? makeErrnoError("EIO", stderrBuf.trim() || "backup session closed unexpectedly"));
    }
  });

  const sendCommand = async (payload) => {
    if (spawnErr) throw spawnErr;
    if (closed && lineQueue.length === 0) {
      throw makeErrnoError("EIO", stderrBuf.trim() || "backup session already exited");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    const line =
      lineQueue.length > 0
        ? lineQueue.shift()
        : await new Promise((resolveLine, rejectLine) => {
            waiters.push({ resolve: resolveLine, reject: rejectLine });
          });
    const parsed = JSON.parse(line);
    if (!parsed || parsed.ok !== true) {
      if (parsed && parsed.cleanedUp === true) {
        cleanedUpByHelper = true;
      }
      const code = parsed && typeof parsed.code === "string" ? parsed.code : "EIO";
      const msg = parsed && typeof parsed.message === "string" ? parsed.message : stderrBuf.trim() || "backup helper error";
      throw makeErrnoError(code, `${code}: ${msg}`);
    }
    return parsed;
  };

  const waitExit = () =>
    new Promise((resolveExit, rejectExit) => {
      if (spawnErr) {
        rejectExit(spawnErr);
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit(child.exitCode ?? 128);
        return;
      }
      child.once("exit", (code) => resolveExit(code ?? 128));
      child.once("error", rejectExit);
    });

  const isAlive = () => !spawnErr && !closed && child.exitCode === null && child.signalCode === null;

  const signalProcessGroup = (sig) => {
    if (typeof child.pid !== "number" || child.pid <= 0) return "esrch";
    try {
      process.kill(-child.pid, sig);
      return "alive";
    } catch (err) {
      if (err && typeof err === "object" && err.code === "ESRCH") {
        return "esrch";
      }
      if (err && typeof err === "object" && err.code === "EPERM") {
        // On Darwin (XNU `killpg1`), a `SIGKILL`ed grandchild briefly in `SZOMB` while `launchd` reaps it
        // returns transient `EPERM` for ~1ms before transitioning to `ESRCH`.
        return "eperm";
      }
      throw err;
    }
  };

  const quiesceProcessGroup = async ({ forceKill = false } = {}) => {
    try {
      child.stdin.end();
    } catch {
      // Ignore stdin close error
    }
    if (forceKill) {
      signalProcessGroup("SIGKILL");
      if (typeof child.pid === "number" && child.pid > 0) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already exited
        }
      }
    }
    await waitExit();
    if (typeof child.pid === "number" && child.pid > 0) {
      let poll = 0;
      for (;;) {
        const state = signalProcessGroup(0);
        if (state === "esrch") {
          break;
        }
        if (state === "alive" && (forceKill || poll >= 25)) {
          signalProcessGroup("SIGKILL");
        }
        const delayMs = Math.min(20, 2 + Math.floor(poll / 25));
        poll += 1;
        await new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
      }
    }
  };

  return {
    pid: child.pid,
    isAlive,
    sendCommand,
    quiesceProcessGroup,
    wasCleanedUpByHelper: () => cleanedUpByHelper,
  };
}

/**
 * Online SQLite backup via `better-sqlite3` `db.backup(...)` with end-to-end inode-bound staging:
 * - Parent process pins both `dirFd` AND a surviving `parentStageFd` descriptor on the 0-byte staging inode BEFORE any SQLite page is copied.
 * - `db.backup(..., { progress })` verifies `sqlite3_open_v2` opened the exact `(dev, ino)` with `nlink === 1` on `progress(#1)` (`transfer(0)`) BEFORE writing 1 byte.
 * - Publishes via atomic non-replacing `renameatx_np` / `renameat2`, removes empty staging dir via `AT_REMOVEDIR`, and checks `fsync(dirFd)`.
 * - On any failure or abrupt helper death, parent directly wipes `parentStageFd` via `ftruncateSync(parentStageFd, 0)` + `fsyncSync(parentStageFd)` (zero `unlink` calls anywhere).
 */
export async function backupSqliteDatabase(sourcePathArg, destinationPathArg, options = {}) {
  const sourcePath = resolve(sourcePathArg);
  const destinationPath = resolve(destinationPathArg);
  if (sourcePath === destinationPath) {
    throw new Error("The backup destination must differ from the live database path.");
  }
  if (!existsSync(sourcePath)) {
    throw new Error(`Database does not exist: ${sourcePath}`);
  }

  const parentDir = dirname(destinationPath);
  const destBase = basename(destinationPath);
  assertBareBasename(destBase, "destination");

  // 1. Open and pin `dirFd` BEFORE database backup, rejecting symlinked or non-directory parents.
  const initialParentStat = lstatSync(parentDir, { bigint: true });
  if (initialParentStat.isSymbolicLink()) {
    throw makeErrnoError("ELOOP", `ELOOP: backup parent directory must not be a symbolic link: ${parentDir}`);
  }
  if (!initialParentStat.isDirectory()) {
    throw makeErrnoError("ENOTDIR", `ENOTDIR: backup parent path is not a directory: ${parentDir}`);
  }

  let dirFd;
  try {
    dirFd = openSync(
      parentDir,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err.code === "ELOOP" || err.code === "EMLINK")) {
      throw makeErrnoError("ELOOP", `ELOOP: backup parent directory must not be a symbolic link: ${parentDir}`, err);
    }
    try {
      if (lstatSync(parentDir).isSymbolicLink()) {
        throw makeErrnoError("ELOOP", `ELOOP: backup parent directory must not be a symbolic link: ${parentDir}`, err);
      }
    } catch (recheckErr) {
      if (recheckErr && typeof recheckErr === "object" && "code" in recheckErr && recheckErr.code === "ELOOP") {
        throw recheckErr;
      }
    }
    throw err;
  }

  const stageUuid = randomUUID();
  const stageDirName = `.flock-backup-stage-${process.pid}-${stageUuid}`;
  const tmpBase = `.flock-backup-${process.pid}-${stageUuid}.tmp`;
  assertBareBasename(stageDirName, "staging directory");
  assertBareBasename(tmpBase, "staging");
  const tmpPathForHook = join(parentDir, stageDirName, tmpBase);

  let session = null;
  let parentStageFd;
  let fdStatInternal = null;
  let finalized = false;
  let primaryError = null;

  try {
    const dirStat = fstatSync(dirFd, { bigint: true });
    if (!dirStat.isDirectory()) {
      throw makeErrnoError("ENOTDIR", `ENOTDIR: pinned backup parent descriptor is not a directory: ${parentDir}`);
    }
    if (dirStat.dev !== initialParentStat.dev || dirStat.ino !== initialParentStat.ino) {
      throw makeErrnoError("ELOOP", `ELOOP: backup parent directory ${parentDir} changed during open`);
    }

    // Fail fast with EEXIST inside `dirFd` if `destBase` already exists (regular file, directory, or live/dangling symlink).
    runDirFdHelper(dirFd, PY_CHECK_DEST_ABSENT, [destBase]);

    // Validate `sourcePath` is an initialized readable SQLite database (`page_count >= 1`) before creating any staging directory.
    const probeDb = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      probeDb.pragma("schema_version");
      const pageCount = Number(probeDb.pragma("page_count", { simple: true }));
      if (!Number.isInteger(pageCount) || pageCount < 1) {
        throw makeErrnoError("EIO", `EIO: source SQLite database is uninitialized (page_count=${String(pageCount)})`);
      }
    } finally {
      probeDb.close();
    }

    if (typeof options._duringSerialize === "function") {
      await options._duringSerialize(parentDir, destinationPath);
    }
    if (!parentMatches(parentDir, dirStat)) {
      throw makeErrnoError("ELOOP", `ELOOP: backup parent directory ${parentDir} was replaced before staging`);
    }

    // 2a. Pre-create `0o700` `stageDirName` + 0-byte `0o600` `stage_fd` inside `dirFd`, AND immediately acquire a surviving
    //     `parentStageFd` descriptor in THIS parent Node process BEFORE 1 single byte of SQLite data is copied!
    session = startBackupSession(dirFd, [
      stageDirName,
      tmpBase,
      destBase,
      process.execPath,
      REPO_PACKAGE_JSON,
      sourcePath,
      JS_CHILD_SQLITE_BACKUP,
    ]);

    const created = await session.sendCommand({ op: "create_stage" });
    const expDevBig = BigInt(created.dev);
    const expInoBig = BigInt(created.ino);

    if (typeof options._beforeParentStagePin === "function") {
      await options._beforeParentStagePin(tmpPathForHook);
    }

    let candidateStageFd;
    try {
      candidateStageFd = openSync(tmpPathForHook, fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (openErr) {
      throw makeErrnoError("ELOOP", "ELOOP: failed to pin parent staging descriptor without following symlinks", openErr);
    }
    try {
      const parentStageSt = fstatSync(candidateStageFd, { bigint: true });
      if (
        !parentStageSt.isFile() ||
        parentStageSt.dev !== expDevBig ||
        parentStageSt.ino !== expInoBig ||
        parentStageSt.nlink !== 1n ||
        parentStageSt.size !== 0n
      ) {
        throw makeErrnoError("ELOOP", "ELOOP: parent staging descriptor failed initial inode/nlink/zero-size verification");
      }
    } catch (verifyErr) {
      try {
        closeSync(candidateStageFd);
      } catch {
        // Ignore close error on rejected candidate descriptor.
      }
      throw verifyErr;
    }
    // Only assign `parentStageFd` AFTER kernel `(dev, ino, nlink === 1, size === 0)` matches `create_stage`'s private inode!
    parentStageFd = candidateStageFd;

    if (typeof options._beforeSqliteOpen === "function") {
      await options._beforeSqliteOpen(tmpPathForHook, session.pid);
    }

    // 2b. Stream pages online via `better-sqlite3` `sourceDb.backup(tmpBase, { progress })` inside `fchdir(stage_dfd)`,
    //     verifying on `progress(#1)` (`transfer(0)`) that `sqlite3_open_v2` opened `(expDev, expIno)` BEFORE writing 1 byte!
    const staged = await session.sendCommand({
      op: "run_backup",
      ...(typeof options._sqliteOpenHookUrl === "string" ? { hookUrl: options._sqliteOpenHookUrl } : {}),
      ...(typeof options._duringTransferHookUrl === "string"
        ? { duringTransferHookUrl: options._duringTransferHookUrl }
        : {}),
      ...(options._disablePpidSelfExit === true ? { disablePpidSelfExit: true } : {}),
    });
    fdStatInternal = {
      devStr: staged.dev,
      inoStr: staged.ino,
      publicStat: {
        dev: Number(staged.dev),
        ino: Number(staged.ino),
        mode: staged.mode,
        nlink: staged.nlink,
        size: staged.size,
      },
    };

    if (typeof options._afterTempFileWritten === "function") {
      await options._afterTempFileWritten(tmpPathForHook, fdStatInternal.publicStat, session.pid);
    }

    // 3. Verify `parentDir` still resolves to our pinned `dirFd` `(dev, ino)` and verify staged `(dev, ino)` / `nlink === 1`.
    if (!parentMatches(parentDir, dirStat)) {
      throw makeErrnoError("ELOOP", `ELOOP: backup parent directory ${parentDir} was replaced before publish`);
    }
    await session.sendCommand({ op: "verify_staged" });

    if (typeof options._betweenPreLinkStatAndLink === "function") {
      await options._betweenPreLinkStatAndLink(tmpPathForHook, fdStatInternal.publicStat);
    }
    if (typeof options._beforeLinkAt === "function") {
      await options._beforeLinkAt(tmpBase, parentDir);
    }

    // 4. Publish atomically via non-replacing `renameatx_np(..., RENAME_EXCL)` / `renameat2(..., RENAME_NOREPLACE)`.
    await session.sendCommand({ op: "publish", parentPath: parentDir });

    if (typeof options._afterLinkAt === "function") {
      await options._afterLinkAt(destinationPath);
    }

    // 5. Verify post-publish `destBase` + `parentDir` inodes, remove empty `stageDirName` via `AT_REMOVEDIR`, and strictly check `os.fsync(dirFd)`.
    await session.sendCommand({ op: "finalize", parentPath: parentDir });
    finalized = true;

    if (!parentMatches(parentDir, dirStat)) {
      finalized = false;
      throw makeErrnoError(
        "ELOOP",
        `ELOOP: backup parent directory ${parentDir} was replaced after finalize; staged inode wiped via parent descriptor`,
      );
    }
  } catch (err) {
    primaryError = err;
    throw err;
  } finally {
    let cleanupErr = null;
    if (!finalized) {
      let pendingAbortErr = null;
      if (session !== null && !session.wasCleanedUpByHelper() && session.isAlive()) {
        try {
          await session.sendCommand({ op: "abort" });
        } catch (abortErr) {
          pendingAbortErr = abortErr;
        }
      }
      // Strictly prove process-group quiescence (`ESRCH` on `-session.pid`) BEFORE executing `ftruncateSync`:
      // `ftruncateSync` is structurally inside this `try` block AFTER `await session.quiesceProcessGroup(...)`
      // returns, so truncation NEVER runs while any worker process could still be alive!
      let wipedViaParentFd = false;
      try {
        if (session !== null) {
          await session.quiesceProcessGroup({ forceKill: true });
        }
        if (fdStatInternal !== null && typeof options._beforeAbortCleanup === "function") {
          await options._beforeAbortCleanup(tmpPathForHook, fdStatInternal.publicStat);
        }
        if (parentStageFd !== undefined) {
          ftruncateSync(parentStageFd, 0);
          fsyncSync(parentStageFd);
          const wipedSt = fstatSync(parentStageFd, { bigint: true });
          if (wipedSt.size !== 0n) {
            throw makeErrnoError(
              "EIO",
              `EIO: staged backup inode remained non-empty (${String(wipedSt.size)} bytes) after truncation`,
            );
          }
          wipedViaParentFd = true;
        }
      } catch (quiesceOrWipeErr) {
        cleanupErr = quiesceOrWipeErr;
      }
      if (!wipedViaParentFd && !cleanupErr && pendingAbortErr) {
        cleanupErr = pendingAbortErr;
      }
    } else if (session !== null) {
      try {
        await session.quiesceProcessGroup({ forceKill: false });
      } catch (finQuiesceErr) {
        cleanupErr = finQuiesceErr;
      }
    }
    if (parentStageFd !== undefined) {
      try {
        closeSync(parentStageFd);
      } catch {
        // Ignore close error during unwind.
      }
    }
    try {
      closeSync(dirFd);
    } catch {
      // Ignore close error during unwind.
    }
    if (cleanupErr) {
      if (!primaryError) {
        throw cleanupErr;
      }
      if (primaryError instanceof Error) {
        primaryError.message = `${primaryError.message} (cleanup error: ${cleanupErr.message ?? String(cleanupErr)})`;
      }
    }
  }

  return destinationPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawArgs = process.argv.slice(2);
  const isGroupHost = rawArgs.includes("--group-host");
  const positionalArgs = rawArgs.filter((arg) => arg !== "--group-host");
  const unknownFlags = positionalArgs.filter((arg) => arg.startsWith("-"));
  if (unknownFlags.length > 0) {
    throw new Error(`Unknown option(s): ${unknownFlags.join(", ")}. Supported options: --group-host <destination>`);
  }

  const sourcePath = resolve(
    isGroupHost
      ? (process.env.GROUP_HOST_DATABASE_PATH ?? "./data/group-host.db")
      : (process.env.DATABASE_PATH ?? "./data/flock.db"),
  );
  const destinationArg = positionalArgs[0];
  if (!destinationArg) {
    throw new Error(
      isGroupHost
        ? "Pass a destination outside the application data directory, such as /secure/backups/group-host-2026-11-21.db."
        : "Pass a destination outside the application data directory, such as /secure/backups/slack-2026-09-24.db.",
    );
  }

  const publishedPath = await backupSqliteDatabase(sourcePath, destinationArg);
  process.stdout.write(
    `${isGroupHost ? "Group Host database" : "Database"} backup written to ${publishedPath}\n`,
  );
}
