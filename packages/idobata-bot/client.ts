/**
 * Calls the opinion service. Framework-agnostic: the caller hands in the `fetch` to use — one that
 * signs requests with the browser's DPoP key and the IdP token, like the site's
 * `sessionStore.apiFetch` — and the service's base URL.
 */

import type {
  ModerationInput,
  Opinion,
  OpinionDetail,
  OpinionInput,
  OpinionList,
  OwnerView,
} from "./types.ts";

/** A `fetch` that authenticates to the service; relative paths resolve against `baseUrl`. */
export type AuthedFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export interface OpinionClientOptions {
  /** The service's origin, or `""` for the page's own. */
  baseUrl?: string;
  fetch: AuthedFetch;
}

/** The service refused: `status` is the HTTP status, `message` its reason. */
export class OpinionApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "OpinionApiError";
  }
}

export interface OpinionClient {
  list(documentId: string): Promise<OpinionList>;
  get(opinionId: string): Promise<OpinionDetail>;
  post(documentId: string, input: OpinionInput): Promise<Opinion>;
  update(opinionId: string, input: OpinionInput): Promise<Opinion>;
  remove(opinionId: string): Promise<void>;
  support(opinionId: string): Promise<Opinion>;
  unsupport(opinionId: string): Promise<Opinion>;
  /** The signed-in user's own opinions, newest first, across documents. */
  mine(): Promise<Opinion[]>;
  /** The owner's view of a document's opinions. The document's owner only. */
  manage(documentId: string): Promise<OwnerView>;
  /** Hides or shows an opinion again, with a reason. The document's owner only. */
  moderate(opinionId: string, input: ModerationInput): Promise<Opinion>;
}

/** Builds a client for the opinion service. */
export function createOpinionClient(
  options: OpinionClientOptions,
): OpinionClient {
  const base = options.baseUrl ?? "";
  const call = async <T>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    const response = await options.fetch(`${base}${path}`, {
      ...init,
      headers,
    });
    if (response.status === 204) return undefined as T;
    const body = await response.json().catch(() => ({})) as {
      error?: string;
    };
    if (!response.ok) {
      throw new OpinionApiError(
        response.status,
        body.error ?? `HTTP ${response.status}`,
      );
    }
    return body as T;
  };
  const id = encodeURIComponent;

  return {
    list: (documentId) => call(`/api/docs/${id(documentId)}/opinions`),
    get: (opinionId) =>
      call<{ opinion: OpinionDetail }>(`/api/opinions/${id(opinionId)}`)
        .then((b) => b.opinion),
    post: (documentId, input) =>
      call<{ opinion: Opinion }>(`/api/docs/${id(documentId)}/opinions`, {
        method: "POST",
        body: JSON.stringify(input),
      }).then((b) => b.opinion),
    update: (opinionId, input) =>
      call<{ opinion: Opinion }>(`/api/opinions/${id(opinionId)}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }).then((b) => b.opinion),
    remove: (opinionId) =>
      call<void>(`/api/opinions/${id(opinionId)}`, { method: "DELETE" }),
    support: (opinionId) =>
      call<{ opinion: Opinion }>(`/api/opinions/${id(opinionId)}/support`, {
        method: "PUT",
      }).then((b) => b.opinion),
    unsupport: (opinionId) =>
      call<{ opinion: Opinion }>(`/api/opinions/${id(opinionId)}/support`, {
        method: "DELETE",
      }).then((b) => b.opinion),
    mine: () =>
      call<{ opinions: Opinion[] }>("/api/me/opinions").then((b) => b.opinions),
    manage: (documentId) =>
      call<OwnerView>(`/api/docs/${id(documentId)}/manage`),
    moderate: (opinionId, input) =>
      call<{ opinion: Opinion }>(
        `/api/opinions/${id(opinionId)}/moderation`,
        { method: "POST", body: JSON.stringify(input) },
      ).then((b) => b.opinion),
  };
}
