/**
 * The app, wired by hand.
 *
 * Route definitions live in `client/routes.ts` and this file maps them to what answers them — the
 * shape a Remix app has. `router.map(routes, controller)` is the whole of the mapping, and a
 * controller has to name an action for every route in the map it owns: leave one out and the
 * router throws while it is being built, rather than answering a route with nothing.
 *
 * What is exported is a plain `@remix-run/fetch-router` router, used two ways:
 *
 * - **Locally** `deno serve router.tsx` answers the pages *and* the server-only routes (`/api/*`,
 *   `/.well-known/jwks.json`) live. This is also what the tests run against.
 * - **The static build** (`deno task build`, `@remix-kbn/ssg`) crawls this same object with
 *   `fetch()` and writes each response to disk. It starts from `entryPoints` and follows links,
 *   and nothing links to the server-only routes, so `/api/*` is never generated. Cloudflare
 *   Workers serves that build as static assets and answers only the server-only routes, from
 *   `worker.ts` — this file uses Deno-only APIs and is not deployed there.
 */

import {
  createController,
  createRouter,
  type RouterContext,
} from "@remix-run/fetch-router";
import { cop } from "@remix-run/cop-middleware";
import { render } from "@remix-run/render-middleware";
import { createFileTree, githubPages } from "@remix-kbn/ssg/site";
import type { FileServerBehavior } from "@remix-kbn/ssg/site";

import { assets, assetsPath } from "./assets.ts";
import { openLocalDatabase } from "./db/local.ts";
import { clientRuntime } from "./runtime.ts";
import { ogImage, ogPaths, serveOgImage } from "./og/mod.ts";
import { Layout, type PageModule } from "../client/layout.tsx";
import { routes } from "../client/routes.ts";

import * as Home from "../client/pages/index.tsx";
import * as My from "../client/pages/my.tsx";

import { notifyAction } from "./controllers/api/notify.ts";
import { jwksAction } from "./controllers/well_known.ts";

/**
 * The database: a local SQLite file when `LOCAL_DB` names one (`deno task dev` does), otherwise a
 * fresh in-memory one — which is what the tests and the static build get. Either way it is
 * migrated on open. On Cloudflare the Worker uses the D1 binding instead; see `worker.ts`.
 */
await openLocalDatabase(Deno.env.get("LOCAL_DB") ?? ":memory:");

/**
 * How the static build lays out its files: `/my` as `my/index.html`, which is what Workers static
 * assets' `auto-trailing-slash` serves.
 */
export const fileServer: FileServerBehavior = githubPages();

/**
 * Renders a page module into the shell.
 *
 * The route comes in alongside the module because the page's own path is what its social card is
 * registered under — the card is drawn from the same `title` and `description` the `<head>` gets.
 */
function pageAction(route: { href(): string }, page: PageModule) {
  const image = ogImage(route.href(), page);
  const Page = page.default;

  return (context: AppContext): Response =>
    context.render(
      <Layout
        title={page.title}
        description={page.description}
        image={image}
        script={page.hydrate ? clientRuntime : null}
      >
        <Page />
      </Layout>,
    );
}

/** The files under `client/static/`, served verbatim at their own names. */
const staticFiles = await createFileTree({
  rootDir: `${import.meta.dirname}/../client/static`,
  basePath: "/static",
  cacheControl: "public, max-age=3600",
});

/**
 * The service worker, from `client/sw.js`.
 *
 * It is a route of its own rather than a file under `static/` because a worker's scope is the
 * directory it is served from: `/static/sw.js` could only control `/static/`.
 */
const serviceWorker = await Deno.readTextFile(
  new URL("../client/sw.js", import.meta.url),
);

/**
 * `cop()` rejects unsafe cross-origin browser requests (`POST /api/notify`) by `Sec-Fetch-Site` /
 * `Origin`, without tokens. `render({ assets })` puts `context.render(node)` on every request.
 */
const router = createRouter({ middleware: [cop(), render({ assets })] });

/** The request context those middlewares produce — `context.render`, in practice. */
export type AppContext = RouterContext<typeof router>;

declare module "@remix-run/fetch-router" {
  interface RouterTypes {
    context: AppContext;
  }
}

/**
 * The direct routes at the top of the map: the pages, and the JWKS document.
 *
 * `routes.api` is a map, so it is mapped separately below.
 */
const top = createController(routes, {
  actions: {
    home: pageAction(routes.home, Home),
    my: pageAction(routes.my, My),
    jwks: jwksAction,
  },
});

/** The server-only API. Static builds never reach it — see the header. */
const api = createController(routes.api, {
  actions: {
    notify: notifyAction,
  },
});

router.map(routes, top);
router.map(routes.api, api);

router.get("/static/*path", ({ request }) => staticFiles.fetch(request));
router.get(`${assetsPath}/*path`, ({ request }) => assets.fetch(request));
router.get("/og/*path", ({ request }) => serveOgImage(request));
// The push service worker.
router.get(
  "/sw.js",
  () =>
    new Response(serviceWorker, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "service-worker-allowed": "/",
      },
    }),
);

/**
 * Where the static crawl starts.
 *
 * Pages are reached by following links from `/`. The exceptions are things nothing links to in
 * the static HTML: `/my` (the nav's link to it is drawn by the sign-in island, only once signed
 * in), the social cards (an `og:image` is an absolute URL meant for someone else's server) and the
 * service worker (the push manager registers it by URL from script). `/api/*` is deliberately
 * absent.
 */
export const entryPoints: readonly string[] = [
  "/",
  routes.my.href(),
  ...ogPaths(),
  "/sw.js",
];

export default router;
