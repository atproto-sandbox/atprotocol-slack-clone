import { JoseKey } from "@atproto/jwk-jose";
import { revokeAuthorityGrant } from "@/operator/authority-grant";
import { isDid } from "@/protocol/keys";

// Operator actions for the workspace-authority grant (docs/operations.md, "Workspace authority grant"):
//   generate-key <kid>   print a new private ES256 JWK to add to the "keys" array of AUTHORITY_CLIENT_PRIVATE_JWKS
//   revoke <did>         sign the authority's grant out at its PDS and delete it

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === "generate-key" && argument && /^[A-Za-z0-9_-]{1,64}$/.test(argument)) {
    const key = await JoseKey.generate(["ES256"], argument);
    process.stdout.write(`${JSON.stringify(key.privateJwk)}\n`);
    return;
  }
  if (command === "revoke" && argument && isDid(argument)) {
    try {
      const outcome = await revokeAuthorityGrant(argument);
      process.stdout.write({
        none: `No authority grant is held for ${argument}.\n`,
        revoked: `Revoked the authority grant of ${argument}.\n`,
        deleted: `Deleted the authority grant of ${argument}; it could not be decrypted, so there was no session to sign out.\n`,
      }[outcome]);
    } catch (error) {
      // The grant is deleted before its PDS is asked to sign it out, so the operator no longer holds it either way.
      process.stderr.write(`Deleted the authority grant of ${argument}, but signing it out at its PDS failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
      process.exitCode = 1;
    }
    return;
  }
  process.stderr.write("Usage: pnpm authority generate-key <kid> | pnpm authority revoke <did>\n");
  process.exitCode = 2;
}

await main();
