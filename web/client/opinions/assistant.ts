/**
 * The AI chat about a document, in the corner of the page (docs/design.md §6): a
 * `@remix-kbn/helper-agent` panel in a non-modal `<dialog>`, so the reader can keep reading and
 * selecting while they talk.
 *
 * The conversation is about what was selected when it started — the server builds the model's
 * first message from it, and that has to stay the same — so a different selection is a new
 * conversation. The transcript is held only by the panel's session: closing the tab ends it.
 *
 * The one tool this page runs is `draft_opinion`: it opens the posting dialog with the AI's draft
 * (or its suggestion to support an existing opinion), waits for the reader, and tells the AI how
 * it went.
 */

import { type ChatDraft, chatUrl, DRAFT_TOOL_NAME } from "@kuboon/idobata-bot";
import {
  type ClientTool,
  type HelperAgentPanel,
  openHelperAgent,
} from "@remix-kbn/helper-agent/client";

import { sessionStore } from "../session.ts";
import { color, radius } from "../tokens.ts";
import type { ComposeOutcome, ComposeStore } from "./compose.ts";

export interface AssistantOptions {
  documentId: string;
  versionNumber: number;
  /** The selected segments, by key, in document order. */
  segmentKeys: readonly string[];
  compose: ComposeStore;
}

/** What the AI reads back once the reader has left the dialog. */
function outcomeText(outcome: ComposeOutcome): string {
  switch (outcome.kind) {
    case "posted":
      return `読者が投稿しました（意見 ID: ${outcome.opinion.id}、要旨: ${outcome.opinion.title}）。`;
    case "supported":
      return "読者はその意見に賛同しました。";
    case "closed":
      return sessionStore.userId === null
        ? "読者はサインインしていないため投稿できず、ダイアログを閉じました。"
        : "読者は投稿せずにダイアログを閉じました。";
  }
}

/** `draft_opinion`, run here: the server has already turned block numbers into segment keys. */
function draftTool(compose: ComposeStore): ClientTool {
  return {
    name: DRAFT_TOOL_NAME,
    // The server gives the model its own description and schema; these only name the tool.
    description: "下書き入りの投稿ダイアログを開く",
    inputSchema: { type: "object" },
    async run(input) {
      const draft = input as ChatDraft;
      const outcome = draft.type === "support"
        ? await compose.open({ kind: "support", opinionId: draft.opinionId })
        : await compose.open({
          kind: "opinion",
          draft: draft.input,
          fromAssistant: true,
        });
      return outcomeText(outcome);
    },
  };
}

/** Opens the chat in the corner. Call `dispose()` on the handle to end the conversation. */
export function openAssistant(options: AssistantOptions): HelperAgentPanel {
  const { documentId, versionNumber, segmentKeys, compose } = options;
  const chat = openHelperAgent({
    title: "AI と対話",
    greeting: segmentKeys.length === 0
      ? "この文書について、気になること・ご意見をお聞かせください。"
      : "選んだ段落について、気になること・ご意見をお聞かせください。この段落にすでに出ている意見も踏まえてお手伝いします。",
    placeholder: "メッセージ",
    transport: {
      url: chatUrl(documentId, versionNumber, segmentKeys),
      // Signed with the page's DPoP key, like every API call.
      fetch: async (request) =>
        sessionStore.apiFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
          signal: request.signal,
        }),
    },
    tools: [draftTool(compose)],
  });
  const style = chat.dialog.style;
  style.setProperty("--chat-panel-bg", color.bg);
  style.setProperty("--chat-panel-fg", color.fg);
  style.setProperty("--chat-panel-muted", color.muted);
  style.setProperty("--chat-panel-border", color.border);
  style.setProperty("--chat-panel-accent", color.accent);
  style.setProperty("--chat-panel-on-accent", color.onAccent);
  style.setProperty("--chat-panel-radius", radius.md);
  style.zIndex = "10";
  return chat;
}
