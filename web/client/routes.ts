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

import {
  del,
  get,
  patch,
  post,
  put,
  route,
} from "@remix-run/fetch-router/routes";

/** The `:docId` the static build writes the document page under — see `routes.document`. */
export const DOCUMENT_SHELL_ID = "_shell";

export const routes = route("", {
  home: get("/"),
  my: get("/my"),
  /** Register a document. */
  newDocument: get("/new"),
  /**
   * One document: the viewer, its opinions and the chat. A page, but not one the static build can
   * write per document — the IDs are only in the database. So the build writes it once, as
   * `/d/_shell`, the Worker answers every `/d/:docId` with that file (`server/worker.ts`), and the
   * page's island reads the ID back out of the URL.
   */
  document: get("/d/:docId"),
  /** RP public JWKS — lets the IdP verify our `private_key_jwt` assertions. */
  jwks: get("/.well-known/jwks.json"),
  api: route("api", {
    /** Server-initiated push fan-out (delegates to the IdP). Not DPoP-protected. */
    notify: post("/notify"),
    /** The signed-in user: DPoP proof and IdP token required. */
    me: route("me", {
      show: get("/"),
      update: patch("/"),
      /** The documents the user registered. */
      documents: get("/documents"),
    }),
    docs: route("docs", {
      index: get("/"),
      /** Sign-in required. */
      create: post("/"),
      /** `?version=n` for a version other than the latest. */
      show: get("/:docId"),
    }),
    /**
     * The opinion service (③ in docs/design.md §2): opinions, their targets and supports. It knows
     * a document only by its ID and segment keys. `packages/idobata-bot` is its client.
     */
    opinions: route({
      list: get("/docs/:docId/opinions"),
      create: post("/docs/:docId/opinions"),
      show: get("/opinions/:opinionId"),
      update: patch("/opinions/:opinionId"),
      remove: del("/opinions/:opinionId"),
      support: put("/opinions/:opinionId/support"),
      unsupport: del("/opinions/:opinionId/support"),
      mine: get("/me/opinions"),
    }),
    /**
     * The AI chat about a document (docs/design.md §6): the history in, the turn out as
     * server-sent events. No sign-in needed.
     */
    chat: route({
      send: post("/docs/:docId/chat"),
    }),
  }),
});
