/**
 * The AI chat about a document (docs/architecture.md §5), as an agent for `@remix-kbn/helper-agent`'s
 * controller: check the transcript the browser sent, put the reader's message through the
 * pre-filter, then run the model — and the server's tools — until it answers or asks the browser
 * to act on the page: read or set the selection, or open the posting dialog (`draft_opinion`).
 *
 * Nothing is stored. The browser holds the transcript and sends all of it every turn; each
 * assistant message carries the API's raw content blocks as its opaque `state`, which comes back
 * here and is replayed as is, so thinking and the cached prefix survive the round trip.
 */

import { CHAT_MESSAGE_MAX_LENGTH } from "@kuboon/idobata-bot";
import type {
  Agent,
  AgentEvent,
  AgentInput,
  ChatMessage,
  ToolResult,
} from "@remix-kbn/helper-agent/controller";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { sql } from "@remix-run/data-table";
import { getDb } from "../../db/mod.ts";
import { type DocumentDetail, getDocument, isOpen } from "../documents.ts";
import { filterMessage } from "./filter.ts";
import type { ChatModel } from "./model.ts";
import { firstMessage, systemBlocks, TOOLS } from "./prompt.ts";
import { type DraftInput, resolveDraft, runTool } from "./tools.ts";

/** How many messages a conversation may hold: about 30 exchanges with their tool turns. */
export const HISTORY_MAX_MESSAGES = 120;
/** The request's size in bytes — a guard on cost, well under the context window. */
export const HISTORY_MAX_BYTES = 600_000;
/** Model calls in one turn: a search, a look at one opinion, a draft, and the answer. */
export const TOOL_ROUNDS_MAX = 5;
/** The browser runs this tool: it opens the posting dialog. */
export const DRAFT_TOOL = "draft_opinion";
/** Tools the browser runs on the page as they are: reading and setting the selection. */
export const PAGE_TOOLS: ReadonlySet<string> = new Set([
  "get_selection",
  "select_segments",
]);

/** A request the chat refuses before streaming: the HTTP status and why. */
export class ChatError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ChatError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (message: string): never => {
  throw new ChatError(400, message);
};

/**
 * One block of the browser's history, rebuilt from the fields it may have. What the server
 * returned comes back here, so these are the kinds a turn produces; a document or an image could
 * only be the browser's own, and a `cache_control` would move the cache's breakpoints.
 */
function block(value: unknown): BetaContentBlockParam {
  if (!isRecord(value)) return fail("invalid content block");
  switch (value.type) {
    case "text":
      if (typeof value.text !== "string") return fail("invalid text block");
      return Array.isArray(value.citations) && value.citations.length > 0
        ? {
          type: "text",
          text: value.text,
          citations: value.citations as never,
        }
        : { type: "text", text: value.text };
    case "thinking":
      if (
        typeof value.thinking !== "string" ||
        typeof value.signature !== "string"
      ) return fail("invalid thinking block");
      return {
        type: "thinking",
        thinking: value.thinking,
        signature: value.signature,
      };
    case "redacted_thinking":
      if (typeof value.data !== "string") return fail("invalid thinking block");
      return { type: "redacted_thinking", data: value.data };
    case "tool_use":
      if (
        typeof value.id !== "string" || typeof value.name !== "string" ||
        !isRecord(value.input)
      ) return fail("invalid tool_use block");
      return {
        type: "tool_use",
        id: value.id,
        name: value.name,
        input: value.input,
      };
    case "tool_result": {
      if (typeof value.tool_use_id !== "string") {
        return fail("invalid tool_result block");
      }
      const content = typeof value.content === "string"
        ? value.content
        : Array.isArray(value.content)
        ? value.content.map((b) => {
          if (!isRecord(b) || b.type !== "text" || typeof b.text !== "string") {
            return fail("invalid tool_result block");
          }
          return { type: "text" as const, text: b.text };
        })
        : fail("invalid tool_result block");
      return {
        type: "tool_result",
        tool_use_id: value.tool_use_id,
        content,
        ...(value.is_error === true ? { is_error: true } : {}),
      };
    }
    default:
      return fail(`content block type not allowed: ${String(value.type)}`);
  }
}

/**
 * An assistant message's API content, from its `state` when that reads back as blocks this
 * server writes, and otherwise rebuilt from its text and calls.
 */
function assistantContent(
  message: Extract<ChatMessage, { role: "assistant" }>,
): BetaContentBlockParam[] {
  if (message.state !== undefined) {
    try {
      const parsed = JSON.parse(message.state);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.map(block);
    } catch (error) {
      if (error instanceof ChatError) throw error;
      // Not JSON: rebuild it below.
    }
  }
  const content: BetaContentBlockParam[] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.toolCalls ?? []) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: isRecord(call.input) ? call.input : {},
    });
  }
  return content;
}

/** The longest tool result the browser may send back: a sentence about the dialog. */
const TOOL_RESULT_MAX_LENGTH = 2000;

/**
 * The transcript as the Claude API's messages, after the document. Messages of the same role
 * next to each other are merged — tool results are a `user` turn, and the server's and the
 * browser's results for one assistant message arrive as two.
 *
 * @throws {ChatError} 400 when it is not a conversation this server could have had
 */
export function toModelMessages(
  messages: readonly ChatMessage[],
): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  const push = (
    role: "user" | "assistant",
    content: BetaContentBlockParam[],
  ) => {
    if (content.length === 0) return;
    const last = out.at(-1);
    if (last?.role === role && Array.isArray(last.content)) {
      last.content = [...last.content, ...content];
    } else out.push({ role, content });
  };
  const called = new Set<string>();

  for (const message of messages) {
    if (!isRecord(message)) return fail("invalid message");
    if (message.role === "user") {
      if (typeof message.content !== "string") return fail("invalid message");
      push("user", [{ type: "text", text: message.content }]);
    } else if (message.role === "assistant") {
      const content = assistantContent(message);
      for (const b of content) if (b.type === "tool_use") called.add(b.id);
      push("assistant", content);
    } else if (message.role === "tool" && Array.isArray(message.results)) {
      push(
        "user",
        message.results.map((r): BetaToolResultBlockParam => {
          if (
            !isRecord(r) || typeof r.id !== "string" || !called.has(r.id) ||
            typeof r.content !== "string" ||
            r.content.length > TOOL_RESULT_MAX_LENGTH
          ) return fail("invalid tool result");
          return {
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
            ...(r.isError === true ? { is_error: true } : {}),
          };
        }),
      );
    } else return fail("invalid message");
  }
  return out;
}

/** The text a message shows, for the pre-filter's view of the conversation. */
function plainText(message: ChatMessage): string {
  return message.role === "tool" ? "" : message.content;
}

/** Counts a refused message: the day and the kind, never its text (docs/architecture.md §5). */
async function countRejection(documentId: string, kind: string) {
  const day = new Date().toISOString().slice(0, 10);
  await getDb().exec(
    sql`INSERT INTO filter_stats (document_id, day, kind, count)
    VALUES (${documentId}, ${day}, ${kind}, 1)
    ON CONFLICT (document_id, day, kind) DO UPDATE SET count = count + 1`,
  );
}

export const REJECTED_MESSAGE =
  "この文書についてのご意見・ご質問をお聞かせください。文書と関係のない話題にはお答えできません。";

/**
 * Looks up the document and version a chat is about.
 *
 * @throws {ChatError} 404 when there is no such document or version, 403 after the deadline
 */
export async function chatDocument(
  documentId: string,
  versionNumber: number,
): Promise<DocumentDetail> {
  const document = await getDocument(documentId, versionNumber);
  if (!document) throw new ChatError(404, "not found");
  if (!isOpen(document.closesAt)) {
    throw new ChatError(403, "募集は終了しました。");
  }
  return document;
}

/**
 * Pushes events from callbacks and reads them as an async iterable — the model streams text
 * through a callback, and the agent yields.
 */
function channel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(value: T) {
      queue.push(value);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (queue.length > 0) yield queue.shift()!;
        else if (closed) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/**
 * The agent for one conversation. Every turn ends with exactly one `done` or `error`.
 *
 * @param document The document's version — it makes the first message, which must come out the
 *   same every turn
 * @param model The Claude API, or a scripted stand-in
 */
export function chatAgent(document: DocumentDetail, model: ChatModel): Agent {
  const context = { documentId: document.id, segments: document.segments };

  return {
    async *respond(input: AgentInput): AsyncGenerator<AgentEvent> {
      let history: BetaMessageParam[];
      try {
        history = toModelMessages(input.messages);
      } catch (error) {
        if (!(error instanceof ChatError)) throw error;
        yield { type: "error", message: error.message };
        return;
      }

      const last = input.messages.at(-1)!;
      if (last.role === "assistant") {
        yield {
          type: "error",
          message: "the last message must be the reader's",
        };
        return;
      }
      if (last.role === "user") {
        if (!last.content.trim()) {
          yield { type: "error", message: "empty message" };
          return;
        }
        if (last.content.length > CHAT_MESSAGE_MAX_LENGTH) {
          yield { type: "error", message: "メッセージが長すぎます。" };
          return;
        }
        const verdict = await filterMessage({
          title: document.title,
          headings: document.segments
            .filter((s) => s.kind === "heading")
            .map((s) => s.text),
          selected: [],
          recentTurns: input.messages.slice(-5, -1).map(plainText).filter(
            Boolean,
          ),
          message: last.content,
        });
        if (!verdict.ok) {
          await countRejection(document.id, verdict.kind);
          yield { type: "text", text: REJECTED_MESSAGE };
          yield { type: "done", reason: "end" };
          return;
        }
      }

      const prefix = [
        firstMessage(document.title, document.segments),
        ...history,
      ];
      const added: BetaMessageParam[] = [];

      for (let round = 0; round < TOOL_ROUNDS_MAX; round++) {
        // A new round is a new assistant message. The session closes the previous one's tool
        // results only on `text`, so a round that opens with a tool call and no words would be
        // filed before them (`@kuboon/chat-element` 0.1.0); an empty delta closes them.
        if (round > 0) yield { type: "text", text: "" };
        const texts = channel<string>();
        const running = model.run(
          {
            system: systemBlocks(),
            messages: [...prefix, ...added],
            tools: TOOLS,
          },
          (text) => texts.push(text),
          input.signal,
        ).finally(() => texts.close());
        // Keep a failure for the await below rather than an unhandled rejection meanwhile.
        running.catch(() => {});
        for await (const text of texts) yield { type: "text", text };

        let message;
        try {
          message = await running;
        } catch (error) {
          if (input.signal.aborted) return;
          console.error("chat model failed", error);
          yield {
            type: "error",
            message:
              "AI の応答に失敗しました。しばらくしてからもう一度お試しください。",
          };
          return;
        }

        yield { type: "state", state: JSON.stringify(message.content) };
        if (message.stop_reason === "refusal") {
          yield { type: "done", reason: "refusal" };
          return;
        }
        if (message.stop_reason === "max_tokens") {
          yield { type: "done", reason: "max-tokens" };
          return;
        }
        added.push({
          role: "assistant",
          content: message.content as BetaContentBlockParam[],
        });
        const calls = message.content.filter(
          (b): b is Extract<BetaContentBlock, { type: "tool_use" }> =>
            b.type === "tool_use",
        );
        if (message.stop_reason !== "tool_use" || calls.length === 0) {
          yield { type: "done", reason: "end" };
          return;
        }

        // The server's tools run here. The page's go to the browser: the selection, and a valid
        // draft, for which it opens the posting dialog and answers once the reader has left it.
        const results: ToolResult[] = [];
        let forBrowser = false;
        for (const call of calls) {
          if (PAGE_TOOLS.has(call.name)) {
            yield {
              type: "tool-call",
              call: { id: call.id, name: call.name, input: call.input },
            };
            forBrowser = true;
            continue;
          }
          if (call.name === DRAFT_TOOL) {
            const resolved = await resolveDraft(
              call.input as DraftInput,
              context,
            );
            if ("draft" in resolved) {
              yield {
                type: "tool-call",
                call: { id: call.id, name: call.name, input: resolved.draft },
              };
              forBrowser = true;
              continue;
            }
            yield {
              type: "tool-call",
              call: { id: call.id, name: call.name, input: call.input },
            };
            results.push({ id: call.id, ...resolved.error });
            continue;
          }
          yield {
            type: "tool-call",
            call: { id: call.id, name: call.name, input: call.input },
          };
          results.push({
            id: call.id,
            ...(await runTool(call.name, call.input, context)),
          });
        }
        for (const result of results) yield { type: "tool-result", result };
        if (forBrowser) {
          yield { type: "done", reason: "tools" };
          return;
        }
        added.push({
          role: "user",
          content: results.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        });
      }
      yield { type: "error", message: "AI の応答が長くなりすぎました。" };
    },
  };
}
