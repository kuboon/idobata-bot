/**
 * The Cloudflare Workers entry: the server-only half of the app.
 *
 * Cloudflare serves the static build (`web/dist`, from `deno task build`) as Workers static assets
 * — the pages, the client chunks, the social cards, `sw.js`. `cloudflare.config.ts` sends only the
 * routes below to this Worker (`assets.runWorkerFirst`), so it never renders a page and needs none
 * of the Deno-only machinery in `router.tsx` (`Deno.bundle`, `Deno.readTextFile`, the file tree).
 *
 * `deno task build:worker` bundles this file into `web/worker-dist/worker.js`.
 */

import { cop } from "@remix-run/cop-middleware";
import { createController, createRouter } from "@remix-run/fetch-router";

import { routes } from "../client/routes.ts";
import { notifyAction } from "./controllers/api/notify.ts";
import { jwksAction } from "./controllers/well_known.ts";

// `router.tsx` augments `RouterTypes` project-wide so every controller sees `context.render`. None
// of the API controllers use it, and this router has no render middleware, so the controllers are
// handed over as `never` rather than pulling the page renderer (and `Deno.bundle`) in.
// Rejects unsafe cross-origin browser requests (`POST /api/notify`).
const router = createRouter({ middleware: [cop()] });

router.get(routes.jwks, jwksAction.handler as never);

router.map(
  routes.api,
  createController(routes.api, {
    actions: {
      notify: notifyAction,
    },
  }) as never,
);

export default { fetch: (request: Request) => router.fetch(request) };
