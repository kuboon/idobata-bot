/**
 * One document's opinions in the browser, shared by everything on the page that shows them: the
 * per-segment counts in the viewer and the opinion panel. A `change` event tells them to re-read.
 *
 * Talks to the opinion service only through `@kuboon/idobata-bot`'s client, signed by the page's
 * session (`sessionStore.apiFetch`) — the same split the module will have when it leaves this site
 * (docs/design.md §2).
 */

import {
  createOpinionClient,
  type Opinion,
  type OpinionClient,
  type OpinionInput,
} from "@kuboon/idobata-bot";
import { TypedEventTarget } from "@remix-run/component";

import { sessionStore } from "../session.ts";

/** The client this site uses: its own origin, signed by its session. */
export const opinionClient: OpinionClient = createOpinionClient({
  fetch: (url, init) => sessionStore.apiFetch(url, init),
});

type StoreEvents = { change: Event };

export class OpinionStore extends TypedEventTarget<StoreEvents> {
  opinions: Opinion[] = [];
  hiddenCount = 0;
  loaded = false;
  error = "";

  constructor(readonly documentId: string) {
    super();
  }

  /** Reads the document's opinions again — after signing in, too, for `mine` / `supportedByMe`. */
  async load(): Promise<void> {
    try {
      const list = await opinionClient.list(this.documentId);
      this.opinions = list.opinions;
      this.hiddenCount = list.hiddenCount;
      this.error = "";
    } catch (e) {
      this.error = `意見を読み込めませんでした: ${(e as Error).message}`;
    }
    this.loaded = true;
    this.#changed();
  }

  async post(input: OpinionInput): Promise<Opinion> {
    const opinion = await opinionClient.post(this.documentId, input);
    await this.load();
    return opinion;
  }

  async setSupport(opinionId: string, on: boolean): Promise<void> {
    const updated = on
      ? await opinionClient.support(opinionId)
      : await opinionClient.unsupport(opinionId);
    this.opinions = this.opinions.map((o) => o.id === updated.id ? updated : o);
    this.#changed();
  }

  async remove(opinionId: string): Promise<void> {
    await opinionClient.remove(opinionId);
    await this.load();
  }

  /** Opinions with a target on this segment. */
  aboutSegment(segmentKey: string): Opinion[] {
    return this.opinions.filter((o) =>
      o.targets.some((t) => t.kind === "segment" && t.segmentKey === segmentKey)
    );
  }

  byId(opinionId: string): Opinion | undefined {
    return this.opinions.find((o) => o.id === opinionId);
  }

  #changed(): void {
    this.dispatchEvent(new Event("change"));
  }
}
