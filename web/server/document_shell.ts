/**
 * `/d/:docId` on Cloudflare: the static document page, with the document's own title.
 *
 * The static build writes the document page once, as `/d/_shell` (see `routes.document`). The
 * Worker answers every `/d/:docId` by fetching that file from the static assets and writing the
 * document's title and description into its `<head>` — so a shared link previews as the document,
 * not as "文書". The island on the page then loads the document itself.
 */

import { DOCUMENT_SHELL_ID, routes } from "../client/routes.ts";
import { getDocumentSummary } from "./lib/documents.ts";

/** The Workers static assets binding (`env.ASSETS`). */
export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** What the page's `<head>` says for a document. */
export interface DocumentHead {
  title: string;
  description: string;
}

/** The `<head>` text for a document, or `null` when there is no such document. */
export async function documentHead(
  docId: string,
): Promise<DocumentHead | null> {
  const summary = await getDocumentSummary(docId);
  if (!summary) return null;
  return {
    title: `${summary.title} — idobata-bot`,
    description: summary.description ||
      `「${summary.title}」を読み、段落を選んで意見を書きます。`,
  };
}

/** `HTMLRewriter`, which only the Workers runtime has. */
interface Rewriter {
  on(
    selector: string,
    handlers: {
      element(element: {
        setInnerContent(content: string): void;
        setAttribute(name: string, value: string): void;
      }): void;
    },
  ): Rewriter;
  transform(response: Response): Response;
}

/**
 * Serves the document page for `/d/:docId`.
 *
 * @param request The request for `/d/:docId`
 * @param docId The ID in it
 * @param assets The static assets, where the shell is
 */
export async function serveDocumentShell(
  request: Request,
  docId: string,
  assets: AssetsBinding,
): Promise<Response> {
  const shellUrl = new URL(
    routes.document.href({ docId: DOCUMENT_SHELL_ID }),
    request.url,
  );
  const shell = await assets.fetch(new Request(shellUrl, request));
  const head = shell.ok ? await documentHead(docId) : null;
  const HTMLRewriter = (globalThis as {
    HTMLRewriter?: new () => Rewriter;
  }).HTMLRewriter;
  if (!head || !HTMLRewriter) return shell;

  return new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(head.title) })
    .on('meta[property="og:title"]', {
      element: (e) => e.setAttribute("content", head.title),
    })
    .on('meta[name="description"], meta[property="og:description"]', {
      element: (e) => e.setAttribute("content", head.description),
    })
    .transform(shell);
}
