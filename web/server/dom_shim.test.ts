import { assertEquals } from "@std/assert";

import { removeDomShim, shim } from "./dom_shim.ts";

/** What `decode-named-character-reference`'s DOM build does with its element. */
function decode(name: string): string {
  const element = shim.createElement();
  element.innerHTML = `&${name};`;
  return element.textContent;
}

Deno.test("the shim decodes named references like a browser", () => {
  assertEquals(decode("amp"), "&");
  assertEquals(decode("AElig"), "Æ");
  assertEquals(decode("semi"), ";");
  // Unknown names come back as written, which the package reads as "not a reference".
  assertEquals(decode("nosuchentity"), "&nosuchentity;");
});

Deno.test("the shim is gone once removed", () => {
  removeDomShim();
  assertEquals(
    typeof (globalThis as { document?: unknown }).document,
    "undefined",
  );
});
