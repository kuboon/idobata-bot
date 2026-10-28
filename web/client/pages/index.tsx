import { type Handle } from "@remix-run/component";

import { cardStyle } from "../theme.ts";

export const title = "idobata-bot";
export const description =
  "文書を読み込んだ AI と対話しながら、意見を聞き出して投稿する意見募集サービス。";

/** The shell places the sign-in island, so every page boots the runtime. */
export const hydrate = true;

export default function Home(_handle: Handle) {
  return () => (
    <>
      <h1>idobata-bot</h1>
      <p>
        文書を読み込んだ AI
        と対話しながら、あなたの意見を聞き出して投稿します。似た意見がすでに
        あれば対話の中で示すので、賛同したり、その意見への疑問や補足として書いたり
        できます。
      </p>

      <section mix={cardStyle}>
        <h2>文書一覧</h2>
        <p>登録済みの文書はまだありません。</p>
      </section>
    </>
  );
}
