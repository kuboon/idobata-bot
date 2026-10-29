/**
 * One turn of the AI chat about a document (docs/design.md §6): check what the browser sent, put
 * the message through the pre-filter, then run the model — and its tools — until it answers.
 *
 * Nothing is stored. The browser sends the whole history every turn and appends what the turn
 * added, which the `done` event carries.
 */

import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
} from "@kuboon/idobata-bot";
import type {
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
import { runTool } from "./tools.ts";

/** How many messages a conversation may hold: about 30 exchanges with their tool turns. */
export const HISTORY_MAX_MESSAGES = 120;
/** The history's size in characters of JSON — a guard on cost, well under the context window. */
export const HISTORY_MAX_CHARS = 300_000;
/** Model calls in one turn: a search, a look at one opinion, a draft, and the answer. */
export const TOOL_ROUNDS_MAX = 5;

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

/** A checked history, and the reader's new message (the last one) as plain text. */
export interface ParsedChatRequest {
  versionNumber: number;
  segmentKeys: string[];
  history: BetaMessageParam[];
  message: string;
}

/**
 * Checks a `POST /api/docs/:docId/chat` body.
 *
 * @throws {ChatError} With status 400 when it is not a well-formed conversation ending in a new
 *   message from the reader
 */
export function parseChatRequest(body: unknown): ParsedChatRequest {
  if (!isRecord(body)) return fail("invalid body");
  const { versionNumber, segmentKeys, messages } = body as Partial<
    Record<keyof ChatRequest, unknown>
  >;
  if (typeof versionNumber !== "number" || !Number.isInteger(versionNumber)) {
    return fail("invalid versionNumber");
  }
  if (
    !Array.isArray(segmentKeys) || segmentKeys.length > 200 ||
    !segmentKeys.every((k) => typeof k === "string")
  ) return fail("invalid segmentKeys");
  if (!Array.isArray(messages) || messages.length === 0) {
    return fail("invalid messages");
  }
  if (messages.length > HISTORY_MAX_MESSAGES) {
    throw new ChatError(
      413,
      "この会話は長くなりすぎました。新しく始めてください。",
    );
  }
  if (JSON.stringify(messages).length > HISTORY_MAX_CHARS) {
    throw new ChatError(
      413,
      "この会話は長くなりすぎました。新しく始めてください。",
    );
  }

  const history = messages.map((m): BetaMessageParam => {
    if (!isRecord(m) || (m.role !== "user" && m.role !== "assistant")) {
      return fail("invalid message");
    }
    const content = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
      ? m.content.map(block)
      : fail("invalid message");
    return { role: m.role, content };
  });

  const last = history.at(-1)!;
  const text = last.role !== "user"
    ? fail("the last message must be the reader's")
    : typeof last.content === "string"
    ? last.content
    : last.content.every((b) => b.type === "text")
    ? last.content.map((b) => (b as { text: string }).text).join("")
    : fail("the last message must be text");
  if (!text.trim()) return fail("empty message");
  if (text.length > CHAT_MESSAGE_MAX_LENGTH) return fail("message too long");

  return {
    versionNumber,
    segmentKeys: segmentKeys as string[],
    history,
    message: text,
  };
}

/** The text a message shows, for the pre-filter's view of the conversation. */
function plainText(message: BetaMessageParam): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");
}

/** Counts a refused message: the day and the kind, never its text (docs/design.md §6). */
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
 * Runs one turn, reporting it as {@link ChatEvent}s — every turn ends with exactly one `done`,
 * `rejected` or `error`.
 */
export async function runChatTurn(
  document: DocumentDetail,
  request: ParsedChatRequest,
  model: ChatModel,
  emit: (event: ChatEvent) => void,
): Promise<void> {
  const selected = document.segments.filter((s) =>
    request.segmentKeys.includes(s.key)
  );
  const verdict = await filterMessage({
    title: document.title,
    headings: document.segments
      .filter((s) => s.kind === "heading")
      .map((s) => s.text),
    selected: selected.map((s) => s.text),
    recentTurns: request.history.slice(-5, -1).map(plainText).filter(Boolean),
    message: request.message,
  });
  if (!verdict.ok) {
    await countRejection(document.id, verdict.kind);
    emit({ type: "rejected", message: REJECTED_MESSAGE });
    return;
  }

  const prefix = [
    firstMessage(document.title, document.segments, request.segmentKeys),
    ...request.history,
  ];
  const added: BetaMessageParam[] = [];

  try {
    for (let round = 0; round < TOOL_ROUNDS_MAX; round++) {
      const message = await model.run(
        {
          system: systemBlocks(),
          messages: [...prefix, ...added],
          tools: TOOLS,
        },
        (text) => emit({ type: "text", text }),
      );
      if (message.stop_reason === "refusal") {
        emit({ type: "error", message: "この内容にはお答えできません。" });
        return;
      }
      added.push({
        role: "assistant",
        content: message.content as BetaContentBlockParam[],
      });
      if (message.stop_reason !== "tool_use") break;

      const results: BetaToolResultBlockParam[] = [];
      for (const b of message.content) {
        if (b.type !== "tool_use") continue;
        const result = await runTool(b.name, b.input, {
          documentId: document.id,
          segments: document.segments,
          onDraft: (draft) => emit({ type: "draft", draft }),
        });
        results.push({
          type: "tool_result",
          tool_use_id: b.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      added.push({ role: "user", content: results });
    }
  } catch (error) {
    console.error("chat model failed", error);
    emit({
      type: "error",
      message:
        "AI の応答に失敗しました。しばらくしてからもう一度お試しください。",
    });
    return;
  }
  emit({ type: "done", messages: added as ChatMessage[] });
}
