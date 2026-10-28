/**
 * Who is calling: the DPoP key every request carries, and the id.kbn.one user behind it.
 *
 * There is no session on this side (docs/design.md §3). The browser signs every API request with
 * its DPoP key, and once signed in also sends the IdP's token: `Authorization: DPoP <jws>`, where
 * `jws` is what `${IDP_ORIGIN}/session` returned — an ES256 JWT whose `cnf.jkt` is that same key's
 * thumbprint. Two middlewares check that, in order:
 *
 * - {@link dpopClient}, on every API route: the `DPoP` proof is valid for this method and URL,
 *   fresh, and not replayed. Its key's thumbprint is the caller's identity even when signed out
 *   (a chat ticket is bound to it).
 * - {@link requireUser}, on routes that need a person: the token verifies against the IdP's JWKS
 *   and is bound to the key that signed the proof. The user's row is created on first sight, with
 *   the IdP's nickname as the starting value of this app's own.
 */

import { createContextKey, type Middleware } from "@remix-run/fetch-router";
import { computeThumbprint } from "@kuboon/dpop/common.ts";
import { verifyDpopProofFromRequest } from "@kuboon/dpop/server.ts";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { sql } from "@remix-run/data-table";

import { getConfig } from "../config.ts";
import { getDb } from "../db/mod.ts";
import { now, users } from "../db/schema.ts";

/** The DPoP key a request was signed with. */
export interface Client {
  readonly thumbprint: string;
}
export const Client = createContextKey<Client>();

/** The signed-in user, as this app knows them. */
export interface User {
  /** The IdP's userId. */
  readonly id: string;
  /** This app's nickname for them — see {@link nicknameFrom}. */
  readonly nickname: string;
}
export const User = createContextKey<User>();

/** Longest nickname, matching id.kbn.one's own limit. */
export const NICKNAME_MAX_LENGTH = 40;

function unauthorized(error: string): Response {
  return Response.json({ error }, {
    status: 401,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Remembers proof `jti`s for as long as a proof is accepted, so each is good for one request.
 *
 * Per isolate, which is the gap: a replay that lands on another isolate gets through. The proof is
 * bound to one method and URL and lives five minutes, so what a replay can do is repeat that one
 * request. A shared store (KV) can replace this without touching the callers.
 */
export function createReplayDetector(ttlSeconds: number) {
  const seen = new Map<string, number>();
  return (jti: string): boolean => {
    const at = Date.now();
    if (seen.size > 10_000) {
      for (const [key, expires] of seen) if (expires < at) seen.delete(key);
    }
    if ((seen.get(jti) ?? 0) > at) return false;
    seen.set(jti, at + ttlSeconds * 1000);
    return true;
  };
}

const MAX_AGE_SECONDS = 300;
const CLOCK_SKEW_SECONDS = 60;

/**
 * Verifies the request's `DPoP` proof and records the key on the context as {@link Client}.
 *
 * @returns The middleware; it answers `401` itself when the proof is missing or bad
 */
export function dpopClient(): Middleware<
  { key: typeof Client; value: Client }
> {
  const checkReplay = createReplayDetector(
    MAX_AGE_SECONDS + CLOCK_SKEW_SECONDS,
  );
  return async (context, next) => {
    const result = await verifyDpopProofFromRequest(context.request, {
      maxAgeSeconds: MAX_AGE_SECONDS,
      clockSkewSeconds: CLOCK_SKEW_SECONDS,
      checkReplay,
    });
    if (!result.valid) return unauthorized(`dpop: ${result.error}`);
    context.set(Client, { thumbprint: await computeThumbprint(result.jwk) });
    return next();
  };
}

/** How {@link requireUser} checks the IdP's token. */
export interface RequireUserOptions {
  /** The IdP's signing keys. Defaults to `${IDP_ORIGIN}/.well-known/jwks.json`. */
  readonly jwks?: JWTVerifyGetKey;
  /** The token's expected `iss`. Defaults to `IDP_ORIGIN`. */
  readonly issuer?: string;
}

/**
 * Requires a signed-in user: verifies `Authorization: DPoP <jws>` and records {@link User}.
 *
 * Must run after {@link dpopClient}, whose thumbprint the token has to be bound to.
 *
 * @param options Where the IdP's keys come from — tests pass a local key set
 * @returns The middleware; it answers `401` itself when the token is missing or bad
 */
export function requireUser(
  options: RequireUserOptions = {},
): Middleware<{ key: typeof User; value: User }> {
  const { idpOrigin } = getConfig();
  const issuer = options.issuer ?? idpOrigin;
  let jwks = options.jwks;

  return async (context, next) => {
    const client = context.get(Client) as Client | undefined;
    if (!client) throw new Error("requireUser() must run after dpopClient()");

    const match = /^DPoP\s+(\S+)$/i.exec(
      context.request.headers.get("authorization") ?? "",
    );
    if (!match) return unauthorized("token: missing");

    jwks ??= createRemoteJWKSet(new URL("/.well-known/jwks.json", idpOrigin));
    let payload;
    try {
      ({ payload } = await jwtVerify(match[1], jwks, { issuer }));
    } catch {
      return unauthorized("token: invalid");
    }
    const cnf = payload.cnf as { jkt?: unknown } | undefined;
    if (typeof payload.sub !== "string" || cnf?.jkt !== client.thumbprint) {
      return unauthorized("token: not bound to this key");
    }

    context.set(User, await ensureUser(payload.sub, payload.nickname));
    return next();
  };
}

/**
 * The user's row, created on first sight.
 *
 * The nickname starts as the IdP's and is this app's own from then on: a later change on the IdP
 * does not overwrite what the user set here (docs/design.md §5).
 */
async function ensureUser(id: string, idpNickname: unknown): Promise<User> {
  const db = getDb();
  const existing = await db.find(users, id);
  if (existing) return { id, nickname: existing.nickname };

  const nickname = nicknameFrom(idpNickname, id);
  const at = now();
  // Two first requests can race here; the second one's insert is a no-op rather than an error.
  await db.exec(sql`
    INSERT INTO users (id, nickname, role, created_at, updated_at)
    VALUES (${id}, ${nickname}, NULL, ${at}, ${at})
    ON CONFLICT (id) DO NOTHING
  `);
  return { id, nickname: (await db.find(users, id))?.nickname ?? nickname };
}

/**
 * A usable nickname from whatever the IdP had: its value trimmed to the limit, or a placeholder
 * with a short piece of the userId so two unnamed people do not look identical.
 */
export function nicknameFrom(value: unknown, userId: string): string {
  const trimmed = typeof value === "string"
    ? value.trim().slice(0, NICKNAME_MAX_LENGTH)
    : "";
  return trimmed || `名無し-${userId.replace(/[^A-Za-z0-9]/g, "").slice(0, 6)}`;
}
