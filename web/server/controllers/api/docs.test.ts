import { assert, assertEquals } from "@std/assert";
import { createRouter } from "@remix-run/fetch-router";

import { routes } from "../../../client/routes.ts";
import { openLocalDatabase } from "../../db/local.ts";
import { appUrl, dpopClientFor, fakeIdp } from "../../testing/auth.ts";
import { createDocsController } from "./docs.ts";
import { createMeController } from "./me.ts";

const MARKDOWN = `# 計画案

第一段落。

## 目標

- 目標 1
- 目標 2
`;

async function setup() {
  await openLocalDatabase(":memory:");
  const idp = await fakeIdp();
  const router = createRouter();
  router.map(routes.api.me, createMeController(idp.auth) as never);
  router.map(routes.api.docs, createDocsController(idp.auth) as never);
  const client = await dpopClientFor(router);
  const signedIn = async (sub = "owner-1", nickname = "オーナー") => ({
    authorization: `DPoP ${await idp.token(sub, client.thumbprint, {
      nickname,
    })}`,
  });
  return { ...client, signedIn };
}

const post = (body: unknown, headers: Record<string, string>) => ({
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(body),
});

Deno.test("registering needs a signed-in user", async () => {
  const { fetchDpop } = await setup();
  const res = await fetchDpop(
    appUrl("/api/docs"),
    post({ title: "t", markdown: "本文" }, {}),
  );
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("a registered document is listed and shown with its segments", async () => {
  const { fetchDpop, signedIn } = await setup();
  const created = await fetchDpop(
    appUrl("/api/docs"),
    post({
      title: " 計画案 ",
      description: "説明",
      closesAt: "2099-01-01T00:00:00+09:00",
      markdown: MARKDOWN,
    }, await signedIn()),
  );
  assertEquals(created.status, 201);
  const { id } = await created.json() as { id: string };

  const list = await (await fetchDpop(appUrl("/api/docs"))).json();
  assertEquals(list.documents.length, 1);
  assertEquals(list.documents[0].title, "計画案");
  assertEquals(list.documents[0].owner.nickname, "オーナー");
  assertEquals(list.documents[0].closesAt, "2098-12-31T15:00:00.000Z");
  assertEquals(list.documents[0].open, true);
  assertEquals(list.documents[0].opinionCount, 0);

  const shown = await fetchDpop(appUrl(`/api/docs/${id}`));
  assertEquals(shown.status, 200);
  const { document } = await shown.json();
  assertEquals(document.version, {
    number: 1,
    releasedAt: document.versions[0].releasedAt,
  });
  assertEquals(document.markdown, MARKDOWN);
  assertEquals(
    document.segments.map((s: { kind: string; text: string }) => [
      s.kind,
      s.text,
    ]),
    [
      ["heading", "# 計画案"],
      ["paragraph", "第一段落。"],
      ["heading", "## 目標"],
      ["list", "- 目標 1\n- 目標 2"],
    ],
  );
  const keys = new Set(
    document.segments.map((s: { key: string }) => s.key),
  );
  assertEquals(keys.size, 4);
});

Deno.test("CRLF is stored as LF, so segments are found in the source", async () => {
  const { fetchDpop, signedIn } = await setup();
  const created = await fetchDpop(
    appUrl("/api/docs"),
    post({ title: "t", markdown: "# 題\r\n\r\n本文\r\n" }, await signedIn()),
  );
  const { id } = await created.json();
  const { document } = await (await fetchDpop(appUrl(`/api/docs/${id}`)))
    .json();
  assertEquals(document.markdown, "# 題\n\n本文\n");
  for (const segment of document.segments) {
    assert(document.markdown.includes(segment.text));
  }
});

Deno.test("a past deadline shows the document as closed", async () => {
  const { fetchDpop, signedIn } = await setup();
  const created = await fetchDpop(
    appUrl("/api/docs"),
    post(
      { title: "t", closesAt: "2000-01-01T00:00:00Z", markdown: "本文" },
      await signedIn(),
    ),
  );
  const { id } = await created.json();
  const { document } = await (await fetchDpop(appUrl(`/api/docs/${id}`)))
    .json();
  assertEquals(document.open, false);
});

Deno.test("unknown documents and versions are 404", async () => {
  const { fetchDpop, signedIn } = await setup();
  const created = await fetchDpop(
    appUrl("/api/docs"),
    post({ title: "t", markdown: "本文" }, await signedIn()),
  );
  const { id } = await created.json();

  for (const path of ["/api/docs/nope", `/api/docs/${id}?version=2`]) {
    const res = await fetchDpop(appUrl(path));
    assertEquals(res.status, 404, path);
    await res.body?.cancel();
  }
  const bad = await fetchDpop(appUrl(`/api/docs/${id}?version=x`));
  assertEquals(bad.status, 400);
  await bad.body?.cancel();
});

Deno.test("invalid documents are refused with a reason", async () => {
  const { fetchDpop, signedIn } = await setup();
  const auth = await signedIn();
  for (
    const [body, error] of [
      [{ title: "", markdown: "本文" }, "title"],
      [{ title: "t", markdown: "  \n---\n" }, "markdown has no content"],
      [{ title: "t", markdown: "本文", closesAt: "someday" }, "closesAt"],
      [{ title: "t", markdown: "x".repeat(200_001) }, "markdown"],
    ] as const
  ) {
    const res = await fetchDpop(appUrl("/api/docs"), post(body, auth));
    assertEquals(res.status, 400);
    const json = await res.json();
    assert(json.error.includes(error), json.error);
  }
});

Deno.test("a long document registers within D1's 100 parameters per statement", async () => {
  // 40 segments × 7 columns would be one 280-parameter insert; D1 refuses that, and the local
  // database refuses it the same way.
  const { fetchDpop, signedIn } = await setup();
  const markdown = Array.from({ length: 40 }, (_, i) => `段落 ${i + 1}。`).join(
    "\n\n",
  );
  const created = await fetchDpop(
    appUrl("/api/docs"),
    post({ title: "長い文書", markdown }, await signedIn()),
  );
  assertEquals(created.status, 201);
  const { id } = await created.json();
  const { document } = await (await fetchDpop(appUrl(`/api/docs/${id}`)))
    .json();
  assertEquals(document.segments.length, 40);
  assertEquals(document.segments[39].text, "段落 40。");
});

const send = (
  method: string,
  body: unknown,
  headers: Record<string, string>,
) => ({
  method,
  headers: { ...headers, "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

Deno.test("the owner writes the next version with the keys in view, and releases it", async () => {
  const { fetchDpop, signedIn } = await setup();
  const auth = await signedIn();
  const created = await fetchDpop(
    appUrl("/api/docs"),
    post({ title: "t", markdown: MARKDOWN }, auth),
  );
  const { id } = await created.json();
  const v1 = (await (await fetchDpop(appUrl(`/api/docs/${id}`))).json())
    .document;
  const [heading, first] = v1.segments as { key: string }[];

  // Nothing saved yet: the latest release, marked, to start from.
  const start = (await (await fetchDpop(
    appUrl(`/api/docs/${id}/draft`),
    { headers: auth },
  )).json()).draft;
  assertEquals([start.number, start.saved, start.released], [2, false, 1]);
  assert(start.markdown.startsWith(`<!-- #${heading.key} -->\n# 計画案\n`));

  // Rewrite the first paragraph, add one without a key, drop the rest.
  const saved = await fetchDpop(
    appUrl(`/api/docs/${id}/draft`),
    send("PUT", {
      markdown: `<!-- #${heading.key} -->
# 計画案

<!-- #${first.key} -->
第一段落を直した。

新しい段落。
`,
    }, auth),
  );
  assertEquals(saved.status, 200);
  const draft = (await saved.json()).draft;
  assertEquals([draft.number, draft.saved], [2, true]);
  const newKey = /<!-- #([\w-]+) -->\n新しい段落/.exec(draft.markdown)?.[1];
  assert(newKey && newKey !== heading.key && newKey !== first.key);

  // Readers still see version 1 until it is released.
  const before = (await (await fetchDpop(appUrl(`/api/docs/${id}`))).json())
    .document;
  assertEquals(before.version.number, 1);

  const released = await fetchDpop(
    appUrl(`/api/docs/${id}/draft/release`),
    send("POST", { releaseNote: "段落を直した" }, auth),
  );
  assertEquals(released.status, 200);
  const v2 = (await released.json()).document;
  assertEquals(v2.version.number, 2);
  assertEquals(v2.versions.map((v: { number: number }) => v.number), [1, 2]);
  assertEquals(v2.markdown, "# 計画案\n\n第一段落を直した。\n\n新しい段落。\n");
  assertEquals(
    v2.segments.map((s: { key: string; text: string }) => [s.key, s.text]),
    [
      [heading.key, "# 計画案"],
      [first.key, "第一段落を直した。"],
      [newKey, "新しい段落。"],
    ],
  );
  // Version 1 stays readable.
  const old = (await (await fetchDpop(appUrl(`/api/docs/${id}?version=1`)))
    .json()).document;
  assertEquals(old.markdown, MARKDOWN);

  // No draft left; the next one would be version 3.
  const next = (await (await fetchDpop(
    appUrl(`/api/docs/${id}/draft`),
    { headers: auth },
  )).json()).draft;
  assertEquals([next.number, next.saved], [3, false]);
  const again = await fetchDpop(
    appUrl(`/api/docs/${id}/draft/release`),
    send("POST", {}, auth),
  );
  assertEquals(again.status, 409);
  await again.body?.cancel();
});

Deno.test("a draft is replaced on each save and can be thrown away", async () => {
  const { fetchDpop, signedIn } = await setup();
  const auth = await signedIn();
  const { id } = await (await fetchDpop(
    appUrl("/api/docs"),
    post({ title: "t", markdown: "本文" }, auth),
  )).json();
  const save = (markdown: string) =>
    fetchDpop(
      appUrl(`/api/docs/${id}/draft`),
      send("PUT", { markdown }, auth),
    ).then((r) => r.json());

  // A key copied onto a second block is the first one's; the copy gets a new one.
  const first = (await save("<!-- #k1 -->\nA\n\n<!-- #k1 -->\nB\n")).draft;
  assertEquals(first.number, 2);
  assert(first.markdown.startsWith("<!-- #k1 -->\nA\n\n<!-- #"));
  assert(!first.markdown.endsWith("<!-- #k1 -->\nB\n"));
  const second = (await save("<!-- #k1 -->\nC\n")).draft;
  assertEquals([second.number, second.markdown], [2, "<!-- #k1 -->\nC\n"]);

  const empty = await fetchDpop(
    appUrl(`/api/docs/${id}/draft`),
    send("PUT", { markdown: "<!-- #k1 -->\n" }, auth),
  );
  assertEquals(empty.status, 400);
  await empty.body?.cancel();

  const discarded = await fetchDpop(
    appUrl(`/api/docs/${id}/draft`),
    send("DELETE", undefined, auth),
  );
  assertEquals(discarded.status, 204);
  const after = (await (await fetchDpop(
    appUrl(`/api/docs/${id}/draft`),
    { headers: auth },
  )).json()).draft;
  assertEquals([after.number, after.saved], [2, false]);
});

Deno.test("only the owner sees or writes the draft", async () => {
  const { fetchDpop, signedIn } = await setup();
  const { id } = await (await fetchDpop(
    appUrl("/api/docs"),
    post({ title: "t", markdown: "本文" }, await signedIn()),
  )).json();
  const other = await signedIn("someone-else", "他人");
  for (
    const init of [
      { headers: other },
      send("PUT", { markdown: "x" }, other),
      send("DELETE", undefined, other),
      send("POST", {}, other),
    ]
  ) {
    const path = init === undefined || !("method" in init) ||
        init.method !== "POST"
      ? `/api/docs/${id}/draft`
      : `/api/docs/${id}/draft/release`;
    const res = await fetchDpop(appUrl(path), init);
    assertEquals(res.status, 403, path);
    await res.body?.cancel();
  }
  const missing = await fetchDpop(appUrl("/api/docs/nope/draft"), {
    headers: other,
  });
  assertEquals(missing.status, 404);
  await missing.body?.cancel();
});
