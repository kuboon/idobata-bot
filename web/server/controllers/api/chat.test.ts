/**
 * The chat end to end with a scripted model, through `@remix-kbn/helper-agent`'s own session —
 * what the browser runs: what reaches the model, how a tool turn runs, and how a draft comes back
 * as the browser's `draft_opinion` call.
 */

import { assert, assertEquals } from "@std/assert";
import { createRouter } from "@remix-run/fetch-router";
import { type ChatDraft, chatUrl, DRAFT_TOOL_NAME } from "@kuboon/idobata-bot";
import {
  type ClientTool,
  HelperAgentSession,
} from "@remix-kbn/helper-agent/client";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { routes } from "../../../client/routes.ts";
import { openLocalDatabase } from "../../db/local.ts";
import { filterStats } from "../../db/schema.ts";
import { REJECTED_MESSAGE } from "../../lib/chat/mod.ts";
import { useAi } from "../../lib/chat/filter.ts";
import type { ChatModel, ModelRequest } from "../../lib/chat/model.ts";
import { appUrl, dpopClientFor, fakeIdp } from "../../testing/auth.ts";
import { createChatController } from "./chat.ts";
import { createDocsController } from "./docs.ts";
import { createOpinionsController } from "./opinions.ts";

/** A model that answers with the given messages in turn and records what it was asked. */
function scripted(replies: Partial<BetaMessage>[]) {
  const requests: ModelRequest[] = [];
  const model: ChatModel = {
    run(request, onText) {
      requests.push(structuredClone(request));
      const reply = replies.shift();
      if (!reply) throw new Error("no more replies");
      for (const b of reply.content ?? []) {
        if (b.type === "text") onText(b.text);
      }
      return Promise.resolve(reply as BetaMessage);
    },
  };
  return { model, requests };
}

async function setup(model: ChatModel | null) {
  const db = await openLocalDatabase(":memory:");
  useAi(undefined);
  const idp = await fakeIdp();
  const router = createRouter();
  router.map(routes.api.docs, createDocsController(idp.auth) as never);
  router.map(routes.api.opinions, createOpinionsController(idp.auth) as never);
  router.map(routes.api.chat, createChatController(() => model) as never);

  const { fetchDpop, thumbprint } = await dpopClientFor(router);
  const token = await idp.token("owner", thumbprint, { nickname: "owner" });
  const fetch = (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `DPoP ${token}`);
    return fetchDpop(url.startsWith("/") ? appUrl(url) : url, {
      ...init,
      headers,
    });
  };

  const created = await fetch("/api/docs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "計画案",
      markdown: "# 題\n\n本文1\n\n本文2",
    }),
  });
  const { id: docId } = await created.json();
  const { document } = await (await fetch(`/api/docs/${docId}`)).json();
  const keys = (document.segments as { key: string }[]).map((s) => s.key);

  /** A conversation, as the page holds it: the drafts it was handed, and what it answers. */
  const session = (answer = "読者が投稿しました。") => {
    const drafts: ChatDraft[] = [];
    const pageCalls: [string, unknown][] = [];
    const pageTool = (name: string, result: string): ClientTool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      run(input) {
        pageCalls.push([name, input]);
        return result;
      },
    });
    const draftTool: ClientTool = {
      name: DRAFT_TOOL_NAME,
      description: "投稿ダイアログを開く",
      inputSchema: { type: "object" },
      run(input) {
        drafts.push(input as ChatDraft);
        return answer;
      },
    };
    const chat = new HelperAgentSession({
      transport: {
        url: appUrl(chatUrl(docId, 1)),
        fetch: async (request) =>
          fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: await request.text(),
          }),
      },
      tools: [
        draftTool,
        pageTool("get_selection", "読者は段落 1 を選んでいます。"),
        pageTool("select_segments", "選びました。"),
      ],
    });
    return { chat, drafts, pageCalls };
  };
  /** Posts a transcript as is, for the ones a page would not send. */
  const post = (messages: unknown[]) =>
    fetch(chatUrl(docId, 1), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
  return { db, docId, keys, session, post };
}

const reply = (text: string): Partial<BetaMessage> => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text, citations: null }],
});

Deno.test("a turn streams the answer, with the API's blocks as its state", async () => {
  const { model, requests } = scripted([reply("こんにちは")]);
  const { session } = await setup(model);
  const { chat } = session();

  await chat.send("この段落はどういう意味？");
  assertEquals(chat.error, null);
  assertEquals(chat.messages, [
    { role: "user", content: "この段落はどういう意味？" },
    {
      role: "assistant",
      content: "こんにちは",
      state: JSON.stringify([
        { type: "text", text: "こんにちは", citations: null },
      ]),
    },
  ]);

  // The document goes first, one block per segment, cached — the same for every reader.
  const [first, second] = requests[0].messages;
  assertEquals(first.role, "user");
  const [doc, selection] = first.content as never[] as {
    type: string;
    source?: { content: { text: string }[] };
    cache_control?: unknown;
    text?: string;
  }[];
  assertEquals(doc.type, "document");
  assertEquals(doc.source!.content.map((b) => b.text), [
    "# 題",
    "本文1",
    "本文2",
  ]);
  assertEquals(doc.cache_control, { type: "ephemeral", ttl: "1h" });
  assert(selection.text!.includes("get_selection"));
  assertEquals(second as unknown, {
    role: "user",
    content: [{ type: "text", text: "この段落はどういう意味？" }],
  });
});

Deno.test("the first message is the same bytes every turn", async () => {
  const { model, requests } = scripted([reply("一"), reply("二")]);
  const { session } = await setup(model);
  const { chat } = session();

  await chat.send("最初");
  await chat.send("次");

  assertEquals(
    JSON.stringify(requests[1].messages[0]),
    JSON.stringify(requests[0].messages[0]),
  );
  // The document, then 最初, the answer replayed from its state, and 次.
  assertEquals(requests[1].messages.length, 4);
  assertEquals(
    requests[1].messages[2].content,
    [{ type: "text", text: "一" }] as never,
  );
});

Deno.test("search runs on the server; a draft opens in the browser and its answer goes back", async () => {
  const { model, requests } = scripted([
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "この段落の意見を見ます。", citations: null },
        {
          type: "tool_use",
          id: "t1",
          name: "search_opinions",
          input: { query: "", segment_indices: [1] },
        },
      ],
    },
    {
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "t2",
        name: "draft_opinion",
        input: {
          type: "opinion",
          support_opinion_id: "",
          title: "予算の根拠",
          claim: "根拠を示すべき",
          reason: "妥当か判断できない",
          suggestion: "",
          targets: [{
            kind: "segment",
            segment_index: 1,
            opinion_id: "",
            stance: "question",
          }],
        },
      }],
    },
    reply("投稿ありがとうございました。"),
  ]);
  const { session, keys } = await setup(model);
  const { chat, drafts } = session();

  await chat.send("予算が気になる");
  assertEquals(chat.error, null);

  // The browser was handed the draft with segment keys, not block numbers.
  assertEquals(drafts, [{
    type: "opinion",
    input: {
      title: "予算の根拠",
      claim: "根拠を示すべき",
      reason: "妥当か判断できない",
      suggestion: "",
      targets: [{ kind: "segment", segmentKey: keys[1], stance: "question" }],
    },
  }]);

  // The search's result went back to the model inside the first request.
  const toolTurn = requests[1].messages.at(-1)!;
  assertEquals(toolTurn.role, "user");
  const [result] = toolTurn.content as { type: string; tool_use_id: string }[];
  assertEquals([result.type, result.tool_use_id], ["tool_result", "t1"]);

  // The browser's answer went back in a second request, after the replayed turn.
  assertEquals(requests.length, 3);
  const answered = requests[2].messages.at(-1)!;
  assertEquals(answered.content as unknown, [{
    type: "tool_result",
    tool_use_id: "t2",
    content: "読者が投稿しました。",
  }]);
  assertEquals(chat.messages.at(-1), {
    role: "assistant",
    content: "投稿ありがとうございました。",
    state: JSON.stringify([
      { type: "text", text: "投稿ありがとうございました。", citations: null },
    ]),
  });
});

Deno.test("the page's tools read and set the selection in the browser", async () => {
  const { model, requests } = scripted([
    {
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "g1",
        name: "get_selection",
        input: {},
      }],
    },
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "それはこの部分ですね。", citations: null },
        {
          type: "tool_use",
          id: "s1",
          name: "select_segments",
          input: { segment_indices: [2] },
        },
      ],
    },
    reply("この段落への意見はまだありません。"),
  ]);
  const { session } = await setup(model);
  const { chat, pageCalls } = session();

  await chat.send("期間が短いと思う");
  assertEquals(chat.error, null);
  assertEquals(pageCalls, [
    ["get_selection", {}],
    ["select_segments", { segment_indices: [2] }],
  ]);
  // Each answer went back to the model as the result of its call.
  assertEquals(requests.length, 3);
  assertEquals(requests[1].messages.at(-1)!.content as unknown, [{
    type: "tool_result",
    tool_use_id: "g1",
    content: "読者は段落 1 を選んでいます。",
  }]);
  assertEquals(requests[2].messages.at(-1)!.content as unknown, [{
    type: "tool_result",
    tool_use_id: "s1",
    content: "選びました。",
  }]);
});

Deno.test("a draft that does not check out goes back to the model, not the browser", async () => {
  const { model, requests } = scripted([
    {
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "t1",
        name: "draft_opinion",
        input: {
          type: "opinion",
          support_opinion_id: "",
          title: "x",
          claim: "y",
          reason: "z",
          suggestion: "",
          targets: [{
            kind: "segment",
            segment_index: 99,
            opinion_id: "",
            stance: "concern",
          }],
        },
      }],
    },
    reply("段落を確かめます。"),
  ]);
  const { session } = await setup(model);
  const { chat, drafts } = session();

  await chat.send("意見があります");
  assertEquals(drafts, []);
  const result = (requests[1].messages.at(-1)!.content as {
    is_error?: boolean;
  }[])[0];
  assertEquals(result.is_error, true);
});

Deno.test("the pre-filter refuses off-topic messages and counts them", async () => {
  const { model, requests } = scripted([]);
  const { session, db, docId } = await setup(model);
  useAi({
    run: () =>
      Promise.resolve({
        answers: {
          on_topic: { noul: 0.01 },
          kind: {
            choice: "off_topic",
            probabilities: { off_topic: 0.97 },
          },
        },
      }),
  });
  try {
    const { chat } = session();
    await chat.send("Python でクイックソートを書いて");
    assertEquals(chat.messages.at(-1), {
      role: "assistant",
      content: REJECTED_MESSAGE,
    });
    assertEquals(requests.length, 0);
    const stats = await db.findMany(filterStats, {
      where: { document_id: docId },
    });
    assertEquals(stats.map((s) => [s.kind, s.count]), [["off_topic", 1]]);
  } finally {
    useAi(undefined);
  }
});

Deno.test("the transcript is checked before the model is called", async () => {
  const { model, requests } = scripted([]);
  const { post } = await setup(model);

  const refused = async (messages: unknown[]) => {
    const response = await post(messages);
    const body = await response.text();
    assert(
      !response.ok || body.includes('"type":"error"'),
      `accepted: ${body}`,
    );
  };
  await refused([{ role: "assistant", content: "最後が AI" }]);
  // A state holding a block the server never writes.
  await refused([
    {
      role: "assistant",
      content: "",
      state: JSON.stringify([{
        type: "document",
        source: { type: "text", data: "x" },
      }]),
    },
    { role: "user", content: "x" },
  ]);
  // A result for a call nobody made.
  await refused([
    { role: "user", content: "x" },
    { role: "tool", results: [{ id: "nobody", content: "y" }] },
  ]);
  await refused([{ role: "user", content: "x".repeat(3000) }]);
  assertEquals(requests.length, 0);
});

Deno.test("without an API key the chat answers 503", async () => {
  const { post } = await setup(null);
  const response = await post([{ role: "user", content: "こんにちは" }]);
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: "チャットは準備中です。" });
});
