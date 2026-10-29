import type { Handle } from "@remix-run/component";

import { IDP_ORIGIN } from "../idp.ts";
import { MyDocumentsCard } from "../islands/my_documents_card.tsx";
import { MyOpinionsCard } from "../islands/my_opinions_card.tsx";
import { ProfileCard } from "../islands/profile_card.tsx";
import { PushCard } from "../islands/push_card.tsx";
import { SignOut } from "../islands/sign_out.tsx";

export const title = "マイページ — idobata-bot";
export const description =
  "自分の文書と意見、ニックネーム、プッシュ通知の設定。";

/** Every card is an island. */
export const hydrate = true;

export default function My(_handle: Handle) {
  return () => (
    <>
      <meta name="idp-origin" content={IDP_ORIGIN} />
      <h1>マイページ</h1>

      <ProfileCard />

      <MyDocumentsCard />

      <MyOpinionsCard />

      <PushCard idpOrigin={IDP_ORIGIN} />

      <SignOut />
    </>
  );
}
