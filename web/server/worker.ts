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

// First: a module below needs it while it loads — see the file.
import { removeDomShim } from "./dom_shim.ts";

import { cop } from "@remix-run/cop-middleware";
import { createController, createRouter } from "@remix-run/fetch-router";

import type { D1DatabaseBinding } from "@remix-kbn/data-table-d1";

import { routes } from "../client/routes.ts";
import { useDatabase } from "./db/mod.ts";
import { type AiBinding, useAi } from "./lib/chat/filter.ts";
import { type AssetsBinding, serveDocumentShell } from "./document_shell.ts";
import { createChatController } from "./controllers/api/chat.ts";
import { createDocsController } from "./controllers/api/docs.ts";
import { createMeController } from "./controllers/api/me.ts";
import { createOpinionsController } from "./controllers/api/opinions.ts";
import { notifyAction } from "./controllers/api/notify.ts";
import { jwksAction } from "./controllers/well_known.ts";

// `router.tsx` augments `RouterTypes` project-wide so every controller sees `context.render`. None
// of the API controllers use it, and this router has no render middleware, so the controllers are
// handed over as `never` rather than pulling the page renderer (and `Deno.bundle`) in.
// Rejects unsafe cross-origin browser requests (`POST /api/notify`).
// Every import above has run by now; the shim has done its job.
removeDomShim();

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
router.map(routes.api.me, createMeController() as never);
router.map(routes.api.docs, createDocsController() as never);
router.map(routes.api.opinions, createOpinionsController() as never);
router.map(routes.api.chat, createChatController() as never);

/** The bindings `cloudflare.config.ts` gives the Worker that the code reads directly. */
interface WorkerEnv {
  DB?: D1DatabaseBinding;
  ASSETS?: AssetsBinding;
  AI?: AiBinding;
}

let databaseSet = false;
let assets: AssetsBinding | undefined;

// The document page, which the static build writes once — see `document_shell.ts`.
router.get(
  routes.document,
  (({ request, params }: {
    request: Request;
    params: { docId: string };
  }) =>
    assets
      ? serveDocumentShell(request, params.docId, assets)
      : new Response("Not Found", { status: 404 })) as never,
);

export default {
  fetch(request: Request, env?: WorkerEnv): Promise<Response> {
    // The binding only arrives with a request, so the database is set on the first one. The
    // tests call this without an env, and set their own database.
    if (!databaseSet && env?.DB) {
      useDatabase(env.DB);
      useAi(env.AI);
      databaseSet = true;
    }
    assets ??= env?.ASSETS;
    return router.fetch(request);
  },
};
