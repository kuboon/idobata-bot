import { type Handle } from "@remix-run/component";

import { DocumentView } from "../islands/document_view.tsx";

/** The Worker replaces these with the document's own when it serves `/d/:docId`. */
export const title = "文書 — idobata-bot";
export const description = "文書を読み、段落を選んで意見を書きます。";

export const hydrate = true;

export default function Document(_handle: Handle) {
  return () => <DocumentView />;
}
