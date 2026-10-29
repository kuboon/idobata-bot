/**
 * Writes the Cloudflare Build Output Specification (`.cloudflare/output/v0`) for `cf deploy
 * --prebuilt`.
 *
 * `cf build` delegates to Wrangler or the Vite plugin, neither of which resolves this repo's `jsr:`
 * imports. So the Worker is bundled by `deno bundle` (`deno task build:worker`) and the static
 * site by `deno task build`; this script only arranges those two outputs the way `cf` reads them,
 * with the settings from `cloudflare.config.ts`.
 *
 * Run it through `deno task build:cf`, which builds both inputs first. With `--preview` it writes
 * the output for `cf previews deploy --prebuilt` instead, which `cf` only accepts from a build
 * marked as a preview — and `cloudflare.config.ts` sees `ctx.isPreview` (its own D1).
 */

import {
  cleanBuildOutputDir,
  getWorkerBundleDir,
  writeAssets,
  writeRootConfig,
  writeWorkerConfig,
} from "@cloudflare/build-output-utils";
import {
  loadAndParseConfig,
  loadAndParseConfigSettings,
} from "@cloudflare/config";

const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const worker = `${root}web/worker-dist/worker.js`;
const isPreview = Deno.args.includes("--preview");
const mode = Deno.args.find((arg) => !arg.startsWith("--"));
const ctx = { isPreview, mode };

const configPath = `${root}cloudflare.config.ts`;
const { result } = await loadAndParseConfig(configPath, ctx);
if (!result.success) throw new Error(`cloudflare.config.ts: ${result.error}`);
const config = result.data.worker;
if (!config) throw new Error("cloudflare.config.ts has no `worker`");
const { result: settings } = await loadAndParseConfigSettings(configPath, ctx);
if (!settings.success) {
  throw new Error(`cloudflare.config.ts: ${settings.error}`);
}

await cleanBuildOutputDir(root);
await writeRootConfig(root, settings.data, ctx);
await writeAssets({ root, sourceDirectory: `${root}web/dist` });

const bundleDir = getWorkerBundleDir(root);
await Deno.mkdir(bundleDir, { recursive: true });
await Deno.copyFile(worker, `${bundleDir}/worker.js`);
await writeWorkerConfig({
  root,
  config,
  manifest: {
    type: "complete",
    mainModule: "worker.js",
    modules: { "worker.js": { type: "esm" } },
  },
});
console.log(`Wrote .cloudflare/output/v0${isPreview ? " (preview)" : ""}`);
