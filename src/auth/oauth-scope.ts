const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;
const MAX_OAUTH_SCOPE_BYTES = 128 * 1024;

export function canonicalOAuthScope(scopes: string | readonly string[]): string {
  const sourceBytes = typeof scopes === "string"
    ? Buffer.byteLength(scopes, "utf8")
    : scopes.reduce((total, scope) => total + Buffer.byteLength(scope, "utf8") + 1, 0);
  if (sourceBytes > MAX_OAUTH_SCOPE_BYTES) throw new Error("OAuth scope is too large.");
  const items: readonly string[] = typeof scopes === "string" ? scopes.split(" ") : scopes;
  const tokens = items
    .flatMap((scope) => scope.split(" "))
    .filter(Boolean);
  if (!tokens.length || tokens.some((scope) => !SCOPE_TOKEN.test(scope))) {
    throw new Error("Invalid OAuth scope.");
  }
  const canonical = [...new Set(tokens)].sort().join(" ");
  if (!canonical.split(" ").includes("atproto")) throw new Error('OAuth scope must include "atproto".');
  if (Buffer.byteLength(canonical, "utf8") > MAX_OAUTH_SCOPE_BYTES) throw new Error("OAuth scope is too large.");
  return canonical;
}
