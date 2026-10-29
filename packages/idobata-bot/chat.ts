/**
 * The AI chat about a document, from the reader's side (docs/design.md §6).
 *
 * The conversation lives only here, in the browser: each turn sends the whole history and gets
 * back what the turn added, which is appended as is — the server keeps nothing. The history is
 * the Claude API's `messages` after the first one (the document, which the server adds), so its
 * blocks are opaque to this module apart from the text it shows.
 */

import type { AuthedFetch } from "./client.ts";
import type { OpinionInput } from "./types.ts";

/** One message of the history, in the Claude API's shape. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ChatBlock[];
}

/** A content block. Only `text` blocks are read here; the rest are kept for the server. */
export type ChatBlock = { type: string; [key: string]: unknown };

/** What the AI put in front of the reader: an opinion to post, or an opinion to support. */
export type ChatDraft =
  | { type: "opinion"; input: OpinionInput }
  | { type: "support"; opinionId: string };

/** `POST /api/docs/:docId/chat`. */
export interface ChatRequest {
  /** The version the conversation is about — fixed when it starts. */
  versionNumber: number;
  /** The segments selected when it started — fixed too, so the server's first message is. */
  segmentKeys: string[];
  /** The history with the reader's new message last. */
  messages: ChatMessage[];
}

/** The server-sent events of one turn, in order: text and drafts as they come, then one end. */
export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "draft"; draft: ChatDraft }
  /** The turn is over; `messages` is what it added to the history. */
  | { type: "done"; messages: ChatMessage[] }
  /** The pre-filter refused the message: nothing is added to the history. */
  | { type: "rejected"; message: string }
  | { type: "error"; message: string };

/** The longest message a reader can send. */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/** The text of a message, as the chat shows it. */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/** Whether a message is something a person reads — not a turn of tool results. */
export function isShown(message: ChatMessage): boolean {
  return messageText(message).trim() !== "";
}

/**
 * Reads a server-sent event stream into {@link ChatEvent}s.
 *
 * @param body The response body of `POST /api/docs/:docId/chat`
 */
export async function* readChatEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield JSON.parse(data) as ChatEvent;
    }
  }
}

export interface ChatTurnOptions {
  baseUrl?: string;
  fetch: AuthedFetch;
  documentId: string;
  request: ChatRequest;
  signal?: AbortSignal;
}

/**
 * Sends one turn and yields its events.
 *
 * @throws When the service refuses the request outright (a `4xx`/`5xx` before the stream starts)
 */
export async function* sendChatTurn(
  options: ChatTurnOptions,
): AsyncGenerator<ChatEvent> {
  const response = await options.fetch(
    `${options.baseUrl ?? ""}/api/docs/${
      encodeURIComponent(options.documentId)
    }/chat`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options.request),
      signal: options.signal,
    },
  );
  if (!response.ok || !response.body) {
    let message = response.statusText;
    try {
      message = ((await response.json()) as { error?: string }).error ??
        message;
    } catch {
      // Not JSON: the status text will do.
    }
    yield { type: "error", message };
    return;
  }
  yield* readChatEvents(response.body);
}
