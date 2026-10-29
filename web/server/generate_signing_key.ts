/**
 * Prints a fresh ES256 private key as a JWK — the form `lib/signing-key.ts` reads from
 * `RP_SIGNING_KEY_JWK`. `.github/workflows/rp-signing-key.yml` runs it and puts the output
 * straight into the Worker's secret, so the key is made in CI and only ever stored on Cloudflare.
 */

/** A fresh ES256 private key as a JWK, with only the key's own fields. */
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

if (import.meta.main) {
  console.log(JSON.stringify(await generateSigningJwk()));
}
