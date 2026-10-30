/**
 * The AI chat about a document (docs/architecture.md §5), as an agent for `@remix-kbn/helper-agent`'s
 * controller: check the transcript the browser sent, put the reader's message through the
 * pre-filter, then run the model — and the server's tools — until it answers or asks the browser
 * to act on the page: read or set the selection, or open the posting dialog (`draft_opinion`).
 *
 * Nothing is stored. The browser holds the transcript and sends all of it every turn; each
 * assistant message carries the model's own message (its text and tool calls, with the arguments
 * as the model wrote them) as its opaque `state`, which comes back here and is replayed, so the
 * model sees its earlier turns exactly as it wrote them.
 */

import { CHAT_MESSAGE_MAX_LENGTH } from "@kuboon/idobata-bot";
import type {
  Agent,
  AgentEvent,
  AgentInput,
  ChatMessage,
  ToolResult,
} from "@remix-kbn/helper-agent/controller";

import { sql } from "@remix-run/data-table";
import { getDb } from "../../db/mod.ts";
import { type DocumentDetail, getDocument, isOpen } from "../documents.ts";
import { filterMessage } from "./filter.ts";
import type { ChatModel, ModelMessage, ModelToolCall } from "./model.ts";
import { systemMessage, TOOLS } from "./prompt.ts";
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

type AssistantMessage = Extract<ModelMessage, { role: "assistant" }>;

/** The model's message as `state` keeps it. */
function toState(content: string, calls: ModelToolCall[]): string {
  return JSON.stringify(assistantMessage(content, calls));
}

function assistantMessage(
  content: string,
  calls: ModelToolCall[],
): AssistantMessage {
  return calls.length === 0 ? { role: "assistant", content } : {
    role: "assistant",
    content,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.arguments },
    })),
  };
}

/**
 * An assistant message for the model, from its `state` when that reads back as one this server
 * wrote, and otherwise rebuilt from its text and calls. Either way, only text and tool calls get
 * through.
 */
function assistantFrom(
  message: Extract<ChatMessage, { role: "assistant" }>,
): AssistantMessage {
  if (message.state !== undefined) {
    try {
      const parsed = JSON.parse(message.state);
      if (isRecord(parsed) && typeof parsed.content === "string") {
        const raw = parsed.tool_calls ?? [];
        if (!Array.isArray(raw)) return fail("invalid state");
        const calls = raw.map((c): ModelToolCall => {
          const fn = isRecord(c) && isRecord(c.function) ? c.function : null;
          if (
            !fn || typeof c.id !== "string" || typeof fn.name !== "string" ||
            typeof fn.arguments !== "string"
          ) return fail("invalid state");
          return { id: c.id, name: fn.name, arguments: fn.arguments };
        });
        return assistantMessage(parsed.content, calls);
      }
    } catch (error) {
      if (error instanceof ChatError) throw error;
      // Not JSON: rebuild it below.
    }
  }
  return assistantMessage(
    message.content,
    (message.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.input ?? {}),
    })),
  );
}

/** The longest tool result the browser may send back: a sentence about the dialog. */
const TOOL_RESULT_MAX_LENGTH = 2000;

/** A tool's result as the model reads it; a failure says so. */
const resultContent = (r: { content: string; isError?: boolean }) =>
  r.isError ? `エラー: ${r.content}` : r.content;

/**
 * The transcript as the model's messages, after the system message.
 *
 * @throws {ChatError} 400 when it is not a conversation this server could have had
 */
export function toModelMessages(
  messages: readonly ChatMessage[],
): ModelMessage[] {
  const out: ModelMessage[] = [];
  const called = new Set<string>();

  for (const message of messages) {
    if (!isRecord(message)) return fail("invalid message");
    if (message.role === "user") {
      if (typeof message.content !== "string") return fail("invalid message");
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const assistant = assistantFrom(message);
      for (const c of assistant.tool_calls ?? []) called.add(c.id);
      out.push(assistant);
    } else if (message.role === "tool" && Array.isArray(message.results)) {
      for (const r of message.results) {
        if (
          !isRecord(r) || typeof r.id !== "string" || !called.has(r.id) ||
          typeof r.content !== "string" ||
          r.content.length > TOOL_RESULT_MAX_LENGTH
        ) return fail("invalid tool result");
        out.push({
          role: "tool",
          tool_call_id: r.id,
          content: resultContent({
            content: r.content,
            isError: r.isError === true,
          }),
        });
      }
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
 * @param model The model on Workers AI, or a scripted stand-in
 */
export function chatAgent(document: DocumentDetail, model: ChatModel): Agent {
  const context = { documentId: document.id, segments: document.segments };

  return {
    async *respond(input: AgentInput): AsyncGenerator<AgentEvent> {
      let history: ModelMessage[];
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

      const prefix: ModelMessage[] = [
        systemMessage(document.title, document.segments),
        ...history,
      ];
      const added: ModelMessage[] = [];

      for (let round = 0; round < TOOL_ROUNDS_MAX; round++) {
        // A new round is a new assistant message. The session closes the previous one's tool
        // results only on `text`, so a round that opens with a tool call and no words would be
        // filed before them (`@kuboon/chat-element` 0.1.0); an empty delta closes them.
        if (round > 0) yield { type: "text", text: "" };
        const texts = channel<string>();
        const running = model.run(
          { messages: [...prefix, ...added], tools: TOOLS },
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

        yield {
          type: "state",
          state: toState(message.content, message.toolCalls),
        };
        if (message.finishReason === "length") {
          yield { type: "done", reason: "max-tokens" };
          return;
        }
        added.push(assistantMessage(message.content, message.toolCalls));
        const calls = message.toolCalls;
        if (calls.length === 0) {
          yield { type: "done", reason: "end" };
          return;
        }

        // The server's tools run here. The page's go to the browser: the selection, and a valid
        // draft, for which it opens the posting dialog and answers once the reader has left it.
        const results: ToolResult[] = [];
        let forBrowser = false;
        for (const call of calls) {
          let input: unknown;
          try {
            input = JSON.parse(call.arguments);
          } catch {
            input = null;
          }
          if (!isRecord(input)) {
            yield {
              type: "tool-call",
              call: { id: call.id, name: call.name, input: {} },
            };
            results.push({
              id: call.id,
              content: "引数が JSON のオブジェクトではありません。",
              isError: true,
            });
            continue;
          }
          if (PAGE_TOOLS.has(call.name)) {
            yield {
              type: "tool-call",
              call: { id: call.id, name: call.name, input },
            };
            forBrowser = true;
            continue;
          }
          if (call.name === DRAFT_TOOL) {
            const resolved = await resolveDraft(
              input as unknown as DraftInput,
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
              call: { id: call.id, name: call.name, input },
            };
            results.push({ id: call.id, ...resolved.error });
            continue;
          }
          yield {
            type: "tool-call",
            call: { id: call.id, name: call.name, input },
          };
          results.push({
            id: call.id,
            ...(await runTool(call.name, input, context)),
          });
        }
        for (const result of results) yield { type: "tool-result", result };
        if (forBrowser) {
          yield { type: "done", reason: "tools" };
          return;
        }
        for (const r of results) {
          added.push({
            role: "tool",
            tool_call_id: r.id,
            content: resultContent(r),
          });
        }
      }
      yield { type: "error", message: "AI の応答が長くなりすぎました。" };
    },
  };
}
