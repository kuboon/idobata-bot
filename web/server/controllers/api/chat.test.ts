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

import { routes } from "../../../client/routes.ts";
import { openLocalDatabase } from "../../db/local.ts";
import { filterStats } from "../../db/schema.ts";
import { REJECTED_MESSAGE } from "../../lib/chat/mod.ts";
import { useAi } from "../../lib/chat/filter.ts";
import type {
  ChatModel,
  ModelReply,
  ModelRequest,
} from "../../lib/chat/model.ts";
import { appUrl, dpopClientFor, fakeIdp } from "../../testing/auth.ts";
import { createChatController } from "./chat.ts";
import { createDocsController } from "./docs.ts";
import { createOpinionsController } from "./opinions.ts";

/** A model that answers with the given replies in turn and records what it was asked. */
function scripted(replies: ModelReply[]) {
  const requests: ModelRequest[] = [];
  const model: ChatModel = {
    run(request, onText) {
      requests.push(structuredClone(request));
      const reply = replies.shift();
      if (!reply) throw new Error("no more replies");
      if (reply.content) onText(reply.content);
      return Promise.resolve(reply);
    },
  };
  return { model, requests };
}

/** A reply that ends the turn. */
const reply = (content: string): ModelReply => ({
  content,
  toolCalls: [],
  finishReason: "stop",
});

/** A reply that calls tools. */
const calling = (
  content: string,
  ...calls: [id: string, name: string, args: unknown][]
): ModelReply => ({
  content,
  toolCalls: calls.map(([id, name, args]) => ({
    id,
    name,
    arguments: JSON.stringify(args),
  })),
  finishReason: "tool_calls",
});

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

Deno.test("a turn streams the answer, with the model's message as its state", async () => {
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
      state: JSON.stringify({ role: "assistant", content: "こんにちは" }),
    },
  ]);

  // The system message first: the instructions, then every block, numbered.
  const [system, second] = requests[0].messages;
  assertEquals(system.role, "system");
  assert(system.content.includes("# 文書「計画案」"));
  assert(system.content.endsWith("[0]\n# 題\n\n[1]\n本文1\n\n[2]\n本文2"));
  assertEquals(second, { role: "user", content: "この段落はどういう意味？" });
  assertEquals(
    requests[0].tools.map((t) => t.function.name),
    [
      "search_opinions",
      "get_opinion",
      "get_selection",
      "select_segments",
      "draft_opinion",
    ],
  );
});

Deno.test("the system message is the same bytes every turn", async () => {
  const { model, requests } = scripted([reply("一"), reply("二")]);
  const { session } = await setup(model);
  const { chat } = session();

  await chat.send("最初");
  await chat.send("次");

  assertEquals(
    JSON.stringify(requests[1].messages[0]),
    JSON.stringify(requests[0].messages[0]),
  );
  // The system message, then 最初, the answer replayed from its state, and 次.
  assertEquals(requests[1].messages.slice(1), [
    { role: "user", content: "最初" },
    { role: "assistant", content: "一" },
    { role: "user", content: "次" },
  ]);
});

Deno.test("search runs on the server; a draft opens in the browser and its answer goes back", async () => {
  const { model, requests } = scripted([
    calling("この段落の意見を見ます。", [
      "t1",
      "search_opinions",
      { query: "", segment_indices: [1] },
    ]),
    calling("", ["t2", "draft_opinion", {
      type: "opinion",
      support_opinion_id: "",
      title: "予算の根拠",
      body: "根拠を示すべき。妥当か判断できない。",
      targets: [{
        kind: "segment",
        segment_index: 1,
        opinion_id: "",
        stance: "question",
      }],
    }]),
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
      body: "根拠を示すべき。妥当か判断できない。",
      targets: [{ kind: "segment", segmentKey: keys[1], stance: "question" }],
    },
  }]);

  // The search's result went back to the model inside the first request.
  const toolTurn = requests[1].messages.at(-1)!;
  assertEquals(toolTurn.role, "tool");
  assertEquals((toolTurn as { tool_call_id: string }).tool_call_id, "t1");

  // The browser's answer went back in a second request, after the replayed turn — with the
  // model's own arguments, not the draft the browser was handed.
  assertEquals(requests.length, 3);
  const replayed = requests[2].messages.at(-2)!;
  assertEquals(
    (replayed as { tool_calls: { function: { arguments: string } }[] })
      .tool_calls[0].function.arguments,
    JSON.stringify({
      type: "opinion",
      support_opinion_id: "",
      title: "予算の根拠",
      body: "根拠を示すべき。妥当か判断できない。",
      targets: [{
        kind: "segment",
        segment_index: 1,
        opinion_id: "",
        stance: "question",
      }],
    }),
  );
  assertEquals(requests[2].messages.at(-1), {
    role: "tool",
    tool_call_id: "t2",
    content: "読者が投稿しました。",
  });
  assertEquals(
    (chat.messages.at(-1) as { content: string }).content,
    "投稿ありがとうございました。",
  );
});

Deno.test("the page's tools read and set the selection in the browser", async () => {
  const { model, requests } = scripted([
    calling("", ["g1", "get_selection", {}]),
    calling("それはこの部分ですね。", ["s1", "select_segments", {
      segment_indices: [2],
    }]),
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
  assertEquals(requests.length, 3);
  assertEquals(requests[1].messages.at(-1), {
    role: "tool",
    tool_call_id: "g1",
    content: "読者は段落 1 を選んでいます。",
  });
  assertEquals(requests[2].messages.at(-1), {
    role: "tool",
    tool_call_id: "s1",
    content: "選びました。",
  });
});

Deno.test("a draft that does not check out, or arguments that are not JSON, go back to the model", async () => {
  const { model, requests } = scripted([
    {
      content: "",
      toolCalls: [
        {
          id: "t1",
          name: "draft_opinion",
          arguments: JSON.stringify({
            type: "opinion",
            support_opinion_id: "",
            title: "x",
            body: "",
            targets: [{
              kind: "segment",
              segment_index: 99,
              opinion_id: "",
              stance: "concern",
            }],
          }),
        },
        { id: "t2", name: "search_opinions", arguments: "{壊れた" },
      ],
      finishReason: "tool_calls",
    },
    reply("段落を確かめます。"),
  ]);
  const { session } = await setup(model);
  const { chat, drafts } = session();

  await chat.send("意見があります");
  assertEquals(drafts, []);
  const results = requests[1].messages.slice(-2) as {
    tool_call_id: string;
    content: string;
  }[];
  assertEquals(results.map((r) => r.tool_call_id), ["t1", "t2"]);
  assert(results.every((r) => r.content.startsWith("エラー: ")));
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
  // A state whose tool calls are not the ones this server writes.
  await refused([
    {
      role: "assistant",
      content: "",
      state: JSON.stringify({
        role: "assistant",
        content: "",
        tool_calls: [{ id: "x", function: { name: "f", arguments: {} } }],
      }),
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

Deno.test("without the Workers AI binding the chat answers 503", async () => {
  const { post } = await setup(null);
  const response = await post([{ role: "user", content: "こんにちは" }]);
  assertEquals(response.status, 503);
  assertEquals(await response.json(), { error: "チャットは準備中です。" });
});
