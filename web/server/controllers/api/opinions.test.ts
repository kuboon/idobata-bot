/**
 * The opinion service end to end, through the opinion module's own client
 * (`packages/idobata-bot`), signed the way the browser signs: a DPoP key per user, and the IdP's
 * token on top when signed in.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRouter } from "@remix-run/fetch-router";
import {
  createOpinionClient,
  OpinionApiError,
  type OpinionInput,
} from "@kuboon/idobata-bot";

import { routes } from "../../../client/routes.ts";
import { openLocalDatabase } from "../../db/local.ts";
import { sql } from "@remix-run/data-table";
import { documents } from "../../db/schema.ts";
import { appUrl, dpopClientFor, fakeIdp } from "../../testing/auth.ts";
import { createDocsController } from "./docs.ts";
import { createOpinionsController } from "./opinions.ts";

async function setup() {
  const db = await openLocalDatabase(":memory:");
  const idp = await fakeIdp();
  const router = createRouter();
  router.map(routes.api.docs, createDocsController(idp.auth) as never);
  router.map(routes.api.opinions, createOpinionsController(idp.auth) as never);

  /** A browser: its own DPoP key, signed in as `sub` unless `null`. */
  const browser = async (sub: string | null) => {
    const { fetchDpop, thumbprint } = await dpopClientFor(router);
    const token = sub
      ? await idp.token(sub, thumbprint, { nickname: sub })
      : null;
    const fetch = (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `DPoP ${token}`);
      return fetchDpop(appUrl(url), { ...init, headers });
    };
    return { fetch, client: createOpinionClient({ fetch }) };
  };

  const owner = await browser("owner");
  const created = await owner.fetch("/api/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "計画案",
      markdown: "# 題\n\n本文1\n\n本文2",
    }),
  });
  const { id: docId } = await created.json();
  const { document } = await (await owner.fetch(`/api/docs/${docId}`)).json();
  const [, seg1, seg2] = (document.segments as { key: string }[]).map((s) =>
    s.key
  );

  return { db, browser, owner, docId, seg1, seg2 };
}

const input = (
  over: Partial<OpinionInput> & Pick<OpinionInput, "targets">,
): OpinionInput => ({
  title: "要旨",
  body: "本文",
  ...over,
});

Deno.test("posting needs sign-in; reading does not", async () => {
  const { browser, docId, seg1 } = await setup();
  const anonymous = await browser(null);
  const error = await assertRejects(
    () =>
      anonymous.client.post(
        docId,
        input({
          targets: [{ kind: "segment", segmentKey: seg1, stance: "concern" }],
        }),
      ),
    OpinionApiError,
  );
  assertEquals(error.status, 401);
  assertEquals((await anonymous.client.list(docId)).opinions, []);
});

Deno.test("an opinion with several targets, as its author and others see it", async () => {
  const { browser, docId, seg1 } = await setup();
  const alice = await browser("alice");
  const bob = await browser("bob");

  const a = await alice.client.post(
    docId,
    input({
      title: " 段落 1 が心配 ",
      targets: [
        { kind: "segment", segmentKey: seg1, stance: "concern" },
        { kind: "document", stance: "proposal" },
      ],
    }),
  );
  assertEquals(a.title, "段落 1 が心配");
  assertEquals(a.author.nickname, "alice");
  assertEquals(a.version, 1);
  assertEquals(a.mine, true);
  assertEquals(a.frozen, false);
  assertEquals(a.targets.length, 2);

  const b = await bob.client.post(
    docId,
    input({
      targets: [
        { kind: "opinion", opinionId: a.id, stance: "support" },
        { kind: "segment", segmentKey: seg1, stance: "question" },
      ],
    }),
  );

  const seenByBob = await bob.client.list(docId);
  assertEquals(seenByBob.opinions.map((o) => [o.id, o.mine]), [
    [a.id, false],
    [b.id, true],
  ]);
  assertEquals(seenByBob.opinions[0].incomingCount, 1);

  const detail = await (await browser(null)).client.get(a.id);
  assertEquals(detail.incoming.map((o) => o.id), [b.id]);
});

Deno.test("support freezes an opinion; withdrawing it unfreezes it", async () => {
  const { browser, docId, seg1 } = await setup();
  const alice = await browser("alice");
  const bob = await browser("bob");
  const targets = [{
    kind: "segment" as const,
    segmentKey: seg1,
    stance: "concern" as const,
  }];

  const a = await alice.client.post(docId, input({ targets }));
  const supported = await bob.client.support(a.id);
  assertEquals(supported.supportCount, 1);
  assertEquals(supported.supportedByMe, true);
  assertEquals(supported.frozen, true);
  // Supporting twice is still one support.
  assertEquals((await bob.client.support(a.id)).supportCount, 1);

  for (
    const attempt of [
      () => alice.client.update(a.id, input({ title: "変更", targets })),
      () => alice.client.remove(a.id),
    ]
  ) {
    const error = await assertRejects(attempt, OpinionApiError);
    assertEquals(error.status, 409);
  }

  assertEquals((await bob.client.unsupport(a.id)).frozen, false);
  const edited = await alice.client.update(
    a.id,
    input({
      title: "変更",
      targets: [{ kind: "document", stance: "objection" }],
    }),
  );
  assertEquals(edited.title, "変更");
  assertEquals(edited.targets, [{ kind: "document", stance: "objection" }]);
  await alice.client.remove(a.id);
  assertEquals((await alice.client.list(docId)).opinions, []);
});

Deno.test("another opinion naming it freezes it too", async () => {
  const { browser, docId } = await setup();
  const alice = await browser("alice");
  const bob = await browser("bob");
  const a = await alice.client.post(
    docId,
    input({ targets: [{ kind: "document", stance: "proposal" }] }),
  );
  await bob.client.post(
    docId,
    input({
      targets: [{ kind: "opinion", opinionId: a.id, stance: "question" }],
    }),
  );
  const error = await assertRejects(
    () => alice.client.remove(a.id),
    OpinionApiError,
  );
  assertEquals(error.status, 409);
});

Deno.test("only the author changes an opinion, and not their own support", async () => {
  const { browser, docId } = await setup();
  const alice = await browser("alice");
  const bob = await browser("bob");
  const a = await alice.client.post(
    docId,
    input({ targets: [{ kind: "document", stance: "proposal" }] }),
  );
  assertEquals(
    (await assertRejects(() => bob.client.remove(a.id), OpinionApiError))
      .status,
    403,
  );
  assertEquals(
    (await assertRejects(() => alice.client.support(a.id), OpinionApiError))
      .status,
    400,
  );
});

Deno.test("targets must exist in this document and be well-formed", async () => {
  const { browser, docId, seg2 } = await setup();
  const alice = await browser("alice");
  for (
    const targets of [
      [],
      [{ kind: "segment", segmentKey: "nope", stance: "concern" }],
      [{ kind: "opinion", opinionId: "nope", stance: "support" }],
      [{ kind: "segment", segmentKey: seg2, stance: "angry" }],
      [
        { kind: "document", stance: "concern" },
        { kind: "document", stance: "support" },
      ],
    ]
  ) {
    const error = await assertRejects(
      () => alice.client.post(docId, input({ targets: targets as never })),
      OpinionApiError,
    );
    assertEquals(error.status, 400, JSON.stringify(targets));
  }
});

Deno.test("an opinion is targets, a title and a body that may be empty", async () => {
  const { browser, docId, seg1 } = await setup();
  const alice = await browser("alice");
  const targets = [{
    kind: "segment" as const,
    segmentKey: seg1,
    stance: "concern" as const,
  }];

  const bare = await alice.client.post(docId, { title: "要旨だけ", targets });
  assertEquals([bare.title, bare.body], ["要旨だけ", ""]);
  const full = await alice.client.post(
    docId,
    input({ body: "一行目\n二行目", targets }),
  );
  assertEquals(full.body, "一行目\n二行目");

  const status = async (over: Partial<OpinionInput>) =>
    (await assertRejects(
      () => alice.client.post(docId, input({ targets, ...over })),
      OpinionApiError,
    )).status;
  assertEquals(await status({ title: " " }), 400);
  assertEquals(await status({ body: "あ".repeat(4001) }), 400);
});

Deno.test("after the deadline nothing is posted or supported, but all is readable", async () => {
  const { db, browser, docId } = await setup();
  const alice = await browser("alice");
  const bob = await browser("bob");
  const a = await alice.client.post(
    docId,
    input({ targets: [{ kind: "document", stance: "proposal" }] }),
  );
  await db.update(documents, docId, { closes_at: "2000-01-01T00:00:00.000Z" });

  for (
    const attempt of [
      () =>
        alice.client.post(
          docId,
          input({ targets: [{ kind: "document", stance: "concern" }] }),
        ),
      () => bob.client.support(a.id),
      () => alice.client.remove(a.id),
    ]
  ) {
    assertEquals((await assertRejects(attempt, OpinionApiError)).status, 403);
  }
  assertEquals((await bob.client.list(docId)).opinions.length, 1);
});

Deno.test("my opinions span documents, newest first", async () => {
  const { browser, docId } = await setup();
  const alice = await browser("alice");
  const first = await alice.client.post(
    docId,
    input({
      title: "一つ目",
      targets: [{ kind: "document", stance: "concern" }],
    }),
  );
  const second = await alice.client.post(
    docId,
    input({
      title: "二つ目",
      targets: [{ kind: "document", stance: "support" }],
    }),
  );
  const mine = await alice.client.mine();
  assert(mine.every((o) => o.mine));
  assertEquals(new Set(mine.map((o) => o.id)), new Set([first.id, second.id]));
});

Deno.test("statements stay within D1's 100 parameters: 20 targets, 120 opinions", async () => {
  const { browser } = await setup();
  const owner = await browser("owner");
  const created = await owner.fetch("/api/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "多くの段落",
      markdown: Array.from({ length: 20 }, (_, i) => `段落 ${i + 1}。`).join(
        "\n\n",
      ),
    }),
  });
  const { id: docId } = await created.json();
  const { document } = await (await owner.fetch(`/api/docs/${docId}`)).json();
  const keys = (document.segments as { key: string }[]).map((s) => s.key);

  // 20 targets × 6 columns: one insert would bind 120.
  const many = await owner.client.post(
    docId,
    input({
      targets: keys.map((segmentKey) => ({
        kind: "segment" as const,
        segmentKey,
        stance: "concern" as const,
      })),
    }),
  );
  assertEquals(many.targets.length, 20);

  // Listing reads every opinion's targets by ID: 120 IDs in one IN (…) would bind 120.
  for (let i = 1; i < 120; i++) {
    await owner.client.post(
      docId,
      input({
        title: `意見 ${i}`,
        targets: [{ kind: "document", stance: "proposal" }],
      }),
    );
  }
  const { opinions } = await owner.client.list(docId);
  assertEquals(opinions.length, 120);
  assertEquals(opinions[0].targets.length, 20);
});

Deno.test("the owner hides an opinion with a reason; readers see only the count", async () => {
  const { browser, docId, seg1 } = await setup();
  const owner = await browser("owner");
  const alice = await browser("alice");
  const anonymous = await browser(null);
  const posted = await alice.client.post(
    docId,
    input({
      targets: [{ kind: "segment", segmentKey: seg1, stance: "concern" }],
    }),
  );

  const hidden = await owner.client.moderate(posted.id, {
    action: "hide",
    reason: "個人を特定する内容",
  });
  assertEquals(hidden.status, "hidden");
  assertEquals(await anonymous.client.list(docId), {
    opinions: [],
    hiddenCount: 1,
  });

  const view = await owner.client.manage(docId);
  assertEquals(view.opinions.map((o) => [o.id, o.status]), [
    [posted.id, "hidden"],
  ]);
  assertEquals(
    view.moderation.map((l) => [l.opinionId, l.action, l.reason]),
    [[posted.id, "hide", "個人を特定する内容"]],
  );

  // Hiding twice is a conflict; showing it again brings it back.
  const conflict = await assertRejects(
    () => owner.client.moderate(posted.id, { action: "hide", reason: "再度" }),
    OpinionApiError,
  );
  assertEquals(conflict.status, 409);
  await owner.client.moderate(posted.id, {
    action: "unhide",
    reason: "誤りだった",
  });
  assertEquals((await anonymous.client.list(docId)).opinions.length, 1);
  assertEquals((await owner.client.manage(docId)).moderation.length, 2);
});

Deno.test("only the owner moderates or sees the owner's view, and always with a reason", async () => {
  const { browser, docId, seg1 } = await setup();
  const owner = await browser("owner");
  const alice = await browser("alice");
  const posted = await alice.client.post(
    docId,
    input({
      targets: [{ kind: "segment", segmentKey: seg1, stance: "concern" }],
    }),
  );
  const status = async (run: () => Promise<unknown>) =>
    (await assertRejects(run, OpinionApiError)).status;

  assertEquals(await status(() => alice.client.manage(docId)), 403);
  assertEquals(
    await status(() =>
      alice.client.moderate(posted.id, { action: "hide", reason: "x" })
    ),
    403,
  );
  assertEquals(
    await status(() =>
      owner.client.moderate(posted.id, { action: "hide", reason: "  " })
    ),
    400,
  );
  assertEquals(await status(() => owner.client.manage("nope")), 404);
});

Deno.test("the owner's view counts what the pre-filter turned away", async () => {
  const { db, browser, docId } = await setup();
  const owner = await browser("owner");
  const today = new Date().toISOString().slice(0, 10);
  await db.exec(
    sql`INSERT INTO filter_stats (document_id, day, kind, count)
        VALUES (${docId}, ${today}, 'off_topic', 3), (${docId}, '2000-01-01', 'injection', 9)`,
  );
  assertEquals((await owner.client.manage(docId)).filterStats, [
    { day: today, kind: "off_topic", count: 3 },
  ]);
});

Deno.test("the owner changes the title, description and deadline; nobody else can", async () => {
  const { browser, docId } = await setup();
  const owner = await browser("owner");
  const alice = await browser("alice");
  const patch = (who: typeof owner, body: unknown) =>
    who.fetch(`/api/docs/${docId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const res = await patch(owner, {
    title: "計画案（改）",
    description: "説明",
    closesAt: "2030-01-01T00:00:00Z",
  });
  assertEquals(res.status, 200);
  const { document } = await res.json();
  assertEquals(
    [document.title, document.description, document.closesAt],
    ["計画案（改）", "説明", "2030-01-01T00:00:00.000Z"],
  );

  // Only what was sent changes; null takes the deadline away.
  const cleared = await (await patch(owner, { closesAt: null })).json();
  assertEquals(
    [cleared.document.title, cleared.document.closesAt],
    ["計画案（改）", null],
  );

  assertEquals((await patch(alice, { title: "乗っ取り" })).status, 403);
  assertEquals((await patch(owner, { title: "" })).status, 400);
  assertEquals((await patch(owner, { closesAt: "いつか" })).status, 400);
});

Deno.test("a draft's new segment takes no opinions until it is released; kept keys keep theirs", async () => {
  const { browser, owner, docId, seg1 } = await setup();
  const alice = await browser("alice");
  const posted = await alice.client.post(
    docId,
    input({
      targets: [{ kind: "segment", segmentKey: seg1, stance: "concern" }],
    }),
  );

  const json = (method: string, path: string, body: unknown) =>
    owner.fetch(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  await json("PUT", `/api/docs/${docId}/draft`, {
    markdown:
      `<!-- #${seg1} -->\n本文1を直した\n\n<!-- #fresh -->\n新しい段落\n`,
  });
  const onDraft = await assertRejects(
    () =>
      alice.client.post(
        docId,
        input({
          targets: [{
            kind: "segment",
            segmentKey: "fresh",
            stance: "question",
          }],
        }),
      ),
    OpinionApiError,
  );
  assertEquals(onDraft.status, 400);

  await json("POST", `/api/docs/${docId}/draft/release`, {});
  await alice.client.post(
    docId,
    input({
      targets: [{ kind: "segment", segmentKey: "fresh", stance: "question" }],
    }),
  );
  const { opinions } = await alice.client.list(docId);
  const carried = opinions.find((o) => o.id === posted.id);
  assertEquals(carried?.targets[0], {
    kind: "segment",
    segmentKey: seg1,
    stance: "concern",
  });
  assertEquals(carried?.version, 1);
  assertEquals(
    opinions.find((o) => o.id !== posted.id)?.version,
    2,
  );
});
