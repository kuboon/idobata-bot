/**
 * The owner's remote MCP server at `/mcp` (docs/architecture.md §11).
 *
 * An OAuth 2.1 resource server whose authorization server is the IdP (id.kbn.one): an MCP client
 * finds the IdP from this server's RFC 9728 metadata — linked from the `401` challenge — has the
 * user sign in there with a passkey, and calls `/mcp` with the IdP's access token. The token is an
 * ES256 JWT (`typ: at+jwt`) whose `aud` is this server's `/mcp` URL (RFC 8707) and whose `sub` is
 * the same user ID the web's sign-in gives.
 *
 * Serving is `@modelcontextprotocol/server`'s web-standard `createMcpHandler`: a fresh server per
 * request (`tools.ts`, built for the token's user), stateless, so it runs on Workers as is.
 */

import { createController } from "@remix-run/fetch-router";
import {
  type AuthInfo,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { routes } from "../../client/routes.ts";
import { getConfig } from "../config.ts";
import { ownerServer } from "./tools.ts";

/** The scope the IdP issues for MCP. */
const SCOPE = "mcp";

export interface McpOptions {
  /** The IdP's signing keys. Defaults to `${IDP_ORIGIN}/.well-known/jwks.json`. */
  readonly jwks?: JWTVerifyGetKey;
  /** The token's expected `iss`, and the authorization server the metadata names. Defaults to `IDP_ORIGIN`. */
  readonly issuer?: string;
}

/** The IdP's access tokens: signed by it, of the access-token type, for some user. */
function idpVerifier(
  jwks: JWTVerifyGetKey,
  issuer: string,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer, typ: "at+jwt" }));
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid token");
      }
      const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
      if (typeof payload.sub !== "string" || typeof aud !== "string") {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "invalid token");
      }
      return {
        token,
        clientId: String(payload.client_id ?? ""),
        scopes: String(payload.scope ?? "").split(" ").filter(Boolean),
        expiresAt: payload.exp,
        // Compared with this server's URL by the bearer gate (RFC 8707 audience binding).
        resource: new URL(aud),
        extra: { userId: payload.sub },
      };
    },
  };
}

/**
 * The MCP endpoint and its metadata, with the IdP's keys injectable for tests.
 *
 * The server's resource identifier is `/mcp` on the origin the request came to, so the same code
 * serves production, previews and local development.
 */
export function createMcpController(options: McpOptions = {}) {
  const issuer = options.issuer ?? getConfig().idpOrigin;
  let jwks = options.jwks;

  const handler = createMcpHandler(({ authInfo }) => {
    const userId = authInfo?.extra?.userId;
    if (typeof userId !== "string") throw new Error("no authenticated user");
    return ownerServer(userId);
  });

  const resourceOf = (request: Request) =>
    new URL(routes.mcp.post.href(), request.url);

  const serve = async ({ request }: { request: Request }) => {
    jwks ??= createRemoteJWKSet(new URL("/.well-known/jwks.json", issuer));
    const resource = resourceOf(request);
    const gate = requireBearerAuth({
      verifier: idpVerifier(jwks, issuer),
      expectedResource: resource,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    });
    const authInfo = await gate(request);
    if (authInfo instanceof Response) return authInfo;
    return handler.fetch(request, { authInfo });
  };

  return createController(routes.mcp, {
    actions: {
      post: serve,
      get: serve,
      remove: serve,
      /** RFC 9728: where an MCP client learns to get a token from the IdP. */
      metadata({ request }) {
        return Response.json({
          resource: resourceOf(request).href,
          authorization_servers: [issuer],
          scopes_supported: [SCOPE],
          bearer_methods_supported: ["header"],
          resource_name: "idobata-bot（文書オーナー向け）",
        }, {
          headers: {
            "cache-control": "public, max-age=3600",
            "access-control-allow-origin": "*",
          },
        });
      },
    },
  });
}
