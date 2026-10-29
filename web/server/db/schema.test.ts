import { assertEquals } from "@std/assert";

import { openLocalDatabase } from "./local.ts";
import {
  adoptions,
  changes,
  documents,
  filterStats,
  moderationLogs,
  newId,
  now,
  opinions,
  opinionTargets,
  segments,
  supports,
  users,
  versions,
} from "./schema.ts";

Deno.test("migrations apply and every table round-trips a row", async () => {
  const db = await openLocalDatabase(":memory:");
  const at = now();

  await db.create(users, {
    id: "u1",
    nickname: "名無し",
    role: null,
    created_at: at,
    updated_at: at,
  });
  await db.create(documents, {
    id: "d1",
    owner_id: "u1",
    title: "文書",
    description: "",
    closes_at: null,
    created_at: at,
    updated_at: at,
  });
  await db.create(versions, {
    id: "v1",
    document_id: "d1",
    number: 1,
    status: "released",
    source_md: "# 見出し\n\n本文",
    release_note: "",
    released_at: at,
    created_at: at,
  });
  await db.create(versions, {
    id: "v2",
    document_id: "d1",
    number: 2,
    status: "draft",
    source_md: "# 見出し\n\n本文2",
    release_note: "",
    released_at: null,
    created_at: at,
  });
  await db.create(segments, {
    id: newId(),
    version_id: "v1",
    segment_key: "s1",
    ord: 0,
    kind: "paragraph",
    text: "本文",
    heading_path: "見出し",
  });
  await db.create(changes, {
    id: "c1",
    from_version_id: "v1",
    to_version_id: "v2",
    ord: 0,
    kind: "modified",
    from_segment_key: "s1",
    to_segment_key: "s1",
    diff_json: "[]",
  });
  for (const id of ["o1", "o2"]) {
    await db.create(opinions, {
      id,
      document_id: "d1",
      version_id: "v1",
      author_id: "u1",
      title: "要旨",
      body: "本文",
      status: "published",
      created_at: at,
      updated_at: at,
    });
  }
  await db.create(opinionTargets, {
    id: newId(),
    opinion_id: "o1",
    kind: "segment",
    segment_key: "s1",
    target_opinion_id: null,
    stance: "concern",
  });
  await db.create(opinionTargets, {
    id: newId(),
    opinion_id: "o2",
    kind: "opinion",
    segment_key: null,
    target_opinion_id: "o1",
    stance: "support",
  });
  await db.create(supports, {
    opinion_id: "o1",
    user_id: "u1",
    created_at: at,
  });
  await db.create(adoptions, { change_id: "c1", opinion_id: "o1", note: "" });
  await db.create(moderationLogs, {
    id: newId(),
    opinion_id: "o2",
    actor_id: "u1",
    action: "hide",
    reason: "重複",
    duplicate_of: "o1",
    created_at: at,
  });
  await db.create(filterStats, {
    document_id: "d1",
    day: at.slice(0, 10),
    kind: "off_topic",
    count: 1,
  });

  assertEquals(
    (await db.findMany(opinionTargets, {
      where: { target_opinion_id: "o1" },
    })).map((row) => row.stance),
    ["support"],
  );
  assertEquals(await db.count(supports, { where: { opinion_id: "o1" } }), 1);
  assertEquals((await db.find(users, "u1"))?.role, null);
});

Deno.test("a target must name what its kind says", async () => {
  const db = await openLocalDatabase(":memory:");
  const at = now();
  await db.create(users, {
    id: "u1",
    nickname: "n",
    role: null,
    created_at: at,
    updated_at: at,
  });
  await db.create(documents, {
    id: "d1",
    owner_id: "u1",
    title: "t",
    description: "",
    closes_at: null,
    created_at: at,
    updated_at: at,
  });
  await db.create(versions, {
    id: "v1",
    document_id: "d1",
    number: 1,
    status: "released",
    source_md: "",
    release_note: "",
    released_at: at,
    created_at: at,
  });
  await db.create(opinions, {
    id: "o1",
    document_id: "d1",
    version_id: "v1",
    author_id: "u1",
    title: "t",
    body: "",
    status: "published",
    created_at: at,
    updated_at: at,
  });

  let rejected = false;
  try {
    // `kind: "segment"` without a segment key violates the table's CHECK.
    await db.create(opinionTargets, {
      id: newId(),
      opinion_id: "o1",
      kind: "segment",
      segment_key: null,
      target_opinion_id: null,
      stance: "concern",
    });
  } catch {
    rejected = true;
  }
  assertEquals(rejected, true);
});
