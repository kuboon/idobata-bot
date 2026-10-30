/**
 * Reading the model's answer, streamed or not, in the chat-completions shape and in Workers AI's
 * own — without a model: the chunks are written out here.
 */

import { assertEquals, assertMatch } from "@std/assert";

import { type AiBinding } from "./ai.ts";
import {
  CHAT_MODEL,
  readCompletion,
  readCompletionStream,
  workersAiModel,
} from "./model.ts";

/** A server-sent event stream of these chunks, split at awkward places. */
function sse(chunks: unknown[], extra = ""): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") +
    extra + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Seven bytes at a time: lines and multi-byte characters both get cut.
      for (let i = 0; i < bytes.length; i += 7) {
        controller.enqueue(bytes.slice(i, i + 7));
      }
      controller.close();
    },
  });
}

Deno.test("chat-completions deltas: text streams, tool calls are put back together", async () => {
  const seen: string[] = [];
  const reply = await readCompletionStream(
    sse([
      { choices: [{ delta: { reasoning_content: "考え中" } }] },
      { choices: [{ delta: { content: "段落を" } }] },
      { choices: [{ delta: { content: "見ます。" } }] },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "select_segments", arguments: '{"segment_' },
            }],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'indices":[2]}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ], ": keep-alive\n\n"),
    (t) => seen.push(t),
  );
  assertEquals(seen, ["段落を", "見ます。"]);
  assertEquals(reply, {
    content: "段落を見ます。",
    toolCalls: [{
      id: "call_1",
      name: "select_segments",
      arguments: '{"segment_indices":[2]}',
    }],
    finishReason: "tool_calls",
  });
});

Deno.test("Workers AI's own shape: response text and whole tool calls, with ids made up", async () => {
  const reply = await readCompletionStream(
    sse([
      { response: "はい" },
      { response: "、" },
      { tool_calls: [{ name: "get_selection", arguments: {} }] },
    ]),
    () => {},
  );
  assertEquals(reply.content, "はい、");
  assertEquals(reply.toolCalls.length, 1);
  assertEquals(reply.toolCalls[0].name, "get_selection");
  assertEquals(reply.toolCalls[0].arguments, "{}");
  assertMatch(reply.toolCalls[0].id, /^call_/);
  assertEquals(reply.finishReason, "tool_calls");
});

Deno.test("a cut-off answer says so", async () => {
  const reply = await readCompletionStream(
    sse([{
      choices: [{ delta: { content: "長い" }, finish_reason: "length" }],
    }]),
    () => {},
  );
  assertEquals(reply.finishReason, "length");
});

Deno.test("a non-streamed answer reads the same", () => {
  assertEquals(
    readCompletion({
      choices: [{
        message: {
          content: "こんにちは",
          tool_calls: [{
            id: "c",
            type: "function",
            function: { name: "get_opinion", arguments: '{"opinion_id":"o"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
    }),
    {
      content: "こんにちは",
      toolCalls: [{
        id: "c",
        name: "get_opinion",
        arguments: '{"opinion_id":"o"}',
      }],
      finishReason: "tool_calls",
    },
  );
});

Deno.test("the model is asked for qwen3.8, streamed, at low effort", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const ai: AiBinding = {
    run(model, input) {
      calls.push([model, input as Record<string, unknown>]);
      return Promise.resolve(
        sse([{
          choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        }]),
      );
    },
  };
  const reply = await workersAiModel(ai).run(
    { messages: [{ role: "user", content: "x" }], tools: [] },
    () => {},
  );
  assertEquals(reply.content, "ok");
  assertEquals(calls[0][0], CHAT_MODEL);
  assertEquals(CHAT_MODEL, "@cf/qwen/qwen3.8-27b");
  assertEquals(
    [calls[0][1].stream, calls[0][1].reasoning_effort],
    [true, "low"],
  );
});
