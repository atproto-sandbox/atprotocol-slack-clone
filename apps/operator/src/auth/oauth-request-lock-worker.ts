import { appendFileSync } from "node:fs";
import { oauthSqliteRequestLock } from "./oauth-request-lock";

const label = process.env.OAUTH_LOCK_TEST_LABEL;
const logPath = process.env.OAUTH_LOCK_TEST_LOG;
if (label !== "child" || !logPath) throw new Error("OAuth lock test worker is missing its fixture environment.");

await oauthSqliteRequestLock("@atproto-oauth-client-did:plc:alice", async () => {
  appendFileSync(logPath, "child:start\n");
  await new Promise((resolve) => setTimeout(resolve, 25));
  appendFileSync(logPath, "child:end\n");
});
