import { type Handle } from "@remix-run/component";

import { DocumentList } from "../islands/document_list.tsx";
import { alertStyle } from "../theme.ts";

export const title = "idobata-bot";
export const description =
  "文書を読み込んだ AI と対話しながら、意見を聞き出して投稿する意見募集サービス。";

/** The shell places the sign-in island, so every page boots the runtime. */
export const hydrate = true;

export default function Home(_handle: Handle) {
  return () => (
    <>
      <h1>idobata-bot</h1>
      <p role="note" data-kind="warning" mix={alertStyle}>
        本プロジェクトは Proof of concept であり、実用に向けて調整中です。
      </p>
      <p>
        文書を読み込んだ AI
        と対話しながら、あなたの意見を聞き出して投稿します。似た意見がすでに
        あれば対話の中で示すので、賛同したり、その意見への疑問や補足として書いたり
        できます。
      </p>

      <DocumentList />
    </>
  );
}
