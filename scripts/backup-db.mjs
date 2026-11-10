import nextEnv from "@next/env";
import BetterSqlite3 from "better-sqlite3";
import { chmodSync, closeSync, existsSync, openSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const sourcePath = resolve(process.env.DATABASE_PATH ?? "./data/flock.db");
const destinationArg = process.argv[2];
if (!destinationArg) {
  throw new Error("Pass a destination outside the application data directory, such as /secure/backups/slack-2026-09-24.db.");
}
const destinationPath = resolve(destinationArg);
if (sourcePath === destinationPath) throw new Error("The backup destination must differ from the live database path.");
if (!existsSync(sourcePath)) throw new Error(`Database does not exist: ${sourcePath}`);

// Create the backup exclusively with owner-only permissions before SQLite
// writes sensitive operator and workspace metadata into it.
const destinationDescriptor = openSync(destinationPath, "wx", 0o600);
closeSync(destinationDescriptor);
let completed = false;
try {
  const db = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destinationPath);
  } finally {
    db.close();
  }
  chmodSync(destinationPath, 0o600);
  completed = true;
} finally {
  if (!completed && existsSync(destinationPath)) unlinkSync(destinationPath);
}

process.stdout.write(`Database backup written to ${destinationPath}\n`);
