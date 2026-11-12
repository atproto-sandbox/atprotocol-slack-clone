import assert from "node:assert/strict";
import test from "node:test";
import { expectedChannelList, expectedInboxList, expectedWorkspaceList, listMatches, type AppInstall } from "./membership";

const AUTHORITY = "did:plc:authority";
const ADMIN = "did:plc:admin";
const PERSON = "did:plc:person";
const BOT = "did:plc:bot";
const ROSTER = new Set([AUTHORITY, ADMIN, PERSON]);
const install = (channels: Record<string, boolean>): AppInstall => ({
  subject: BOT, active: true, channels: new Map(Object.entries(channels)), installedBy: ADMIN, installedAt: "2026-11-11T00:00:00.000Z",
});
const INSTALLS = new Map([[BOT, install({ "acme-general": true, "acme-secret": false })]]);
const RW = { read: true, write: true };

test("the workspace space holds every person, reading and writing, and every active app, reading only", () => {
  assert.deepEqual(expectedWorkspaceList(ROSTER, INSTALLS), new Map([[BOT, { read: true, write: false }], [AUTHORITY, RW], [ADMIN, RW], [PERSON, RW]]));
});

test("the inbox holds every person as a writer and the admins as readers too, and no app", () => {
  assert.deepEqual(expectedInboxList(ROSTER, new Set([ADMIN])), new Map([
    [AUTHORITY, { read: false, write: true }], [ADMIN, { read: true, write: true }], [PERSON, { read: false, write: true }],
  ]));
});

test("a public channel holds the roster and the apps granted it, with their grant's bits", () => {
  assert.deepEqual(expectedChannelList({ skey: "acme-general", visibility: "public" }, ROSTER, new Set(), INSTALLS), new Map([
    [BOT, RW], [AUTHORITY, RW], [ADMIN, RW], [PERSON, RW],
  ]));
  assert.deepEqual(expectedChannelList({ skey: "acme-random", visibility: "public" }, ROSTER, new Set(), INSTALLS).has(BOT), false, "an ungranted channel");
});

test("a private channel holds its roster's people who are still on the workspace roster, and the apps granted it", () => {
  assert.deepEqual(expectedChannelList({ skey: "acme-secret", visibility: "private" }, ROSTER, new Set([PERSON, "did:plc:gone"]), INSTALLS), new Map([
    [BOT, { read: true, write: false }], [PERSON, RW],
  ]));
});

test("an archived channel holds nobody, an app granted it included", () => {
  assert.deepEqual(expectedChannelList({ skey: "acme-general", visibility: "archived" }, ROSTER, new Set([PERSON]), INSTALLS), new Map());
});

test("a member list matches when it holds exactly the expected entries and bits, the authority and bitless entries aside", () => {
  const expected = expectedWorkspaceList(ROSTER, INSTALLS);
  const listed = [{ did: BOT, read: true, write: false }, { did: ADMIN, ...RW }, { did: PERSON, ...RW }];
  assert.equal(listMatches(expected, listed, AUTHORITY), true, "the authority owns the space and is not listed");
  assert.equal(listMatches(expected, [...listed, { did: AUTHORITY, ...RW }, { did: "did:plc:left", read: false, write: false }], AUTHORITY), true);
  assert.equal(listMatches(expected, listed.filter((member) => member.did !== BOT), AUTHORITY), false, "an app missing");
  assert.equal(listMatches(expected, [...listed.filter((member) => member.did !== BOT), { did: BOT, ...RW }], AUTHORITY), false, "an app with write it was not granted");
  assert.equal(listMatches(expected, [...listed, { did: "did:plc:stranger", ...RW }], AUTHORITY), false, "someone unexpected");
  assert.equal(listMatches(expected, [...listed.filter((member) => member.did !== PERSON), { did: PERSON, read: true, write: false }], AUTHORITY), false, "a person who cannot write");
});
