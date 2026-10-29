/**
 * Test helpers for the authenticated API: a stand-in for id.kbn.one, and a DPoP client.
 *
 * Only tests import this.
 */

import { init, InMemoryKeyRepository } from "@kuboon/dpop";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";

import type { RequireUserOptions } from "../middleware/auth.ts";

export const TEST_ISSUER = "https://idp.test";

/** The IdP's signing key, and a way to issue its `/session` token for a key. */
export async function fakeIdp() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const auth: RequireUserOptions = {
    jwks: createLocalJWKSet({ keys: [jwk] }),
    issuer: TEST_ISSUER,
  };
  return {
    /** What `requireUser()` needs to trust this IdP. */
    auth,
    token(
      sub: string,
      jkt: string,
      extra: Record<string, unknown> = {},
      issuer = TEST_ISSUER,
    ): Promise<string> {
      return new SignJWT({ cnf: { jkt }, ...extra })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(issuer)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey);
    },
  };
}

/** A browser's DPoP key, signing requests to `router` — `fetchDpop` and its `thumbprint`. */
export function dpopClientFor(
  router: { fetch(request: Request): Promise<Response> },
) {
  return init({
    keyStore: new InMemoryKeyRepository(),
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      router.fetch(new Request(input, init)),
  });
}

/** An absolute URL on the app, as a proof's `htu` needs. */
export const appUrl = (path: string): string => `https://app.test${path}`;
