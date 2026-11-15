import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceClient } from "./workspace-client";

const APP = "did:plc:app";

/** A WorkspaceClient over a transport whose hosts answer with `answer`, and whose own host resolves handles from `handles`. */
function client(answer: (url: URL) => Response, handles: Record<string, string> = {}) {
  const requests: string[] = [];
  const transport = {
    did: "did:plc:admin",
    resolvePds: async () => "https://pds.example",
    fetchEndpoint: async (request: Request) => { requests.push(request.url); return answer(new URL(request.url)); },
    memberClient: { query: async (_method: string, params: { handle: string }) => {
      if (!handles[params.handle]) throw Object.assign(new Error("Unable to resolve handle"), { status: 400 });
      return { did: handles[params.handle] };
    } },
  };
  return { workspaces: new WorkspaceClient({ transport, credentials: {}, lifecycle: {} } as never), requests };
}

test("an app's declaration is read from its own repo, and an account without a valid one has none", async () => {
  const declared = client(() => Response.json({ value: { $type: "new.flock.app.declaration", name: "Echo", createdAt: "2026-11-11T12:00:00.000Z" } }));
  assert.deepEqual(await declared.workspaces.appDeclaration(APP), { name: "Echo" });
  assert.match(declared.requests[0]!, /^https:\/\/pds\.example\/xrpc\/com\.atproto\.repo\.getRecord\?repo=did%3Aplc%3Aapp&collection=new\.flock\.app\.declaration&rkey=self$/);
  assert.equal(await client(() => Response.json({ error: "RecordNotFound" }, { status: 400 })).workspaces.appDeclaration(APP), null, "a person");
  assert.equal(await client(() => Response.json({ value: { $type: "new.flock.app.declaration", name: "" } })).workspaces.appDeclaration(APP), null, "an invalid one");
  await assert.rejects(client(() => Response.json({ error: "InternalServerError" }, { status: 500 })).workspaces.appDeclaration(APP), /Could not read/);
});

test("an account an admin types is a DID as it is, or a handle its host resolves", async () => {
  const { workspaces } = client(() => Response.json({}), { "echo.example.com": APP });
  assert.equal(await workspaces.resolveAccount(" did:plc:app "), APP);
  assert.equal(await workspaces.resolveAccount("@echo.example.com"), APP);
  await assert.rejects(workspaces.resolveAccount("nobody.example.com"), /Unable to resolve/);
});
