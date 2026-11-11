import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { closeDb } from "../lib/db";
import {
  consumeCreationAuthorization, CREATION_AUTHORIZATION_SECONDS, CreationNotAuthorizedError, grantCreationAuthorization, restoreCreationAuthorization,
} from "./creation-authorization";

const AUTHORITY = "did:plc:workspaceaccount";
const CREATOR = "did:plc:creator";
const T0 = 1_800_000_000;
let directory = "";

before(() => {
  directory = mkdtempSync(join(tmpdir(), "creation-authorization-test-"));
  process.env.DATABASE_PATH = join(directory, "authorization.db");
  process.env.AUTH_ENCRYPTION_KEY = "36".repeat(32);
  process.env.OPERATOR_SERVICE_REF = "did:web:localhost%3A3000#atproto_flock_operator";
  process.env.APP_URL = "http://127.0.0.1:3000";
});
after(() => {
  closeDb();
  rmSync(directory, { recursive: true, force: true });
});

const approval = (name: string) => ({ authorityDid: AUTHORITY, initiatorDid: CREATOR, name });
const refused = (action: () => void) => assert.throws(action, CreationNotAuthorizedError);

test("an approval creates its one workspace once, for its one person", () => {
  grantCreationAuthorization(approval("Once"), T0);
  refused(() => consumeCreationAuthorization({ ...approval("Once"), initiatorDid: "did:plc:someoneelse" }, "2222222222222", T0));
  refused(() => consumeCreationAuthorization(approval("Twice"), "2222222222222", T0));
  consumeCreationAuthorization(approval("Once"), "2222222222222", T0);
  refused(() => consumeCreationAuthorization(approval("Once"), "2222222222223", T0));
});

test("an approval that is not used expires after 15 minutes", () => {
  grantCreationAuthorization(approval("Late"), T0);
  refused(() => consumeCreationAuthorization(approval("Late"), "3333333333333", T0 + CREATION_AUTHORIZATION_SECONDS));
});

test("a restored approval serves only its operation, and expires 15 minutes after it was restored", () => {
  grantCreationAuthorization(approval("Restored"), T0);
  consumeCreationAuthorization(approval("Restored"), "4444444444444", T0);
  restoreCreationAuthorization(approval("Restored"), "4444444444444", T0 + 600);
  refused(() => consumeCreationAuthorization(approval("Restored"), "4444444444445", T0 + 600));
  refused(() => consumeCreationAuthorization(approval("Restored"), "4444444444444", T0 + 600 + CREATION_AUTHORIZATION_SECONDS));

  restoreCreationAuthorization(approval("Restored"), "4444444444444", T0 + 600);
  consumeCreationAuthorization(approval("Restored"), "4444444444444", T0 + 600 + CREATION_AUTHORIZATION_SECONDS - 1);
});

test("a new flow for the same workspace replaces the earlier approval, for any one operation again", () => {
  grantCreationAuthorization(approval("Again"), T0);
  consumeCreationAuthorization(approval("Again"), "5555555555555", T0);
  restoreCreationAuthorization(approval("Again"), "5555555555555", T0);
  grantCreationAuthorization(approval("Again"), T0 + 60);
  consumeCreationAuthorization(approval("Again"), "5555555555556", T0 + 60);
});
