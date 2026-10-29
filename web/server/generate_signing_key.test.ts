import { assert, assertEquals } from "@std/assert";

import { generateSigningJwk } from "./generate_signing_key.ts";

Deno.test("the generated key loads the way the Worker loads it", async () => {
  const jwk = await generateSigningJwk();
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
