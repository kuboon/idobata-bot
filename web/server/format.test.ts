/** `defaultDeadline` (`client/lib/format.ts`). Lives here because `client/` is type-checked without Deno's globals. */

import { assertEquals } from "@std/assert";

import { defaultDeadline } from "../client/lib/format.ts";

Deno.test("the default deadline is midnight a month ahead", () => {
  assertEquals(
    defaultDeadline(new Date(2026, 9, 29, 13, 45)),
    "2026-11-29T00:00",
  );
});

Deno.test("a month ahead of a long month's end is the next month's last day", () => {
  assertEquals(defaultDeadline(new Date(2026, 0, 31, 9)), "2026-02-28T00:00");
  assertEquals(defaultDeadline(new Date(2026, 11, 15)), "2027-01-15T00:00");
});
