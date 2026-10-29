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
