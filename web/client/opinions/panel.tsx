/**
 * The opinion panel: the opinions about what the reader selected, and the ways to add one.
 *
 * - Nothing selected: every opinion on the document.
 * - Segments selected: the opinions about any of them.
 *
 * In the owner's 管理 mode (`managing`) the hidden opinions are listed too, each with its
 * moderation record and a button to hide it or show it again, with a reason that is public.
 *
 * Under them, 「AI と対話する」 shows the chat in the corner (`assistant.ts`), which reads the
 * selection. Opinions are only written through the AI: it weighs them against the ones already
 * there and opens the posting dialog (`post_dialog.tsx`) with its draft filled in.
 */

import { css, type Handle, on } from "@remix-run/component";
import {
  type Opinion,
  OpinionApiError,
  STANCE_LABELS,
  type Target,
} from "@kuboon/idobata-bot";

import { sessionStore } from "../session.ts";
import { formatDateTime } from "../lib/format.ts";
import {
  actionStyle,
  alertStyle,
  cardStyle,
  dangerStyle,
  metaStyle,
  primaryStyle,
} from "../theme.ts";
import { color } from "../tokens.ts";
import type { OpinionStore } from "./store.ts";

export interface OpinionPanelProps {
  store: OpinionStore;
  /** Selected segments, in document order, with a short label each (their heading path or text). */
  selected: { key: string; label: string }[];
  /** Labels for every segment key, for showing an opinion's targets. */
  segmentLabels: Map<string, string>;
  /** Whether the document still takes opinions. */
  open: boolean;
  /** Starts (or shows) the chat about the selection. */
  onTalk(): void;
  /** The owner's 管理 mode: hidden opinions shown, and the way to hide or show one. */
  managing: boolean;
}

/** A short, one-line label for a stance on a target. */
export function targetLabel(
  target: Target,
  segmentLabels: Map<string, string>,
  store: OpinionStore,
): string {
  const stance = STANCE_LABELS[target.stance];
  switch (target.kind) {
    case "segment":
      return `「${
        segmentLabels.get(target.segmentKey) ?? "段落"
      }」への${stance}`;
    case "document":
      return `文書全体への${stance}`;
    case "opinion":
      return `意見「${
        store.byId(target.opinionId)?.title ?? "…"
      }」への${stance}`;
  }
}

export function OpinionPanel(handle: Handle<OpinionPanelProps>) {
  let message = "";

  if (typeof document !== "undefined") {
    handle.props.store.addEventListener("change", () => handle.update(), {
      signal: handle.signal,
    });
    sessionStore.addEventListener("change", () => handle.update(), {
      signal: handle.signal,
    });
  }

  const fail = (e: unknown) => {
    message = e instanceof OpinionApiError ? e.message : String(e);
    handle.update();
  };

  const moderate = (opinion: Opinion) => {
    const hide = opinion.status !== "hidden";
    const reason = globalThis.prompt(
      hide
        ? `「${opinion.title}」を非表示にする理由（公開されます）`
        : `「${opinion.title}」を再表示する理由（公開されます）`,
    )?.trim();
    if (!reason) return;
    void handle.props.store
      .moderate(opinion.id, hide ? "hide" : "unhide", reason)
      .catch(fail);
  };

  /** The owner's controls on one opinion: its moderation record, and hide / show. */
  const moderation = (opinion: Opinion) => {
    const log = handle.props.store.moderation.filter((l) =>
      l.opinionId === opinion.id
    );
    const hidden = opinion.status === "hidden";
    return (
      <div mix={moderationStyle}>
        {log.length > 0
          ? (
            <ul mix={logStyle}>
              {log.map((l) => (
                <li key={l.id}>
                  {formatDateTime(l.createdAt)}{" "}
                  {l.action === "hide" ? "非表示" : "再表示"}: {l.reason}
                </li>
              ))}
            </ul>
          )
          : null}
        <button
          type="button"
          mix={[
            actionStyle,
            hidden ? undefined : dangerStyle,
            on("click", () => moderate(opinion)),
          ]}
        >
          {hidden ? "再表示する" : "非表示にする"}
        </button>
      </div>
    );
  };

  const card = (opinion: Opinion) => {
    const { store, segmentLabels, open, managing } = handle.props;
    const signedIn = sessionStore.userId !== null;
    return (
      <li key={opinion.id} data-status={opinion.status} mix={opinionStyle}>
        <strong>{opinion.title}</strong>
        {opinion.status === "hidden"
          ? <span mix={badgeStyle}>非表示</span>
          : null}
        <ul mix={targetsStyle}>
          {opinion.targets.map((t) => (
            <li key={JSON.stringify(t)} data-stance={t.stance}>
              {targetLabel(t, segmentLabels, store)}
            </li>
          ))}
        </ul>
        {opinion.body ? <p mix={bodyStyle}>{opinion.body}</p> : null}
        <span mix={metaStyle}>
          {opinion.author.nickname} ・ {formatDateTime(opinion.createdAt)}{" "}
          ・ 賛同 {opinion.supportCount}
          {opinion.incomingCount ? ` ・ 応答 ${opinion.incomingCount}` : ""}
        </span>
        {open && signedIn
          ? (
            <div mix={actionsStyle}>
              {opinion.mine ? null : (
                <button
                  type="button"
                  aria-pressed={opinion.supportedByMe ? "true" : "false"}
                  mix={[
                    actionStyle,
                    opinion.supportedByMe ? primaryStyle : undefined,
                    on("click", () =>
                      void store
                        .setSupport(opinion.id, !opinion.supportedByMe)
                        .catch(fail)),
                  ]}
                >
                  {opinion.supportedByMe ? "賛同済み" : "賛同する"}
                </button>
              )}
              {opinion.mine && !opinion.frozen
                ? (
                  <button
                    type="button"
                    mix={[
                      actionStyle,
                      dangerStyle,
                      on("click", () => {
                        if (confirm("この意見を削除しますか？")) {
                          void store.remove(opinion.id).catch(fail);
                        }
                      }),
                    ]}
                  >
                    削除
                  </button>
                )
                : null}
            </div>
          )
          : null}
        {managing ? moderation(opinion) : null}
      </li>
    );
  };

  return () => {
    const { store, selected, open, onTalk } = handle.props;
    if (!store.loaded) return <p mix={metaStyle}>意見を読み込んでいます…</p>;

    const keys = new Set(selected.map((s) => s.key));
    const shown = keys.size === 0
      ? store.opinions
      : store.opinions.filter((o) =>
        o.targets.some((t) => t.kind === "segment" && keys.has(t.segmentKey))
      );

    return (
      <section mix={[cardStyle, panelStyle]} aria-label="意見">
        <h2>
          {keys.size === 0
            ? `この文書への意見（${shown.length} 件）`
            : `選んだ段落への意見（${shown.length} 件）`}
        </h2>
        {store.error
          ? (
            <div role="alert" data-kind="error" mix={alertStyle}>
              {store.error}
            </div>
          )
          : null}
        {message
          ? (
            <div role="alert" data-kind="error" mix={alertStyle}>
              {message}
            </div>
          )
          : null}
        {shown.length === 0
          ? <p mix={metaStyle}>まだ意見はありません。</p>
          : <ul mix={listStyle}>{shown.map(card)}</ul>}
        {store.hiddenCount && !handle.props.managing
          ? (
            <p mix={metaStyle}>
              オーナーが非表示にした意見が {store.hiddenCount} 件あります。
            </p>
          )
          : null}

        {open
          ? (
            <div mix={actionsStyle}>
              <button
                type="button"
                mix={[actionStyle, primaryStyle, on("click", () => onTalk())]}
              >
                AI と対話する
              </button>
              <span mix={metaStyle}>
                {keys.size === 0
                  ? "意見は AI と話しながらまとめます。AI は話の中で、関係する段落を選んで示します。"
                  : "意見は AI と話しながらまとめます。AI は選んだ段落の意見との関係を確かめて、下書きを作ります。"}
              </span>
            </div>
          )
          : <p>募集は終了しました。</p>}
      </section>
    );
  };
}

const panelStyle = css({ "& h2": { fontSize: "1.1rem" } });

/** The body keeps the writer's line breaks. */
const bodyStyle = css({ whiteSpace: "pre-wrap" });

const listStyle = css({ listStyle: "none", padding: 0, margin: 0 });

const opinionStyle = css({
  paddingBlock: "0.75rem",
  borderTop: `1px solid ${color.border}`,
  "& > p": { marginBlock: "0.35rem" },
  '&[data-status="hidden"] > :not(div)': { opacity: 0.6 },
});

const badgeStyle = css({
  marginInlineStart: "0.5rem",
  padding: "0.05rem 0.5rem",
  borderRadius: "999px",
  border: `1px solid ${color.border}`,
  color: color.muted,
  fontSize: "0.75rem",
});

const moderationStyle = css({
  display: "grid",
  justifyItems: "start",
  gap: "0.35rem",
  marginTop: "0.5rem",
  paddingTop: "0.5rem",
  borderTop: `1px dashed ${color.border}`,
});

const logStyle = css({
  margin: 0,
  paddingLeft: "1.1rem",
  color: color.muted,
  fontSize: "0.85rem",
});

const targetsStyle = css({
  listStyle: "none",
  padding: 0,
  margin: "0.25rem 0",
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem",
  fontSize: "0.8rem",
  "& > li": {
    padding: "0.1rem 0.5rem",
    border: `1px solid ${color.border}`,
    borderRadius: "999px",
  },
  '& > li[data-stance="support"]': { borderColor: "#16a34a" },
  '& > li[data-stance="objection"], & > li[data-stance="concern"]': {
    borderColor: "#d97706",
  },
  '& > li[data-stance="proposal"]': { borderColor: color.accent },
});

const actionsStyle = css({
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
  marginTop: "0.5rem",
});
