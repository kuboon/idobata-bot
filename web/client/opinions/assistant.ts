/**
 * The AI chat about a document, in the corner of the page (docs/design.md §6): a
 * `@remix-kbn/helper-agent` panel in a non-modal `<dialog>`, so the reader can keep reading and
 * selecting while they talk.
 *
 * One conversation per page, about the version. The selection is the reader's and changes
 * while they talk, so the AI reads it (`get_selection`) and sets it (`select_segments` — "that is
 * this part, isn't it?") with tools that run here. The transcript is held only by the panel's
 * session: closing the tab ends it.
 *
 * `draft_opinion` runs here too: it opens the posting dialog with the AI's draft (or its
 * suggestion to support an existing opinion), waits for the reader, and tells the AI how it went.
 */

import {
  type ChatDraft,
  chatUrl,
  DRAFT_TOOL_NAME,
  SELECTION_TOOL_NAMES,
} from "@kuboon/idobata-bot";
import {
  type ClientTool,
  type HelperAgentPanel,
  openHelperAgent,
} from "@remix-kbn/helper-agent/client";

import { sessionStore } from "../session.ts";
import { color, radius } from "../tokens.ts";
import type { ComposeOutcome, ComposeStore } from "./compose.ts";

/** A block of the version as the AI sees it: its number, from 0, and its text. */
export interface Block {
  index: number;
  text: string;
}

/** The reader's selection, which the AI reads and sets by block number. */
export interface PageSelection {
  /** The selected blocks, in document order. */
  current(): Block[];
  /**
   * Selects these blocks instead, and scrolls to them.
   *
   * @returns Each block with how many opinions the page now shows for it
   * @throws When a number is not a block of the version
   */
  select(indices: readonly number[]): (Block & { opinions: number })[];
}

export interface AssistantOptions {
  documentId: string;
  versionNumber: number;
  compose: ComposeStore;
  selection: PageSelection;
}

/** A block's start, enough for the AI to tell which it is. */
const excerpt = (text: string) =>
  text.length > 60 ? `${text.slice(0, 60)}…` : text;

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

/** `get_selection` and `select_segments`: the AI pointing at the document, on the reader's screen. */
function selectionTools(selection: PageSelection): ClientTool[] {
  return [
    {
      name: SELECTION_TOOL_NAMES.get,
      description: "読者が選んでいる段落",
      inputSchema: { type: "object" },
      run() {
        const blocks = selection.current();
        return blocks.length === 0
          ? "読者は段落を選んでいません。"
          : JSON.stringify({
            selected: blocks.map((b) => ({
              segment_index: b.index,
              text: excerpt(b.text),
            })),
          });
      },
    },
    {
      name: SELECTION_TOOL_NAMES.set,
      description: "読者の画面で段落を選ぶ",
      inputSchema: { type: "object" },
      run(input) {
        const indices = (input as { segment_indices?: unknown })
          ?.segment_indices;
        if (
          !Array.isArray(indices) || indices.length === 0 ||
          !indices.every(Number.isInteger)
        ) throw new Error("segment_indices に段落の番号を 1 つ以上ください。");
        const blocks = selection.select(indices);
        return JSON.stringify({
          message:
            "読者の画面でこの段落を選び、スクロールしました。段落の下に、その段落への意見が表示されています。",
          selected: blocks.map((b) => ({
            segment_index: b.index,
            text: excerpt(b.text),
            opinions_shown: b.opinions,
          })),
        });
      },
    },
  ];
}

/**
 * Opens the chat in the corner. There is one per page: it is about the version, and follows the
 * selection through its tools rather than being tied to one.
 */
export function openAssistant(options: AssistantOptions): HelperAgentPanel {
  const { documentId, versionNumber, compose, selection } = options;
  const chat = openHelperAgent({
    title: "AI と対話",
    greeting:
      "この文書について、気になること・ご意見をお聞かせください。段落を選んでから話しかけると、その段落について、すでに出ている意見も踏まえてお手伝いします。",
    placeholder: "メッセージ",
    transport: {
      url: chatUrl(documentId, versionNumber),
      // Signed with the page's DPoP key, like every API call.
      fetch: async (request) =>
        sessionStore.apiFetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
          signal: request.signal,
        }),
    },
    tools: [draftTool(compose), ...selectionTools(selection)],
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
