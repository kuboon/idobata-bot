/**
 * MyOpinionsCard — the `/my` page's list of the signed-in user's own opinions, across documents.
 *
 * Each links to its document. An opinion still one person's (no supports, no opinion naming it,
 * not adopted) can be deleted here; the rest are shown locked (docs/design.md §5).
 */

import {
  clientEntry,
  css,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/component";
import { type Opinion, STANCE_LABELS } from "@kuboon/idobata-bot";

import { formatDateTime } from "../lib/format.ts";
import { opinionClient } from "../opinions/store.ts";
import { routes } from "../routes.ts";
import { sessionStore } from "../session.ts";
import {
  actionStyle,
  alertStyle,
  cardStyle,
  dangerStyle,
  metaStyle,
} from "../theme.ts";
import { color } from "../tokens.ts";

export interface MyOpinionsCardProps {
  [key: string]: SerializableValue;
}

export const MyOpinionsCard = clientEntry(
  import.meta.url,
  function MyOpinionsCard(handle: Handle<MyOpinionsCardProps>) {
    let opinions: Opinion[] | null = null;
    let loadedFor: string | null = null;
    let error = "";

    const load = async () => {
      const userId = sessionStore.userId;
      if (!userId) {
        opinions = null;
        loadedFor = null;
        handle.update();
        return;
      }
      if (loadedFor === userId) return;
      loadedFor = userId;
      try {
        opinions = await opinionClient.mine();
        error = "";
      } catch (e) {
        error = `自分の意見を読み込めませんでした: ${(e as Error).message}`;
      }
      handle.update();
    };

    const remove = async (opinion: Opinion) => {
      if (!confirm(`「${opinion.title}」を削除しますか？`)) return;
      try {
        await opinionClient.remove(opinion.id);
        opinions = (opinions ?? []).filter((o) => o.id !== opinion.id);
      } catch (e) {
        error = `削除できませんでした: ${(e as Error).message}`;
      }
      handle.update();
    };

    if (typeof document !== "undefined") {
      sessionStore.addEventListener("change", () => void load(), {
        signal: handle.signal,
      });
      void sessionStore.load().then(load);
    }

    return () => {
      if (!sessionStore.userId) return null;
      return (
        <section mix={cardStyle}>
          <h2>自分の意見</h2>
          {error
            ? <div role="alert" data-kind="error" mix={alertStyle}>{error}</div>
            : null}
          {opinions === null
            ? <p mix={metaStyle}>読み込んでいます…</p>
            : opinions.length === 0
            ? <p>まだ意見を投稿していません。</p>
            : (
              <ul mix={listStyle}>
                {opinions.map((o) => (
                  <li key={o.id}>
                    <a href={routes.document.href({ docId: o.documentId })}>
                      {o.title}
                    </a>
                    <span mix={metaStyle}>
                      {o.targets.map((t) => STANCE_LABELS[t.stance]).join("・")}
                      {" "}
                      ・ {formatDateTime(o.createdAt)} ・ 賛同 {o.supportCount}
                      {o.frozen ? " ・ 賛同や応答があるため変更できません" : ""}
                    </span>
                    {o.frozen ? null : (
                      <button
                        type="button"
                        mix={[
                          actionStyle,
                          dangerStyle,
                          on("click", () => void remove(o)),
                        ]}
                      >
                        削除
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
        </section>
      );
    };
  },
);

const listStyle = css({
  listStyle: "none",
  padding: 0,
  "& > li": {
    paddingBlock: "0.5rem",
    borderTop: `1px solid ${color.border}`,
  },
});
