import { assert, assertEquals } from "@std/assert";

import { deploySecrets } from "./deploy_secrets.ts";

Deno.test("a missing signing key is generated in the form the Worker loads", async () => {
  const secrets = await deploySecrets("", "");
  assertEquals(Object.keys(secrets), ["RP_SIGNING_KEY_JWK"]);
  const jwk = JSON.parse(secrets.RP_SIGNING_KEY_JWK) as JsonWebKey;
  assertEquals(Object.keys(jwk).sort(), ["crv", "d", "kty", "x", "y"]);
  // The same import `lib/signing-key.ts` does.
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  assert(key.type === "private");
});

Deno.test("an existing signing key is left alone; the API key passes through", async () => {
  const existing = '[{"name":"RP_SIGNING_KEY_JWK","type":"secret_text"}]';
  assertEquals(await deploySecrets(existing, ""), {});
  assertEquals(await deploySecrets(existing, "sk-test"), {
    ANTHROPIC_API_KEY: "sk-test",
  });
});
