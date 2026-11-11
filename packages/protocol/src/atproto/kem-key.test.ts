import assert from "node:assert/strict";
import test from "node:test";
import { P256Keypair, Secp256k1Keypair, bytesToMultibase, parseDidKey } from "@atproto/crypto";
import { KemKeyError, cacheKemKeys, kemKeyFromDidDocument } from "./kem-key";

const DID = "did:plc:author";

async function p256() {
  const keypair = await P256Keypair.create();
  return { keypair, didKey: keypair.did(), multikey: keypair.did().slice("did:key:".length), compressed: parseDidKey(keypair.did()).keyBytes };
}

test("a Multikey #atproto_kem method yields the did:key of that key", async () => {
  const { didKey, multikey } = await p256();
  assert.equal(kemKeyFromDidDocument(DID, { verificationMethod: [{ id: `${DID}#atproto_kem`, type: "Multikey", controller: DID, publicKeyMultibase: multikey }] }), didKey);
});

test("the older EcdsaSecp256r1VerificationKey2019 type, whose multibase is the bare compressed point, yields the same did:key", async () => {
  const { didKey, compressed } = await p256();
  const method = { id: `${DID}#atproto_kem`, type: "EcdsaSecp256r1VerificationKey2019", controller: DID, publicKeyMultibase: bytesToMultibase(compressed, "base58btc") };
  assert.equal(kemKeyFromDidDocument(DID, { verificationMethod: [method] }), didKey);
});

test("the relative id form and other methods in the document are handled", async () => {
  const { didKey, multikey } = await p256();
  const signing = await p256();
  const document = { verificationMethod: [
    { id: `${DID}#atproto`, type: "Multikey", publicKeyMultibase: signing.multikey },
    { id: "#atproto_kem", type: "Multikey", publicKeyMultibase: multikey },
  ] };
  assert.equal(kemKeyFromDidDocument(DID, document), didKey, "the signing key is never mistaken for the KEM key");
});

test("a missing method, a missing key, an unknown type and a non-P-256 key are each refused with the DID named", async () => {
  const k256 = (await Secp256k1Keypair.create()).did().slice("did:key:".length);
  const cases: Array<[unknown, RegExp]> = [
    [{}, /lists no #atproto_kem/],
    [{ verificationMethod: [{ id: `${DID}#atproto`, type: "Multikey", publicKeyMultibase: k256 }] }, /lists no #atproto_kem/],
    [{ verificationMethod: [{ id: `${DID}#atproto_kem`, type: "Multikey" }] }, /no publicKeyMultibase/],
    [{ verificationMethod: [{ id: `${DID}#atproto_kem`, type: "JsonWebKey2020", publicKeyMultibase: "zabc" }] }, /not a P-256 key type/],
    [{ verificationMethod: [{ id: `${DID}#atproto_kem`, type: "Multikey", publicKeyMultibase: k256 }] }, /not a P-256 key/],
    [{ verificationMethod: [{ id: `${DID}#atproto_kem`, type: "Multikey", publicKeyMultibase: "not-multibase" }] }, /not a P-256 key/],
    [{ verificationMethod: [{ id: `${DID}#atproto_kem`, type: "EcdsaSecp256r1VerificationKey2019", publicKeyMultibase: "not-multibase" }] }, /could not be decoded/],
  ];
  for (const [document, pattern] of cases) {
    assert.throws(() => kemKeyFromDidDocument(DID, document as { verificationMethod?: unknown }), (error) => error instanceof KemKeyError && pattern.test(error.message) && error.message.includes(DID));
  }
});

test("cacheKemKeys resolves a key once per lifetime and again only on expiry or an explicit refresh", async () => {
  let clock = 0;
  const loads: Array<{ did: string; forceRefresh: boolean }> = [];
  const resolve = cacheKemKeys(async (did, forceRefresh) => { loads.push({ did, forceRefresh }); return `key-${loads.length}`; }, { ttlMs: 1_000, maxEntries: 2, now: () => clock });
  assert.equal(await resolve("did:plc:a", false), "key-1");
  assert.equal(await resolve("did:plc:a", false), "key-1", "served from the cache");
  assert.equal(loads.length, 1);
  assert.equal(await resolve("did:plc:a", true), "key-2", "a forced refresh loads again and replaces the entry");
  assert.deepEqual(loads.at(-1), { did: "did:plc:a", forceRefresh: true });
  assert.equal(await resolve("did:plc:a", false), "key-2");
  clock = 1_001;
  assert.equal(await resolve("did:plc:a", false), "key-3", "an expired entry is loaded again");
});

test("cacheKemKeys keeps at most maxEntries keys, dropping the oldest, and does not cache a failure", async () => {
  let fail = true;
  const loads: string[] = [];
  const resolve = cacheKemKeys(async (did) => { loads.push(did); if (fail) throw new Error("down"); return `key-${did}`; }, { ttlMs: 60_000, maxEntries: 2 });
  await assert.rejects(resolve("did:plc:a", false), /down/);
  fail = false;
  await resolve("did:plc:a", false);
  await resolve("did:plc:b", false);
  await resolve("did:plc:c", false);
  loads.length = 0;
  await resolve("did:plc:c", false);
  await resolve("did:plc:b", false);
  assert.deepEqual(loads, [], "the two newest are still cached");
  await resolve("did:plc:a", false);
  assert.deepEqual(loads, ["did:plc:a"], "the oldest was dropped");
});
