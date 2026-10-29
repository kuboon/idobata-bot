/**
 * The AI chat about one document, in the browser (docs/design.md §6). The conversation is kept
 * only here, in `sessionStorage` — closing the tab ends it — and every turn sends all of it.
 *
 * The version and the selection are fixed when the conversation starts: the server builds the
 * model's first message from them, and it has to come out the same every turn.
 */

import {
  type ChatDraft,
  type ChatMessage,
  isShown,
  messageText,
  sendChatTurn,
} from "@kuboon/idobata-bot";
import { TypedEventTarget } from "@remix-run/component";

import { sessionStore } from "../session.ts";

/** What the chat shows: a line of the conversation, or a draft the AI put forward. */
export type ChatEntry =
  | { kind: "message"; role: "user" | "assistant"; text: string }
  | { kind: "draft"; draft: ChatDraft };

interface Saved {
  versionNumber: number;
  segmentKeys: string[];
  messages: ChatMessage[];
  /** Drafts, with the number of messages before each — where it goes in the conversation. */
  drafts: { at: number; draft: ChatDraft }[];
}

type ChatEvents = { change: Event; draft: CustomEvent<ChatDraft> };

export class ChatStore extends TypedEventTarget<ChatEvents> {
  #saved: Saved | null = null;
  /** The answer streaming in, before the turn ends. */
  streaming = "";
  busy = false;
  error = "";

  constructor(readonly documentId: string, readonly versionNumber: number) {
    super();
    try {
      const raw = sessionStorage.getItem(this.#key);
      const saved = raw ? (JSON.parse(raw) as Saved) : null;
      // A conversation about an older version stays with that version.
      if (saved?.versionNumber === versionNumber) this.#saved = saved;
    } catch {
      // No storage, or something unreadable in it: start afresh.
    }
  }

  get #key() {
    return `idobata-chat:${this.documentId}`;
  }

  #save() {
    try {
      if (this.#saved) {
        sessionStorage.setItem(this.#key, JSON.stringify(this.#saved));
      } else sessionStorage.removeItem(this.#key);
    } catch {
      // Storage is a convenience: the conversation still works for this page.
    }
  }

  #changed() {
    this.dispatchEvent(new Event("change"));
  }

  /** Whether a conversation has begun. */
  get started(): boolean {
    return this.#saved !== null;
  }

  /** The segments the conversation began with. */
  get segmentKeys(): readonly string[] {
    return this.#saved?.segmentKeys ?? [];
  }

  /** The conversation as it reads, drafts in place. */
  get entries(): ChatEntry[] {
    if (!this.#saved) return [];
    const entries: ChatEntry[] = [];
    const { messages, drafts } = this.#saved;
    messages.forEach((m, i) => {
      for (const d of drafts) {
        if (d.at === i) entries.push({ kind: "draft", draft: d.draft });
      }
      if (isShown(m)) {
        entries.push({ kind: "message", role: m.role, text: messageText(m) });
      }
    });
    for (const d of drafts) {
      if (d.at >= messages.length) {
        entries.push({ kind: "draft", draft: d.draft });
      }
    }
    return entries;
  }

  /**
   * Sends the reader's message.
   *
   * @param selectedKeys The selection now — used only when this starts the conversation
   */
  async send(text: string, selectedKeys: string[]): Promise<void> {
    if (this.busy || !text.trim()) return;
    const saved: Saved = this.#saved ?? {
      versionNumber: this.versionNumber,
      segmentKeys: selectedKeys,
      messages: [],
      drafts: [],
    };
    const messages = [
      ...saved.messages,
      { role: "user", content: text } as ChatMessage,
    ];
    this.busy = true;
    this.error = "";
    this.streaming = "";
    // Show the message straight away; it is kept only if the turn succeeds.
    this.#saved = { ...saved, messages };
    this.#changed();

    const drafts: ChatDraft[] = [];
    let ended = false;
    try {
      for await (
        const event of sendChatTurn({
          fetch: (url, init) => sessionStore.apiFetch(url, init),
          documentId: this.documentId,
          request: {
            versionNumber: saved.versionNumber,
            segmentKeys: saved.segmentKeys,
            messages,
          },
        })
      ) {
        switch (event.type) {
          case "text":
            this.streaming += event.text;
            this.#changed();
            break;
          case "draft":
            drafts.push(event.draft);
            this.dispatchEvent(
              new CustomEvent("draft", { detail: event.draft }),
            );
            break;
          case "done":
            ended = true;
            this.#saved = {
              ...saved,
              messages: [...messages, ...event.messages],
              drafts: [
                ...saved.drafts,
                ...drafts.map((draft) => ({
                  at: messages.length + event.messages.length,
                  draft,
                })),
              ],
            };
            break;
          case "rejected":
          case "error":
            ended = true;
            this.error = event.message;
            break;
        }
      }
      if (!ended) this.error = "応答が途中で切れました。";
    } catch (e) {
      this.error = `送信できませんでした: ${(e as Error).message}`;
    }
    // A turn that did not finish leaves the history as it was, so the message can be sent again.
    if (this.error) {
      this.#saved = saved.messages.length ? saved : null;
    }
    this.busy = false;
    this.streaming = "";
    this.#save();
    this.#changed();
  }

  /** Ends the conversation; the next message starts a new one with the selection then. */
  reset(): void {
    this.#saved = null;
    this.error = "";
    this.#save();
    this.#changed();
  }
}
