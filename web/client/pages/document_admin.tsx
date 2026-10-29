import { type Handle } from "@remix-run/component";

import { DocumentAdmin } from "../islands/document_admin.tsx";

export const title = "文書の管理 — idobata-bot";
export const description =
  "文書のオーナーが、文書と寄せられた意見を管理します。";

export const hydrate = true;

export default function DocumentAdminPage(_handle: Handle) {
  return () => <DocumentAdmin />;
}
