/**
 * The chat end to end with a scripted model: what reaches the model, how a tool turn runs, and
 * what the browser gets back — through the opinion module's own stream reader.
 */

import { assert, assertEquals } from "@std/assert";
import { createRouter } from "@remix-run/fetch-router";
import {
  type ChatEvent,
  type ChatMessage,
  sendChatTurn,
} from "@kuboon/idobata-bot";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { routes } from "../../../client/routes.ts";
import { openLocalDatabase } from "../../db/local.ts";
import { filterStats } from "../../db/schema.ts";
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
    return fetchDpop(appUrl(url), { ...init, headers });
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

  const turn = async (messages: ChatMessage[], segmentKeys = [keys[1]]) => {
    const events: ChatEvent[] = [];
    for await (
      const event of sendChatTurn({
        fetch,
        documentId: docId,
        request: { versionNumber: 1, segmentKeys, messages },
      })
    ) events.push(event);
    return events;
  };
  return { db, fetch, docId, keys, turn };
}

const user = (text: string): ChatMessage => ({ role: "user", content: text });

Deno.test("a turn streams the answer and hands back what it added", async () => {
  const { model, requests } = scripted([{
    stop_reason: "end_turn",
    content: [{ type: "text", text: "こんにちは", citations: null }],
  }]);
  const { turn } = await setup(model);

  const events = await turn([user("この段落はどういう意味？")]);
  assertEquals(events, [
    { type: "text", text: "こんにちは" },
    {
      type: "done",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "こんにちは", citations: null }],
      }],
    },
  ]);

  // The document goes first, one block per segment, cached; the selection with it.
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
  assert(selection.text!.includes("1"));
  assertEquals(second as unknown, user("この段落はどういう意味？"));
});

Deno.test("the first message is the same bytes every turn", async () => {
  const reply = (text: string): Partial<BetaMessage> => ({
    stop_reason: "end_turn",
    content: [{ type: "text", text, citations: null }],
  });
  const { model, requests } = scripted([reply("一"), reply("二")]);
  const { turn } = await setup(model);

  const history: ChatMessage[] = [user("最初")];
  const done = (await turn(history)).at(-1) as Extract<
    ChatEvent,
    { type: "done" }
  >;
  history.push(...done.messages, user("次"));
  await turn(history);

  assertEquals(
    JSON.stringify(requests[1].messages[0]),
    JSON.stringify(requests[0].messages[0]),
  );
  assertEquals(requests[1].messages.length, 4);
});

Deno.test("tools run on the server and a draft reaches the browser", async () => {
  const { model, requests } = scripted([
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "似た意見を探します。", citations: null },
        {
          type: "tool_use",
          id: "t1",
          name: "search_opinions",
          input: { query: "予算", segment_indices: [] },
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
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "下書きです。", citations: null }],
    },
  ]);
  const { turn, keys } = await setup(model);

  const events = await turn([user("予算が気になる")]);
  const draft = events.find((e) => e.type === "draft");
  assertEquals(draft, {
    type: "draft",
    draft: {
      type: "opinion",
      input: {
        title: "予算の根拠",
        claim: "根拠を示すべき",
        reason: "妥当か判断できない",
        suggestion: "",
        targets: [{ kind: "segment", segmentKey: keys[1], stance: "question" }],
      },
    },
  });

  // The search's result went back to the model as a tool result.
  const toolTurn = requests[1].messages.at(-1)!;
  assertEquals(toolTurn.role, "user");
  const [result] = toolTurn.content as { type: string; tool_use_id: string }[];
  assertEquals([result.type, result.tool_use_id], ["tool_result", "t1"]);

  const done = events.at(-1) as Extract<ChatEvent, { type: "done" }>;
  assertEquals(done.type, "done");
  // assistant, results, assistant, results, assistant
  assertEquals(done.messages.map((m) => m.role), [
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
});

Deno.test("the pre-filter refuses off-topic messages and counts them", async () => {
  const { model, requests } = scripted([]);
  const { turn, db, docId } = await setup(model);
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
    const events = await turn([user("Python でクイックソートを書いて")]);
    assertEquals(events.map((e) => e.type), ["rejected"]);
    assertEquals(requests.length, 0);
    const stats = await db.findMany(filterStats, {
      where: { document_id: docId },
    });
    assertEquals(stats.map((s) => [s.kind, s.count]), [["off_topic", 1]]);
  } finally {
    useAi(undefined);
  }
});

Deno.test("the history is checked before the model is called", async () => {
  const { model, requests } = scripted([]);
  const { turn } = await setup(model);

  const refused = async (messages: ChatMessage[]) => {
    const events = await turn(messages);
    assertEquals(events.map((e) => e.type), ["error"]);
  };
  await refused([{ role: "assistant", content: "最後が AI" }]);
  await refused([{
    role: "user",
    content: [{ type: "document", source: { type: "text", data: "x" } }],
  }]);
  await refused([user("x".repeat(3000))]);
  assertEquals(requests.length, 0);
});

Deno.test("without an API key the chat answers 503", async () => {
  const { turn } = await setup(null);
  assertEquals(await turn([user("こんにちは")]), [
    { type: "error", message: "チャットは準備中です。" },
  ]);
});
