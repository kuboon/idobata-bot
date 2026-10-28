/**
 * Every URL the app answers, in one place.
 *
 * `server/router.tsx` maps these to the controllers that answer them, and everything that links
 * reads `routes.my.href()` rather than rebuilding `/my` at each call site.
 *
 * Two kinds of route live here and they are deployed differently:
 *
 * - **Pages** (`home`, `my`) are rendered to static HTML by `deno task build` and served from that
 *   build by Cloudflare as static assets.
 * - **Server routes** (`jwks` and everything under `api`) only exist on the live server, answered
 *   by the Worker (`server/worker.ts`). Nothing links to them, so the static build's crawl never
 *   reaches them, and they are not in `entryPoints`.
 */

import { get, patch, post, route } from "@remix-run/fetch-router/routes";

export const routes = route("", {
  home: get("/"),
  my: get("/my"),
  /** RP public JWKS — lets the IdP verify our `private_key_jwt` assertions. */
  jwks: get("/.well-known/jwks.json"),
  api: route("api", {
    /** Server-initiated push fan-out (delegates to the IdP). Not DPoP-protected. */
    notify: post("/notify"),
    /** The signed-in user: DPoP proof and IdP token required. */
    me: route("me", {
      show: get("/"),
      update: patch("/"),
    }),
    docs: route("docs", {
      index: get("/"),
      /** Sign-in required. */
      create: post("/"),
      /** `?version=n` for a version other than the latest. */
      show: get("/:docId"),
    }),
  }),
});
