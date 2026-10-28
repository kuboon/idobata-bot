import { assertEquals } from "@std/assert";
import { createRouter } from "@remix-run/fetch-router";
import { init, InMemoryKeyRepository } from "@kuboon/dpop";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";

import { routes } from "../../../client/routes.ts";
import { openLocalDatabase } from "../../db/local.ts";
import { createMeController } from "./me.ts";

const ISSUER = "https://idp.test";

/** A stand-in for id.kbn.one: its signing key, and a way to issue its `/session` token. */
async function fakeIdp() {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  return {
    jwks: createLocalJWKSet({ keys: [jwk] }),
    token(
      sub: string,
      jkt: string,
      extra: Record<string, unknown> = {},
      issuer = ISSUER,
    ) {
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

async function setup() {
  await openLocalDatabase(":memory:");
  const idp = await fakeIdp();
  const router = createRouter();
  router.map(
    routes.api.me,
    createMeController({ jwks: idp.jwks, issuer: ISSUER }) as never,
  );
  const client = await init({
    keyStore: new InMemoryKeyRepository(),
    fetch: router.fetch.bind(router),
  });
  return { idp, router, ...client };
}

const url = (path: string) => `https://app.test${path}`;

Deno.test("/api/me without a DPoP proof is 401", async () => {
  const { router } = await setup();
  const res = await router.fetch(new Request(url("/api/me")));
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("/api/me with a proof but no token is 401", async () => {
  const { fetchDpop } = await setup();
  const res = await fetchDpop(url("/api/me"));
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "token: missing");
});

Deno.test("first sign-in creates the user with the IdP's nickname", async () => {
  const { idp, fetchDpop, thumbprint } = await setup();
  const token = await idp.token("user-1", thumbprint, { nickname: " 井戸端 " });
  const res = await fetchDpop(url("/api/me"), {
    headers: { authorization: `DPoP ${token}` },
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { id: "user-1", nickname: "井戸端" });
});

Deno.test("a missing IdP nickname becomes a placeholder", async () => {
  const { idp, fetchDpop, thumbprint } = await setup();
  const token = await idp.token("abc-123-def", thumbprint);
  const res = await fetchDpop(url("/api/me"), {
    headers: { authorization: `DPoP ${token}` },
  });
  assertEquals((await res.json()).nickname, "名無し-abc123");
});

Deno.test("a token bound to another key is rejected", async () => {
  const { idp, fetchDpop } = await setup();
  const token = await idp.token("user-1", "someone-elses-thumbprint");
  const res = await fetchDpop(url("/api/me"), {
    headers: { authorization: `DPoP ${token}` },
  });
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "token: not bound to this key");
});

Deno.test("a token from another issuer is rejected", async () => {
  const { idp, fetchDpop, thumbprint } = await setup();
  const token = await idp.token("user-1", thumbprint, {}, "https://evil.test");
  const res = await fetchDpop(url("/api/me"), {
    headers: { authorization: `DPoP ${token}` },
  });
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "token: invalid");
});

Deno.test("the nickname is this app's: changed here, kept over the IdP's", async () => {
  const { idp, fetchDpop, thumbprint } = await setup();
  const auth = (nickname: string) =>
    idp.token("user-1", thumbprint, { nickname }).then((t) => ({
      authorization: `DPoP ${t}`,
    }));

  await (await fetchDpop(url("/api/me"), { headers: await auth("最初") }))
    .body?.cancel();

  const updated = await fetchDpop(url("/api/me"), {
    method: "PATCH",
    headers: { ...(await auth("最初")), "content-type": "application/json" },
    body: JSON.stringify({ nickname: "  ここでの名前 " }),
  });
  assertEquals(await updated.json(), {
    id: "user-1",
    nickname: "ここでの名前",
  });

  // The IdP's nickname changed since; this app keeps its own.
  const again = await fetchDpop(url("/api/me"), {
    headers: await auth("IdP で変えた"),
  });
  assertEquals((await again.json()).nickname, "ここでの名前");
});

Deno.test("an empty or too-long nickname is a 400", async () => {
  const { idp, fetchDpop, thumbprint } = await setup();
  const token = await idp.token("user-1", thumbprint);
  for (const nickname of ["   ", "x".repeat(41), 42]) {
    const res = await fetchDpop(url("/api/me"), {
      method: "PATCH",
      headers: {
        authorization: `DPoP ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ nickname }),
    });
    assertEquals(res.status, 400);
    await res.body?.cancel();
  }
});
