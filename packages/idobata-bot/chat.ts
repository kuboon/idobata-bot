/**
 * The AI chat about a document, from the reader's side (docs/architecture.md §5).
 *
 * The wire format is `@remix-kbn/helper-agent`'s: the browser holds the transcript, posts all of
 * it every turn, and reads the turn back as server-sent events. What is this service's own is
 * where to post it and the tools the browser runs: `draft_opinion`, whose input is a
 * {@link ChatDraft}, and the two that read and set the reader's selection.
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

/** The tools the page runs besides {@link DRAFT_TOOL_NAME}: reading and setting the selection. */
export const SELECTION_TOOL_NAMES = {
  /** No input. Answers with the selected blocks. */
  get: "get_selection",
  /** `{ segment_indices: number[] }` — blocks of the version, from 0. */
  set: "select_segments",
} as const;

/**
 * Where a conversation posts its turns. The version is part of the URL: it makes the
 * conversation's first message, which must not change.
 *
 * @param documentId The document
 * @param versionNumber The version the reader is looking at
 * @param baseUrl The service's origin; this page's when omitted
 */
export function chatUrl(
  documentId: string,
  versionNumber: number,
  baseUrl = "",
): string {
  return `${baseUrl}/api/docs/${
    encodeURIComponent(documentId)
  }/chat?v=${versionNumber}`;
}
