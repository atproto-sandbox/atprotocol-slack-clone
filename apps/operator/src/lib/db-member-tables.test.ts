import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { closeDb, getRawDb } from "./db";

// The server's member session tables from before R6c: dropped, and the file rebuilt, even after a start that stopped midway.

const DIRECTORY = mkdtempSync(join(tmpdir(), "slack-db-member-tables-test-"));
const PATH = join(DIRECTORY, "old.db");
process.env.DATABASE_PATH = PATH;
process.env.AUTH_ENCRYPTION_KEY = "55".repeat(32);
process.env.APP_URL = "http://127.0.0.1:3000";
process.env.OPERATOR_SERVICE_REF = "did:web:operator.test#atproto_flock_operator";
after(() => {
  closeDb();
  rmSync(DIRECTORY, { recursive: true, force: true });
});

const MEMBER_TOKEN = "member-refresh-token-sentinel";
const fileHolds = (needle: string) => [PATH, `${PATH}-wal`].filter(existsSync).some((path) => readFileSync(path).includes(needle));

test("a start that dropped the member tables but stopped before rebuilding the file is finished by the next start", () => {
  // #given a database whose member session table was dropped without the rebuild, so its rows are still in free pages
  const legacy = new BetterSqlite3(PATH);
  legacy.exec("CREATE TABLE oauth_session (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const insert = legacy.prepare("INSERT INTO oauth_session (key, value, updated_at) VALUES (?, ?, ?)");
  for (let index = 0; index < 50; index += 1) insert.run(`did:plc:member${index}`, `${MEMBER_TOKEN}-${index}`, 1);
  legacy.exec("DROP TABLE oauth_session");
  legacy.close();
  assert.equal(fileHolds(MEMBER_TOKEN), true, "the dropped rows are still in the file");

  // #when the app opens it
  const db = getRawDb();

  // #then the file is rebuilt without them, and the rebuild is recorded so later starts skip it
  assert.equal(fileHolds(MEMBER_TOKEN), false);
  assert.ok(db.prepare("SELECT 1 FROM schema_migration WHERE version = 3").get());
});
