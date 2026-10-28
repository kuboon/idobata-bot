import { assertEquals } from "@std/assert";

import { createReplayDetector, nicknameFrom } from "./auth.ts";

Deno.test("a proof's jti is accepted once", () => {
  const check = createReplayDetector(60);
  assertEquals(check("a"), true);
  assertEquals(check("a"), false);
  assertEquals(check("b"), true);
});

Deno.test("nicknameFrom trims, caps, and falls back to a placeholder", () => {
  assertEquals(nicknameFrom("  井戸端  ", "u"), "井戸端");
  assertEquals(nicknameFrom("x".repeat(50), "u").length, 40);
  assertEquals(nicknameFrom("   ", "ab-cd-ef-gh"), "名無し-abcdef");
  assertEquals(nicknameFrom(undefined, "ab"), "名無し-ab");
});
