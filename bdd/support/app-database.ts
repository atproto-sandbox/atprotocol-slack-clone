import Database from "better-sqlite3";
import { MEMBER_SESSION_TABLES } from "@/lib/db";

/**
 * Which tables of the server's member session an app's database has (`MEMBER_SESSION_TABLES`: sessions, OAuth state, and
 * the channel content and cursors it synced for members). Since sign-in moved to the browser, none.
 */
export function memberSessionTablesIn(databasePath: string): string[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name));
    return MEMBER_SESSION_TABLES.filter((table) => present.has(table));
  } finally {
    db.close();
  }
}
