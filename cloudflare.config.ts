/**
 * Cloudflare deployment config, read by the `cf` CLI (`deno task cf deploy`).
 *
 * Cloudflare serves the static build (`web/dist`) as Workers static assets and runs only the
 * server-only routes in the Worker (`web/server/worker.ts`, bundled to `web/worker-dist/worker.js`
 * by `deno task build:worker`). `deno task build:cf` makes both.
 *
 * Pull requests to main get a Worker Preview (`.github/workflows/preview.yml`, built with
 * `deno task build:cf --preview`). A preview has its own D1, so a PR never writes to the
 * production data.
 */

import { bindings, defineConfig } from "cf/config";

export default defineConfig((ctx) => ({
  // Not a secret: it is only an identifier, and the API token is what authorizes.
  accountId: "ac92f36f0a2d84353b137574157f7480",
  worker: {
    name: "idobata-bot",
    compatibilityDate: "2026-10-29",
    entrypoint: "./web/worker-dist/worker.js",
    // `<preview>-idobata-bot.<subdomain>.workers.dev` for each PR's preview (preview.yml); off
    // by default, and without it a preview deploys with no URL.
    previewUrls: true,
    // Workers Logs, as the dashboard turned on when it created the Worker.
    observability: { enabled: true, logs: { enabled: true } },
    assets: {
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "none",
      // Only these reach the Worker; every other path is a static file.
      // `/d/*` is the document page: the Worker serves the static shell with the document's
      // title written in (`web/server/document_shell.ts`).
      runWorkerFirst: ["/api/*", "/.well-known/jwks.json", "/d/*"],
    },
    env: {
      IDP_ORIGIN: bindings.text("https://id.kbn.one"),
      RP_ORIGIN: bindings.text("https://idobata-bot.kuboon.workers.dev"),
      // Secrets are set on the Worker only, and deliberately not declared here: a declared
      // (`bindings.secret()`) one is required, so the first deploy — which creates the Worker
      // — could never go through, as no secret can be set on a Worker that does not exist yet.
      // A deploy keeps the Worker's secrets either way, and the code runs without them (see
      // web/server/config.ts). RP_SIGNING_KEY_JWK comes from the manual workflow
      // `.github/workflows/rp-signing-key.yml`; ANTHROPIC_API_KEY (the chat's Claude API key)
      // is set in the dashboard or with `cf workers secrets update`.
      // Workers AI, for the chat's pre-filter (Clef).
      AI: bindings.ai(),
      // Migrated ahead of a deploy with `deno task db migrate --remote` (needs
      // CLOUDFLARE_D1_DATABASE_ID and a token with D1 edit permission).
      DB: bindings.d1({
        name: ctx.isPreview ? "idobata-bot-preview" : "idobata-bot",
      }),
      ASSETS: bindings.assets(),
    },
  },
}));
