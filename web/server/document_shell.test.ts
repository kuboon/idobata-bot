import { assertEquals } from "@std/assert";

import { openLocalDatabase } from "./db/local.ts";
import { documents, now, users } from "./db/schema.ts";
import { documentHead } from "./document_shell.ts";

Deno.test("documentHead gives the document's title, or null", async () => {
  const db = await openLocalDatabase(":memory:");
  const at = now();
  await db.create(users, {
    id: "u",
    nickname: "n",
    role: null,
    created_at: at,
    updated_at: at,
  });
  for (const [id, description] of [["d1", "説明"], ["d2", ""]]) {
    await db.create(documents, {
      id,
      owner_id: "u",
      title: "計画案",
      description,
      closes_at: null,
      created_at: at,
      updated_at: at,
    });
  }

  assertEquals(await documentHead("d1"), {
    title: "計画案 — idobata-bot",
    description: "説明",
  });
  assertEquals(
    (await documentHead("d2"))?.description,
    "「計画案」を読み、段落を選んで意見を書きます。",
  );
  assertEquals(await documentHead("nope"), null);
});
