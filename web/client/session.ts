/**
 * Shared DPoP session store for the browser.
 *
 * The navbar (NavAuth) and the /my cards (SignOut, PushCard, …) all need the
 * same session: this browser's DPoP key plus a `/session` probe against the
 * IdP. The islands are code-split out of one graph (`server/assets.ts`), so
 * this module is emitted once into a chunk they share and there is exactly one
 * instance. The DPoP init + `/session` probe run once
 * ({@link DpopSessionStore.load} is idempotent), and a typed `change` event
 * keeps every subscriber in sync — signing out in one card immediately updates
 * the navbar.
 *
 * Subscribe with `sessionStore.addEventListener("change", cb, { signal })`
 * using a clientEntry's `handle.signal` so the listener is removed on unmount.
 *
 * Signing in goes to the IdP and comes back. {@link signIn} does it in this tab and comes back to
 * the same URL. {@link signInInNewTab} does it in another tab, for a page with something that only
 * lives in memory (a chat, a draft in the posting dialog): the other tab lands on
 * `/?signin=done`, tells this one over a `BroadcastChannel`, and closes itself; this tab then
 * probes the session again.
 */

import { init } from "@kuboon/dpop";
import { TypedEventTarget } from "@remix-run/component";

import { IDP_ORIGIN } from "./idp.ts";

export type FetchDpop = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

type SessionEventMap = { change: Event };

/** Tabs of this origin telling each other that the session changed. */
const CHANNEL = "idobata-session";
/** The query a sign-in in another tab returns with. */
const SIGNED_IN_PARAM = "signin";

class DpopSessionStore extends TypedEventTarget<SessionEventMap> {
  /** DPoP-bound fetch, available once {@link load} resolves (null if init failed). */
  fetchDpop: FetchDpop | null = null;
  /** This browser's DPoP key thumbprint — needed to start the sign-in flow. */
  thumbprint = "";
  /** IdP user id, or `null` when signed out / not yet loaded. */
  userId: string | null = null;
  /**
   * The IdP's token for this key (`jws` from `/session`), sent to this app's API as
   * `Authorization: DPoP <token>`. Good for an hour; {@link apiFetch} fetches a fresh one when the
   * API turns it down.
   */
  token: string | null = null;
  /** True once the initial probe has resolved (success or failure). */
  ready = false;

  #loading?: Promise<void>;

  /**
   * Generate/reuse the DPoP key and probe the IdP `/session` — once. Concurrent
   * and later callers share the single in-flight/resolved probe, so N
   * components trigger one `/session` request. Always resolves (even if DPoP
   * init fails) so subscribers leave the loading state.
   */
  load(): Promise<void> {
    return (this.#loading ??= (async () => {
      try {
        const { fetchDpop, thumbprint } = await init();
        this.fetchDpop = fetchDpop;
        this.thumbprint = thumbprint;
        await this.#probe();
      } catch {
        // DPoP init failed (e.g. no IndexedDB) — stay signed-out but ready.
      } finally {
        this.ready = true;
        this.#emitChange();
      }
      this.#listenToOtherTabs();
      this.#finishSignInTab();
    })());
  }

  /** The IdP's sign-in page, coming back to `returnTo` (any URL of this origin). */
  signInUrl(returnTo: string): string {
    const params = new URLSearchParams({
      dpop_jkt: this.thumbprint,
      redirect_uri: returnTo,
    });
    return `${IDP_ORIGIN}/authorize?${params.toString()}`;
  }

  /** Signs in in this tab, coming back to the page it started from. */
  signIn(): void {
    globalThis.location.href = this.signInUrl(globalThis.location.href);
  }

  /**
   * Signs in in another tab, so this page — and what it holds in memory — stays as it is. Call it
   * from a click (a popup blocker lets a click open a tab). Falls back to this tab if the browser
   * will not open one.
   */
  signInInNewTab(): void {
    const returnTo = new URL(`/?${SIGNED_IN_PARAM}=done`, location.origin).href;
    const tab = globalThis.open(this.signInUrl(returnTo), "_blank");
    if (!tab) this.signIn();
  }

  /** Probes the session again and tells the subscribers if who is signed in changed. */
  async refresh(): Promise<void> {
    if (!this.fetchDpop) return;
    const before = this.userId;
    await this.#probe();
    if (this.userId !== before) this.#emitChange();
  }

  /** A sign-in finished in another tab, or this tab came back into view: look again. */
  #listenToOtherTabs(): void {
    try {
      new BroadcastChannel(CHANNEL).onmessage = () => void this.refresh();
    } catch {
      // No BroadcastChannel: coming back into view still catches it.
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && this.userId === null) {
        void this.refresh();
      }
    });
  }

  /**
   * In the tab {@link signInInNewTab} opened, once back from the IdP: tell the tab that opened it,
   * and close. If it cannot close (opened some other way), it just stays on the page.
   */
  #finishSignInTab(): void {
    const url = new URL(location.href);
    if (url.searchParams.get(SIGNED_IN_PARAM) !== "done") return;
    url.searchParams.delete(SIGNED_IN_PARAM);
    history.replaceState(history.state, "", url.href);
    try {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage("signed-in");
      channel.close();
    } catch {
      // The opener notices when it comes back into view.
    }
    if (globalThis.opener) globalThis.close();
  }

  /** Sign out at the IdP, then notify every subscriber. */
  async signOut(): Promise<void> {
    if (!this.fetchDpop) return;
    await this.fetchDpop(`${IDP_ORIGIN}/session/logout`, { method: "POST" });
    this.userId = null;
    this.token = null;
    this.#emitChange();
  }

  /**
   * Calls this app's API: DPoP-signed always, with the IdP token when signed in.
   *
   * A `401` while signed in usually means the hour-long token ran out, so the session is probed
   * once more and the request retried with the fresh token. A second `401` is returned as is.
   *
   * @param path An app-relative URL, e.g. `routes.api.me.show.href()`
   * @param init As for `fetch`
   * @returns The API's response
   */
  async apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
    await this.load();
    const fetchDpop = this.fetchDpop;
    if (!fetchDpop) throw new Error("DPoP を初期化できませんでした。");
    const url = new URL(path, globalThis.location.origin).href;
    const send = () => {
      const headers = new Headers(init.headers);
      if (this.token) headers.set("authorization", `DPoP ${this.token}`);
      return fetchDpop(url, { ...init, headers });
    };

    const response = await send();
    if (response.status !== 401 || !this.token) return response;
    await response.body?.cancel();
    await this.#probe();
    this.#emitChange();
    return send();
  }

  /** Asks the IdP who this key belongs to, and for a fresh token. */
  async #probe(): Promise<void> {
    if (!this.fetchDpop) return;
    try {
      const response = await this.fetchDpop(`${IDP_ORIGIN}/session`);
      if (response.ok) {
        const session = (await response.json()) as {
          userId: string | null;
          jws?: string;
        };
        this.userId = session.userId ?? null;
        this.token = session.userId ? session.jws ?? null : null;
      }
    } catch {
      // Signed out: the cross-origin probe can 401 or reject.
      this.userId = null;
      this.token = null;
    }
  }

  #emitChange(): void {
    this.dispatchEvent(new Event("change"));
  }
}

export const sessionStore: DpopSessionStore = new DpopSessionStore();
