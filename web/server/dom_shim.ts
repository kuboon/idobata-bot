/**
 * The one piece of `document` the Worker bundle needs.
 *
 * `deno task build:worker` bundles for the browser platform (the `deno` one pulls in `node:`
 * modules Workers do not have), so packages resolve their `browser` export. One of them —
 * `decode-named-character-reference`, under remark, which `lib/segments.ts` parses documents with
 * — then decodes `&name;` through a DOM element, made at module load:
 * `document.createElement("i")`, write `innerHTML`, read `textContent`. Workers have no
 * `document`, so the Worker failed to start.
 *
 * This answers exactly that, from the same entity table the package's non-DOM build reads, and
 * only when there is no real `document`. `worker.ts` imports it first, so it is in place before
 * that module runs, and calls {@link removeDomShim} once its imports have run: the module keeps
 * the element it made, and nothing else should see a `document` — client code reads
 * `typeof document` to tell whether it runs in a browser.
 */

import { characterEntities } from "character-entities";

const g = globalThis as { document?: unknown };

/** The stand-in `document` (exported for its test). */
export const shim = {
  createElement() {
    let text = "";
    return {
      set innerHTML(html: string) {
        // Called with one reference, "&name;". Unknown names stay as written, as in a browser.
        const name = /^&([^;]+);$/.exec(html)?.[1];
        text = name !== undefined && Object.hasOwn(characterEntities, name)
          ? characterEntities[name as keyof typeof characterEntities]
          : html;
      },
      get textContent() {
        return text;
      },
    };
  },
};

if (g.document === undefined) g.document = shim;

/** Takes the shim back off `globalThis`; a real `document` is left alone. */
export function removeDomShim(): void {
  if (g.document === shim) delete g.document;
}
