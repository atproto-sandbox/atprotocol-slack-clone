import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { getScriptNonceFromHeader } from "next/dist/server/app-render/get-script-nonce-from-header";
import { proxy } from "./proxy";

test("every page gets a script policy with a nonce of its own, which Next finds in the request it renders", () => {
  // #given two requests for the app's page
  const first = proxy(new NextRequest("http://127.0.0.1:3000/"));
  const second = proxy(new NextRequest("http://127.0.0.1:3000/"));
  const policy = first.headers.get("content-security-policy") ?? "";

  // #then the response's policy carries a nonce Next's own parser finds, of 128 bits, and no two requests share one
  const nonce = getScriptNonceFromHeader(policy);
  assert.equal(nonce?.length, 24);
  assert.notEqual(getScriptNonceFromHeader(second.headers.get("content-security-policy") ?? ""), nonce);

  // #then the request Next renders carries the same policy, so its scripts get that nonce
  assert.equal(first.headers.get("x-middleware-request-content-security-policy"), policy);
});
