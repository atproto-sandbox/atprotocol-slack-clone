import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Lexicons, parseLexiconDoc, type LexiconDoc } from "@atproto/lexicon";
import { IncludeScope } from "@atproto/oauth-scopes";
import { schemaDict, schemas } from "./lexicons/api/lexicons";
import { VENDORED_PERMISSION_SETS, expandGroupScopes } from "./scopes";

const LEXICONS_ROOT = fileURLToPath(new URL("../lexicons", import.meta.url));
const GENERATED_TYPES_ROOT = fileURLToPath(new URL("./lexicons/api/types", import.meta.url));

function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function walkJsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJsonFiles(full));
    else if (entry.name.endsWith(".json")) out.push(full);
  }
  return out;
}

/**
 * Complete 99-file SHA-256 manifest: all 27 `group.opensocial.*` lexicons (`8df0cc82`) +
 * all 72 `com.atproto.*` lexicons (`6747610566`).
 */
const UPSTREAM_99_MANIFEST: Readonly<Record<string, string>> = {
  "com/atproto/identity/getRecommendedDidCredentials.json": "f222de8a6a87aa75760b658fc0d061ad8b533cf49eb4e52631043f3d9a9300d3",
  "com/atproto/identity/requestPlcOperationSignature.json": "90f4faaa6cf88a35b3ad5d1bad50be4a72cf9350ca6cec117c98175ef2faa39a",
  "com/atproto/identity/resolveHandle.json": "d1cdbbc2a1a89d905228e0dc65546a140bd96262c60c4756e51027597ec5ebea",
  "com/atproto/identity/signPlcOperation.json": "33595630e559b08cb1d421ab2d3cfb8787a200ffd30676c338fd0a08ba2da266",
  "com/atproto/identity/submitPlcOperation.json": "85b03138ecb20308d468ca492332e95d9765c100b88694493600139ee4d13753",
  "com/atproto/label/defs.json": "b20ed39fa5530ff62a6b4bfbbd7a3648dd57896db7c9c7ac379e1bfc64d1f724",
  "com/atproto/label/record.json": "1c7e1325afc9746f53904e139280321a51854b45afe0eadfef8c9670f4dd73eb",
  "com/atproto/managedspace/checkAccess.json": "2282def2199fbe989e9bfd48f81f7dc1a8c5f98a785a75a81b741f71d5de9e8b",
  "com/atproto/managedspace/policy.json": "5d66a81339fdfe752a2025c82721f96b3f454760a4c9aee7311f837b5bb1d2eb",
  "com/atproto/memberspace/defs.json": "02cabde76bf547736650f29eaf728545b695951ecf79963a2da054e780098da8",
  "com/atproto/memberspace/listMembers.json": "0de1ee80beca3b1331e0bb245463455c99cff0f7f288dd25875f132ddca84db6",
  "com/atproto/memberspace/member.json": "d43b013786484c436c0eab6c8d8748aa9415c5b82dfa07e8fb6f7c57f69f5902",
  "com/atproto/memberspace/policy.json": "49dda366c729b9ce99cf1f1a6290bbebb9eb50093786549807e25d5791e6e269",
  "com/atproto/memberspace/putMembers.json": "1fd710fc15322a3343959a759c0fa23ee27bc67cd5b7be8ced5005865a70e5fd",
  "com/atproto/memberspace/removeMembers.json": "8b99d78b67c5c6e94e1cbcc0cbab500c4d4c88e2308871b95c3460b25e66af88",
  "com/atproto/personalspace/policy.json": "7f9e3663b4abff578621bf284e247a1bc3711d9be10f1f6798ddcdb7479c2151",
  "com/atproto/repo/applyWrites.json": "ee3d49d4b289200d2a6d48c931dc19956ed2e5fb937ec341ebbf023c35697aa9",
  "com/atproto/repo/createRecord.json": "33280437597bf6dd8232a8ebd1b001a151e9b52817f9812abe1b505b0b192dac",
  "com/atproto/repo/defs.json": "9806986fa3b0bca206b52e2869fb4a586441253139bff4189d2e526d1a2306df",
  "com/atproto/repo/deleteRecord.json": "4b7fa4d5907da32bc53897200e0197c63eba6a7e9411a9031ac1b6a4828e6276",
  "com/atproto/repo/describeRepo.json": "e9fa5f3461cbf1e9bfae4aab4c64893a0211125855371734ea4ab387e59f621b",
  "com/atproto/repo/getRecord.json": "d61aee451f284dd251b3451d16826e75f2bf8a6af32705120e1f67a3db4df8ff",
  "com/atproto/repo/importRepo.json": "242a447ae3932f87839a358464cc2980fff4b02f9b61b80550cac6c757337444",
  "com/atproto/repo/listMissingBlobs.json": "6ecb53e7cc67061b1abc35758e9f7f58edcfa4dd453b65032b297cfe4102b7b8",
  "com/atproto/repo/listRecords.json": "d862390bf7b25d7f41b113570380320ce96ada19a529b4f50d88f509a7b20b5c",
  "com/atproto/repo/putRecord.json": "3132c3b46ba530c367dc066ce263e6e1d405c4f2e91ed995bfc2d2fb654e50d7",
  "com/atproto/repo/strongRef.json": "2d27ecc2a09a86b5065c36e36b987ef726a814023c5e198a1eda8e4c283714e0",
  "com/atproto/repo/uploadBlob.json": "ca55fcb2572db51556488a5c0f3912ab192369904c25d142a46a41052552ced0",
  "com/atproto/server/activateAccount.json": "0d50bac92845f7ef9609ed864391833ce1f7e76e88e46d3357108789617ce6c6",
  "com/atproto/server/checkAccountStatus.json": "d694f1cfba0a5f0669a30d8f8b692dbf1a5401475ba8940647940b7a010d22fd",
  "com/atproto/server/createAccount.json": "e05e794757311175199ec9a7c8fe37a9d240f3a538c6eec032edc86438f2bb05",
  "com/atproto/server/deactivateAccount.json": "6d54c0cf63050de6b6a0253a5a9869fbf577f14db5e19570b547fa4cb3e0c0ab",
  "com/atproto/server/deleteAccount.json": "291bcefb62da099a80cabeff03177cdb1f4fda499a278f4ec9d21e6cc1a86bfe",
  "com/atproto/server/describeServer.json": "bfe9afbd9bd7b6e758720a3744470c94fc2bb7d611d6b46b39abccf5ad1eff88",
  "com/atproto/server/getServiceAuth.json": "3a623f89b9d7dc39f7a13a10e13e797cd12ee97ea2a08f793e30ff6aeb1ee3d0",
  "com/atproto/server/refreshSession.json": "d2de6665d92e4ee055ab400a54484ab24530baedfb5b9b35bb19329f27141437",
  "com/atproto/server/requestAccountDelete.json": "d1ad16786c18d19df962c041a0c1da456e0af912eed8caa523243da8ef4b8f10",
  "com/atproto/space/applyWrites.json": "e9b12ecedbe621926c18e96e684664d32501c697216fce85d865548fefc13ce8",
  "com/atproto/space/authorizeSpaceSync.json": "d89c97d120e5b0406eaebe17080ea2b7dbf444aeb23e6cacb9b0465150a9302f",
  "com/atproto/space/clearRecords.json": "e936c432daee91c0695f2808c160dc745a517aed7d51ee960587a39e760abd95",
  "com/atproto/space/confirmRegistration.json": "2106ca2cc0b65904598c897ae9f2b073291e848062defedb83b407bce6c5bfc4",
  "com/atproto/space/createRecord.json": "68096c1db83b3bf5ae838484838736f8d9cd11b36af4c7d85f137247fa09df3e",
  "com/atproto/space/createSpace.json": "2170fbc10ef8131be1b84a2cff43bc4da22672ef5a453e7d1a9abe3a2926a88b",
  "com/atproto/space/defs.json": "5c2bd0a2b56cee247134130c4e1ef0a77a06bb17b31acbb4c215ff115ce30773",
  "com/atproto/space/deleteRecord.json": "716d5630574ec436cbcfdd2f0cf6135f8ad755d824a04687c6b6a2c0e2d3f35e",
  "com/atproto/space/deleteSpace.json": "75c6495e3869746b8a8938329fec799f888c29dc48cb66c7c27b99958bbc7851",
  "com/atproto/space/exportSpaceMeta.json": "4b0143467d32f6df11f0777aad1136b4d54810ef7e3e755bc205bf4161c8d821",
  "com/atproto/space/getBlob.json": "c4b7e9d9655a54060fe8a3f994e046912c49d15e4f956220b63389788b4b239b",
  "com/atproto/space/getDelegationToken.json": "4c9c967a9164ac8419908cff9eda9c661b017c1659bdea5b7418c8651c1a8bea",
  "com/atproto/space/getLatestCommit.json": "d10bcef517f3d2237a867ecd022bfe522db5550054f3b591f8bdd0df5fb7ff70",
  "com/atproto/space/getRecord.json": "82cd42abe407daf001891ed32cf3df6aedadac8f14f0107e1fadbfbf91c20319",
  "com/atproto/space/getRepo.json": "aa6a648ebeb197f094993aa1554aa42ee592a93f7edb2c28a9ca76899823e47a",
  "com/atproto/space/getSpace.json": "9503dda8858ddb56577e4ce7b836a0de3609df47349136178a2754971808ef52",
  "com/atproto/space/importRepo.json": "5086b676d0b42da622c1f7b158c70b49de82b523ab595b8a356df604509a09ca",
  "com/atproto/space/importSpaceMeta.json": "5fa87e92673c1999fcf71a6d1cbc8710374dac18e431842f458246db17a00dfa",
  "com/atproto/space/listBlobs.json": "68fb2a89a22a6b12602267a0cbc4172328c319a1923e867b6242b1c0ebce7282",
  "com/atproto/space/listRecords.json": "7250f33ebc9fc390066f60f9998955e7cfc4af6c071dfc5351268a2a90902de1",
  "com/atproto/space/listRepoOps.json": "df2e295a1ff4a4c257b60f50d8057f0e50b57a80721f4e73d094b89e5b4ad703",
  "com/atproto/space/listSpaces.json": "c00ce606a5c33216500f56efa1455dfa598f00ba8a13309f7e9ab607d7b4f6f6",
  "com/atproto/space/listWriters.json": "578ee071717ed69138ceb0a2ff35612c7886ece24c0e504b473ec63ae7eab235",
  "com/atproto/space/notifyCredentialsRevoked.json": "76912fbb0fb4f0fe502369677c248c20961a423b26979695a018aacd60c5a3a2",
  "com/atproto/space/notifyRepoUpdate.json": "da73df5dc5c842691bf22df263069c4f8efc35bb5166938ee1212a017655a9f2",
  "com/atproto/space/notifySpaceUpdate.json": "5923893c9d567669029be5e6a6b6f7cd2527362473d1878786d01ed4c91dd7a7",
  "com/atproto/space/policy.json": "7bb190b2ad91a583eda91133879a61519de994538112ba2fd0ed3343e00696a5",
  "com/atproto/space/putRecord.json": "f26555cdaf69705f7cfa8b15392bb916d9600cebd7eff7b12671524b1e43161e",
  "com/atproto/space/removeWriter.json": "252bc3b82d70fe62d18f34c5f7e938debfe22e684f81e1e8773e015d4d6b40b5",
  "com/atproto/space/updateSpace.json": "474f1204e34eb9de4dcb4129e0dc6db62d55a5a3c012fba21646662b08b43230",
  "com/atproto/sync/getBlob.json": "aaed9c4f39fe76a0eec90afd8635e5e2a655575e85f752cb6d8ae50be4057421",
  "com/atproto/sync/getLatestCommit.json": "698b4028ce312d629948ea6efe7eebe1e543fc7d3d289ee5a7966825d1f5856c",
  "com/atproto/sync/getRepo.json": "c16b1b22bef031f0456d90cd4b4f648bc12ea1b3b9918eeb53177362875ee5fa",
  "com/atproto/sync/getRepoStatus.json": "389167313a4e806c422ff2bbbd3e9a6190ad4480b57afd97354610b4c6020927",
  "com/atproto/sync/listBlobs.json": "26671c6ff5946f09ec633019d20dc3fe8c86af7675f3f9666397f25f8d69d7f1",
  "group/opensocial/acceptance.json": "d0a66c1c73b972f5b8dd16a14f8dc8a2b6c6301f6e05b5c18df4f9fb24dba4c6",
  "group/opensocial/authManageGroup.json": "c38b0c0fbbafd74585002c21fc8e8e1861d77de7564456f90e2cbe512d64f48b",
  "group/opensocial/authManageProfile.json": "5b05ba56fd5037c3a5bbb362d9b5d628e50afea373cb1f13a5917059a257dcf8",
  "group/opensocial/authModerate.json": "9dde4909c6259d3c4b466c47da3f39219eab43545558fd8b89076e5206a2f406",
  "group/opensocial/authParticipate.json": "17e44fcc7a9a8a0550118e2a8c942f21366bb840de95de070cb48df72c784a37",
  "group/opensocial/cancelJoinRequest.json": "4e69f74aed3ce81c6974ebf95e4be66b05e306e5506c8dd7ff47f24b49b2da38",
  "group/opensocial/createReport.json": "1f574f5cafc97525bca1957d3d1335b0e9e05e864e9065140d61470d631c07ff",
  "group/opensocial/declaration.json": "b51f8a0f5c8974ba5c51c3767d9fba49bcf28bb1525d1430191c618ef16fe23d",
  "group/opensocial/defs.json": "46232e72bdf08a1e2357c5ea34e548d098aaaeeb6062130e4133ad8914dff2ed",
  "group/opensocial/denyJoinRequest.json": "c2493e174bf77e75d04740517a4721dfea6197683182d4419b523403000cbdbf",
  "group/opensocial/getModSubjectHistory.json": "8cb37e3134e4364f5b5eb0f5f4056b359ad86eba66e004bda3aa39e2d5c4c2a4",
  "group/opensocial/invite.json": "602467af04826cac5442f1c23eb63fc67a18a76d2fe5683eee4b87bcd7eaf6ac",
  "group/opensocial/invites.json": "cff0ed1f0a9d6a0059ac29f9f4701eb02cc2e642e1f7138d6d1a21813c18a5ee",
  "group/opensocial/labeler.json": "fcbc1f53d861d8cef4f1ff02b23885a6cb73446bfa33b728c069aca18e82c031",
  "group/opensocial/leaveGroup.json": "06199d872e2b02d94ae6f4dca9c370198aa8b848011368d79032684cd9f01c2b",
  "group/opensocial/listJoinRequests.json": "ac7e75e8fee2d95c3036947cb7fa43f80d2a2d69f628a88c06b8c7e6e2b6769b",
  "group/opensocial/listModSubjects.json": "e3a3c24a166f085d706acde57bf9ffbdbe924d6c6cfb5ec088d2cf0eee9a5580",
  "group/opensocial/members.json": "de1cec21993f15bcc2e965110a981f207298015831b30eef75c38b1aa97392f2",
  "group/opensocial/membership.json": "a493baa3c0994e7b379da0db35b52fb43ffffc5b33144b02dd6f79d3cf9bd3f2",
  "group/opensocial/meta.json": "faf25ee619a423ffc65e15f715580947c0df6cf0e30d0af8ae616d1a6ba3d127",
  "group/opensocial/policy.json": "af2f0733394a52b0ee4b611ec383553c1a0cae187a79cb31d22ced19ff8f4b3d",
  "group/opensocial/profile.json": "60f9ed90a2dd7826c400ca91919897106fd8dd16ac7ef3becd876b5cc4aa47e5",
  "group/opensocial/requestJoin.json": "683fc3e514f98dda71c0cba0961f52fbe6c3968cbde6b0aa07c0ce94163b2f81",
  "group/opensocial/resolveModSubject.json": "103c9d4a0c79f935af301ea10aaddcb6184f8b0ca876e3bf6d43d66e735f21c6",
  "group/opensocial/role.json": "ade62d51b78c568cef7b82f470b9891e5a28596c28645226726634be02d54cce",
  "group/opensocial/rule.json": "13349f5c27e3ec2176bc50ed8c1b5f01f77c07be5c9826d507d98aaf871507d0",
  "group/opensocial/space.json": "e5a34c4cf59cedf33873a886c73d4cd6ec8acd7e5149930c1927d462ee4854bc",
};

/**
 * Explicit XRPC route-schema manifest covering every XRPC NSID in §3.1's Group Host route matrix + Operator methods.
 */
const ROUTE_SCHEMA_MANIFEST: readonly string[] = [
  "com.atproto.server.describeServer",
  "com.atproto.identity.resolveHandle",
  "com.atproto.sync.getRepoStatus",
  "com.atproto.sync.getLatestCommit",
  "com.atproto.sync.getRepo",
  "com.atproto.sync.listBlobs",
  "com.atproto.sync.getBlob",
  "com.atproto.repo.describeRepo",
  "com.atproto.repo.getRecord",
  "com.atproto.repo.listRecords",
  "com.atproto.repo.createRecord",
  "com.atproto.repo.putRecord",
  "com.atproto.repo.deleteRecord",
  "com.atproto.repo.applyWrites",
  "com.atproto.repo.uploadBlob",
  "com.atproto.repo.importRepo",
  "com.atproto.repo.listMissingBlobs",
  "com.atproto.server.createAccount",
  "com.atproto.server.refreshSession",
  "com.atproto.server.checkAccountStatus",
  "com.atproto.server.activateAccount",
  "com.atproto.server.deactivateAccount",
  "com.atproto.server.getServiceAuth",
  "com.atproto.server.requestAccountDelete",
  "com.atproto.server.deleteAccount",
  "com.atproto.identity.getRecommendedDidCredentials",
  "com.atproto.identity.submitPlcOperation",
  "com.atproto.identity.requestPlcOperationSignature",
  "com.atproto.identity.signPlcOperation",
  "com.atproto.space.createSpace",
  "com.atproto.space.getSpace",
  "com.atproto.space.updateSpace",
  "com.atproto.space.deleteSpace",
  "com.atproto.space.removeWriter",
  "com.atproto.space.exportSpaceMeta",
  "com.atproto.space.importSpaceMeta",
  "com.atproto.space.importRepo",
  "com.atproto.space.putRecord",
  "com.atproto.space.createRecord",
  "com.atproto.space.applyWrites",
  "com.atproto.space.deleteRecord",
  "com.atproto.space.clearRecords",
  "com.atproto.space.getDelegationToken",
  "com.atproto.space.listSpaces",
  "com.atproto.space.authorizeSpaceSync",
  "com.atproto.space.listWriters",
  "com.atproto.space.getRecord",
  "com.atproto.space.listRecords",
  "com.atproto.space.getLatestCommit",
  "com.atproto.space.listRepoOps",
  "com.atproto.space.getRepo",
  "com.atproto.space.getBlob",
  "com.atproto.space.listBlobs",
  "com.atproto.space.notifyRepoUpdate",
  "com.atproto.space.notifyCredentialsRevoked",
  "com.atproto.space.confirmRegistration",
  "com.atproto.space.notifySpaceUpdate",
  "group.opensocial.requestJoin",
  "group.opensocial.cancelJoinRequest",
  "group.opensocial.leaveGroup",
  "group.opensocial.createReport",
  "group.opensocial.listJoinRequests",
  "group.opensocial.denyJoinRequest",
  "group.opensocial.listModSubjects",
  "group.opensocial.getModSubjectHistory",
  "group.opensocial.resolveModSubject",
  "new.flock.operator.execute",
  "new.flock.operator.getOperation",
  "new.flock.operator.getChanges",
  "new.flock.operator.createWorkspace",
  "new.flock.operator.startAuthorityFlow",
  "new.flock.operator.listStalledOperations",
  "new.flock.operator.getDmNotifyTarget",
  "new.flock.operator.getSpaceNotifyTarget",
];

const UPSTREAM_EXAMPLE_RECORDS: ReadonlyArray<{ collection: string; value: Record<string, unknown> }> = [
  {
    collection: "group.opensocial.declaration",
    value: {
      $type: "group.opensocial.declaration",
      meta: "at://did:plc:abcdefghijklmnopqrstuvwx/space/group.opensocial.meta/self",
    },
  },
  {
    collection: "group.opensocial.profile",
    value: {
      $type: "group.opensocial.profile",
      displayName: "Neighborhood Garden",
      description: "A group for local gardeners.",
      joinPolicy: "approval",
      url: "https://garden.example.com/",
    },
  },
  {
    collection: "group.opensocial.rule",
    value: {
      $type: "group.opensocial.rule",
      title: "Be considerate",
      text: "Treat other members with respect.",
      order: 0,
    },
  },
  {
    collection: "group.opensocial.role",
    value: {
      $type: "group.opensocial.role",
      displayName: "Admin",
      scopes: [
        "include:group.opensocial.authManageGroup",
        "space:*?collection=com.atproto.label.record",
        "space:*?manage=update",
        "space:*?manage=create&manage=delete",
      ],
      assignable: ["*"],
    },
  },
  {
    collection: "group.opensocial.labeler",
    value: {
      $type: "group.opensocial.labeler",
      policies: {
        labelValues: ["!hide", "spoiler"],
        labelValueDefinitions: [
          {
            identifier: "spoiler",
            severity: "none",
            blurs: "content",
            locales: [{ lang: "en", name: "Spoiler", description: "Reveals plot details." }],
          },
        ],
      },
      reasonTypes: ["rude", "other"],
      subjectTypes: ["account", "record"],
    },
  },
  {
    collection: "group.opensocial.space",
    value: {
      $type: "group.opensocial.space",
      space: "at://did:plc:abcdefghijklmnopqrstuvwx/space/group.opensocial.meta/self",
      createdAt: "2026-09-29T12:00:00.000Z",
    },
  },
  {
    collection: "group.opensocial.membership",
    value: {
      $type: "group.opensocial.membership",
      roles: ["member"],
      createdAt: "2026-09-29T12:00:00.000Z",
    },
  },
  {
    collection: "group.opensocial.acceptance",
    value: {
      $type: "group.opensocial.acceptance",
      createdAt: "2026-09-29T12:00:00.000Z",
    },
  },
  {
    collection: "com.atproto.space.policy",
    value: {
      $type: "com.atproto.space.policy",
      policy: {
        $type: "group.opensocial.policy",
        grants: [
          { role: "member", read: true, write: true },
          { role: "moderator", read: true, write: true },
        ],
      },
    },
  },
  {
    collection: "com.atproto.label.record",
    value: {
      $type: "com.atproto.label.record",
      uri: "did:plc:zyxwvutsrqponmlkjihgfedcb",
      val: "!hide",
      cts: "2026-09-29T12:00:00.000Z",
    },
  },
  {
    collection: "group.opensocial.invite",
    value: {
      $type: "group.opensocial.invite",
      createdAt: "2026-09-29T12:00:00.000Z",
      expiresAt: "2026-10-29T12:00:00.000Z",
      message: "Join our gardening group.",
    },
  },
];

test("all 99 upstream-vendored lexicons (27 group.opensocial.* + 72 com.atproto.*) match pinned SHA-256 digests", () => {
  const actualFiles = [
    ...walkJsonFiles(join(LEXICONS_ROOT, "group/opensocial")),
    ...walkJsonFiles(join(LEXICONS_ROOT, "com/atproto")),
  ]
    .map((full) => relative(LEXICONS_ROOT, full).split(sep).join(posix.sep))
    .sort();

  const expectedFiles = Object.keys(UPSTREAM_99_MANIFEST).sort();
  assert.equal(expectedFiles.length, 99);
  assert.equal(expectedFiles.filter((f) => f.startsWith("group/opensocial/")).length, 27);
  assert.equal(expectedFiles.filter((f) => f.startsWith("com/atproto/")).length, 72);
  assert.deepEqual(actualFiles, expectedFiles);

  for (const rel of expectedFiles) {
    const actualDigest = sha256Hex(readFileSync(join(LEXICONS_ROOT, rel)));
    assert.equal(actualDigest, UPSTREAM_99_MANIFEST[rel], `SHA-256 mismatch on vendored lexicon ${rel}`);
  }

  // Retired Flock memberspace governance lexicons must remain absent
  for (const retired of [
    "new/flock/workspace/profile.json",
    "new/flock/workspace/roster.json",
    "new/flock/admin.json",
    "new/flock/acceptance.json",
    "new/flock/channel/roster.json",
    "new/flock/permissions/workspaceAuthority.json",
    "new/flock/operator/listInboxWriters.json",
  ]) {
    assert.equal(existsSync(join(LEXICONS_ROOT, retired)), false, `Retired lexicon must not exist: ${retired}`);
  }
});

test("all 72 com.atproto.* lexicons match ATPROTO_PIN_CHECKOUT byte-for-byte when pin is set", (t) => {
  const checkout = process.env.ATPROTO_PIN_CHECKOUT ?? process.env.ATPROTO_PINNED_CHECKOUT;
  if (!checkout) {
    t.skip("ATPROTO_PIN_CHECKOUT not set");
    return;
  }
  const pinLexRoot = join(resolve(checkout), "lexicons");
  for (const rel of Object.keys(UPSTREAM_99_MANIFEST).filter((f) => f.startsWith("com/atproto/"))) {
    const vendoredBytes = readFileSync(join(LEXICONS_ROOT, rel));
    const upstreamBytes = readFileSync(join(pinLexRoot, rel));
    assert.equal(sha256Hex(vendoredBytes), sha256Hex(upstreamBytes), `Drift against ATPROTO_PIN_CHECKOUT in ${rel}`);
  }
});

test("route-schema manifest: every XRPC route NSID has one registered LexiconDoc in schemaDict and one generated type module", () => {
  const docsById = new Map<string, { id: string }>();
  for (const doc of schemas as ReadonlyArray<{ id: string }>) {
    assert.equal(docsById.has(doc.id), false, `Duplicate schemaDict entry for ${doc.id}`);
    docsById.set(doc.id, doc);
  }
  assert.equal(Object.keys(schemaDict).length, schemas.length);

  for (const nsid of ROUTE_SCHEMA_MANIFEST) {
    assert.ok(docsById.has(nsid), `Missing ${nsid} from generated schemaDict`);
    const typeRel = `${nsid.replaceAll(".", "/")}.ts`;
    assert.equal(
      existsSync(join(GENERATED_TYPES_ROOT, typeRel)),
      true,
      `Missing generated type module for ${nsid} at ${typeRel}`,
    );
  }
});

test("structural @atproto/lexicon, @atproto/oauth-scopes #atproto_pds audience, and upstream example record validation", () => {
  const allDocs: LexiconDoc[] = walkJsonFiles(LEXICONS_ROOT).map((full) =>
    parseLexiconDoc(JSON.parse(readFileSync(full, "utf8"))),
  );
  const lex = new Lexicons(allDocs);
  assert.ok(allDocs.length >= 115);

  for (const example of UPSTREAM_EXAMPLE_RECORDS) {
    const res = lex.validate(example.collection, example.value);
    assert.equal(res.success, true, `${example.collection} example failed validation: ${res.success ? "" : res.error.message}`);
  }

  // Verify all 4 OpenSocial permission sets expand cleanly with canonical `${groupDid}#atproto_pds` RPC audience
  const groupDid = "did:plc:abcdefghijklmnopqrstuvwx";
  const groupPdsAud = `${groupDid}#atproto_pds` as const;
  for (const nsid of [
    "group.opensocial.authParticipate",
    "group.opensocial.authManageProfile",
    "group.opensocial.authModerate",
    "group.opensocial.authManageGroup",
  ] as const) {
    const inc = IncludeScope.fromString(`include:${nsid}`);
    assert.ok(inc, `IncludeScope parsed ${nsid}`);
    const expanded = inc.toScopes(VENDORED_PERMISSION_SETS[nsid]!);
    assert.ok(expanded.length > 0, `${nsid} expanded to non-empty scopes`);
    const perms = expandGroupScopes([`include:${nsid}`], groupDid);
    if (nsid === "group.opensocial.authParticipate") {
      assert.equal(perms.allowsRpc({ aud: groupPdsAud, lxm: "group.opensocial.requestJoin" }), true);
    }
    if (nsid === "group.opensocial.authModerate" || nsid === "group.opensocial.authManageGroup") {
      assert.equal(perms.allowsRpc({ aud: groupPdsAud, lxm: "group.opensocial.listModSubjects" }), true);
    }
  }
});

test("pinned @atproto/lex-schema LexiconDocument validation passes across all vendored schemas when ATPROTO_PIN_CHECKOUT is set", async (t) => {
  const checkout = process.env.ATPROTO_PIN_CHECKOUT ?? process.env.ATPROTO_PINNED_CHECKOUT;
  if (!checkout) {
    t.skip("ATPROTO_PIN_CHECKOUT not set");
    return;
  }
  const builderDist = join(resolve(checkout), "packages/lex/lex-builder/dist/index.js");
  if (!existsSync(builderDist)) {
    t.skip("lex-builder dist not present");
    return;
  }
  const script = `
    import { readFileSync } from "node:fs";
    const mod = await import(${JSON.stringify(pathToFileURL(builderDist).href)});
    const files = ${JSON.stringify(walkJsonFiles(LEXICONS_ROOT))};
    if (typeof mod.LexiconSchemaBuilder?.buildAll === "function") {
      const rawDocs = files.map((full) => JSON.parse(readFileSync(full, "utf8")));
      mod.LexiconSchemaBuilder.buildAll(rawDocs);
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
});
