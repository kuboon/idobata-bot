/**
 * The AI chat about a document, from the reader's side (docs/design.md §6).
 *
 * The wire format is `@remix-kbn/helper-agent`'s: the browser holds the transcript, posts all of
 * it every turn, and reads the turn back as server-sent events. What is this service's own is
 * where to post it and the one tool the browser runs, `draft_opinion`, whose input is a
 * {@link ChatDraft}.
 */

import type { OpinionInput } from "./types.ts";

/**
 * What the AI put in front of the reader — the input of the browser's `draft_opinion` tool: an
 * opinion to post (targets by segment key), or an opinion to support.
 */
export type ChatDraft =
  | { type: "opinion"; input: OpinionInput }
  | { type: "support"; opinionId: string };

/** The tool the browser runs: it opens the posting dialog with a {@link ChatDraft}. */
export const DRAFT_TOOL_NAME = "draft_opinion";

/** The longest message a reader can send. */
export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/**
 * Where a conversation posts its turns. The version and the paragraphs selected when it started
 * are part of the URL: they make the conversation's first message, which must not change.
 *
 * @param documentId The document
 * @param versionNumber The version the reader is looking at
 * @param segmentKeys The selected segments, by key
 * @param baseUrl The service's origin; this page's when omitted
 */
export function chatUrl(
  documentId: string,
  versionNumber: number,
  segmentKeys: readonly string[],
  baseUrl = "",
): string {
  const query = new URLSearchParams({ v: String(versionNumber) });
  if (segmentKeys.length > 0) query.set("s", segmentKeys.join(","));
  return `${baseUrl}/api/docs/${encodeURIComponent(documentId)}/chat?${query}`;
}
