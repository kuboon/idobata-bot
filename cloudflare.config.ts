/**
 * Cloudflare deployment config, read by the `cf` CLI (`deno task cf deploy`).
 *
 * Cloudflare serves the static build (`web/dist`) as Workers static assets and runs only the
 * server-only routes in the Worker (`web/server/worker.ts`, bundled to `web/worker-dist/worker.js`
 * by `deno task build:worker`). `deno task build:cf` makes both.
 */

import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  // Not a secret: it is only an identifier, and the API token is what authorizes.
  accountId: "ac92f36f0a2d84353b137574157f7480",
  worker: {
    name: "idobata-bot",
    compatibilityDate: "2026-10-01",
    entrypoint: "./web/worker-dist/worker.js",
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
      // Secrets, declared here so a deploy keeps them. The deploy workflow supplies them
      // (`web/server/deploy_secrets.ts`): RP_SIGNING_KEY_JWK is generated on the first deploy,
      // ANTHROPIC_API_KEY comes from the repository's Actions secret. Either can also be set by
      // hand with `deno task cf workers secrets update <NAME> --worker idobata-bot
      // --type secret_text --text ...`.
      RP_SIGNING_KEY_JWK: bindings.secret(),
      // The Claude API key for the chat (`web/server/lib/chat/`).
      ANTHROPIC_API_KEY: bindings.secret(),
      // Workers AI, for the chat's pre-filter (Clef).
      AI: bindings.ai(),
      // Migrated ahead of a deploy with `deno task db migrate --remote` (needs
      // CLOUDFLARE_D1_DATABASE_ID and a token with D1 edit permission).
      DB: bindings.d1({ name: "idobata-bot" }),
      ASSETS: bindings.assets(),
    },
  },
});
