/**
 * The opinion panel: the opinions about what the reader selected, and the ways to add one.
 *
 * - Nothing selected: every opinion on the document.
 * - Segments selected: the opinions about any of them.
 *
 * Under them, 「AI と対話する」 starts the chat in the corner (`assistant.ts`) about the selection,
 * and 「自分で書く」 opens the posting dialog (`post_dialog.tsx`) with the selection as its targets.
 * The AI opens the same dialog, with its draft filled in.
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
import type { ComposeStore } from "./compose.ts";
import type { OpinionStore } from "./store.ts";

export interface OpinionPanelProps {
  store: OpinionStore;
  /** Selected segments, in document order, with a short label each (their heading path or text). */
  selected: { key: string; label: string }[];
  /** Labels for every segment key, for showing an opinion's targets. */
  segmentLabels: Map<string, string>;
  /** Whether the document still takes opinions. */
  open: boolean;
  /** The posting dialog. */
  compose: ComposeStore;
  /** Starts (or shows) the chat about the selection. */
  onTalk(): void;
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

  /** The posting dialog, aimed at the selection — or the document, with nothing selected. */
  const write = () => {
    const { selected, compose } = handle.props;
    const targets: Target[] = selected.length === 0
      ? [{ kind: "document", stance: "concern" }]
      : selected.map((s) => ({
        kind: "segment",
        segmentKey: s.key,
        stance: "concern",
      }));
    void compose.open({ kind: "opinion", draft: { targets } });
  };

  const card = (opinion: Opinion) => {
    const { store, segmentLabels, open } = handle.props;
    const signedIn = sessionStore.userId !== null;
    return (
      <li key={opinion.id} mix={opinionStyle}>
        <strong>{opinion.title}</strong>
        <ul mix={targetsStyle}>
          {opinion.targets.map((t) => (
            <li key={JSON.stringify(t)} data-stance={t.stance}>
              {targetLabel(t, segmentLabels, store)}
            </li>
          ))}
        </ul>
        <p>{opinion.claim}</p>
        <p mix={metaStyle}>理由: {opinion.reason}</p>
        {opinion.suggestion
          ? <p mix={metaStyle}>修正案: {opinion.suggestion}</p>
          : null}
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
              <button
                type="button"
                mix={[
                  actionStyle,
                  on("click", () =>
                    void handle.props.compose.open({
                      kind: "opinion",
                      draft: {
                        targets: [{
                          kind: "opinion",
                          opinionId: opinion.id,
                          stance: "support",
                        }],
                      },
                    })),
                ]}
              >
                この意見に応答
              </button>
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
        {store.hiddenCount
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
              <button
                type="button"
                mix={[actionStyle, on("click", write)]}
              >
                自分で書く
              </button>
              <span mix={metaStyle}>
                {keys.size === 0
                  ? "文書全体について話します。段落を選ぶと、その段落について話せます。"
                  : "AI が、この段落にすでに出ている意見との関係を確かめながら、意見をまとめる手伝いをします。"}
              </span>
            </div>
          )
          : <p>募集は終了しました。</p>}
      </section>
    );
  };
}

const panelStyle = css({ "& h2": { fontSize: "1.1rem" } });

const listStyle = css({ listStyle: "none", padding: 0, margin: 0 });

const opinionStyle = css({
  paddingBlock: "0.75rem",
  borderTop: `1px solid ${color.border}`,
  "& > p": { marginBlock: "0.35rem" },
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
