/**
 * What the posting dialog (`post_dialog.tsx`) is showing, shared by everything that opens it: the
 * opinion panel's buttons, and the AI's `draft_opinion` tool (`assistant.ts`), which waits for
 * the reader to post or close it and tells the AI which.
 */

import type { Opinion, OpinionInput, Target } from "@kuboon/idobata-bot";
import { TypedEventTarget } from "@remix-run/component";

/** An opinion to write — empty or a draft — or an existing opinion to support. */
export type ComposeRequest =
  | {
    kind: "opinion";
    draft: Partial<Omit<OpinionInput, "targets">> & { targets: Target[] };
    /** Whether the AI wrote it, so the dialog can say so. */
    fromAssistant?: boolean;
  }
  | { kind: "support"; opinionId: string };

/** How the dialog was left: posted, supported, or closed without either. */
export type ComposeOutcome =
  | { kind: "posted"; opinion: Opinion }
  | { kind: "supported"; opinionId: string }
  | { kind: "closed" };

type ComposeEvents = { change: Event };

export class ComposeStore extends TypedEventTarget<ComposeEvents> {
  current: ComposeRequest | null = null;
  /** Bumped per request, so the dialog's fields are new elements with the new values. */
  generation = 0;
  #resolve: ((outcome: ComposeOutcome) => void) | null = null;

  /**
   * Opens the dialog. One that is already open is closed first, as if the reader had.
   *
   * @returns How the reader left it
   */
  open(request: ComposeRequest): Promise<ComposeOutcome> {
    this.#resolve?.({ kind: "closed" });
    this.current = request;
    this.generation++;
    const outcome = new Promise<ComposeOutcome>((resolve) => {
      this.#resolve = resolve;
    });
    this.#changed();
    return outcome;
  }

  /** Closes the dialog, reporting how. */
  finish(outcome: ComposeOutcome): void {
    if (!this.current) return;
    const resolve = this.#resolve;
    this.current = null;
    this.#resolve = null;
    resolve?.(outcome);
    this.#changed();
  }

  #changed(): void {
    this.dispatchEvent(new Event("change"));
  }
}
