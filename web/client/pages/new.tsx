import { type Handle } from "@remix-run/component";

import { NewDocumentForm } from "../islands/new_document_form.tsx";

export const title = "文書を登録 — idobata-bot";
export const description = "意見を募集する文書を Markdown で登録します。";

export const hydrate = true;

export default function NewDocument(_handle: Handle) {
  return () => (
    <>
      <h1>文書を登録</h1>
      <p>
        意見を募集したい文書を Markdown で登録します。登録した文書は段落ごとに
        分けて表示され、読む人は段落を選んで AI と対話しながら意見を書けます。
      </p>
      <NewDocumentForm />
    </>
  );
}
