/**
 * The secrets file for `cf deploy --secrets-file`, written to stdout as JSON.
 *
 * Every `bindings.secret()` in `cloudflare.config.ts` has to be set before a deploy goes through,
 * so `.github/workflows/cloudflare.yml` runs this ahead of each deploy:
 *
 * - `RP_SIGNING_KEY_JWK` — generated here when the Worker does not have one yet, so the key is made
 *   in CI and only ever stored on Cloudflare. Once set it is left alone: a new key would change
 *   the JWKS the IdP checks our assertions against.
 * - `ANTHROPIC_API_KEY` — passed through when the repository has it as an Actions secret.
 *
 * Usage: `EXISTING_SECRETS="<cf workers secrets list output>" deno run -E deploy_secrets.ts`
 */

/** A fresh ES256 private key as a JWK — the form `lib/signing-key.ts` reads. */
export async function generateSigningJwk(): Promise<JsonWebKey> {
  const { privateKey } = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey(
    "jwk",
    privateKey,
  );
  return { kty, crv, x, y, d };
}

/**
 * The secrets to upload.
 *
 * @param existing What `cf workers secrets list` printed — only the names in it are looked at
 * @param anthropicApiKey The Actions secret, or empty
 */
export async function deploySecrets(
  existing: string,
  anthropicApiKey: string,
): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};
  if (!existing.includes("RP_SIGNING_KEY_JWK")) {
    secrets.RP_SIGNING_KEY_JWK = JSON.stringify(await generateSigningJwk());
  }
  if (anthropicApiKey) secrets.ANTHROPIC_API_KEY = anthropicApiKey;
  return secrets;
}

if (import.meta.main) {
  const secrets = await deploySecrets(
    Deno.env.get("EXISTING_SECRETS") ?? "",
    Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  );
  console.log(JSON.stringify(secrets));
}
