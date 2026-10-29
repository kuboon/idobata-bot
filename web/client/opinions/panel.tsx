/**
 * The opinion panel: the opinions about what the reader selected, and the form to write one.
 *
 * - Nothing selected: every opinion on the document.
 * - Segments selected: the opinions about any of them, and a form whose targets are those segments
 *   (one stance each), plus any opinions the reader chose to answer.
 *
 * Plain markup and a store; no AI yet — the chat that drafts opinions comes in a later layer and
 * fills the same form. Every field is uncontrolled (`defaultValue` + `ref`).
 */

import { css, type Handle, on, ref } from "@remix-run/component";
import {
  type Opinion,
  OpinionApiError,
  type Stance,
  STANCE_LABELS,
  STANCES,
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
import { color, radius } from "../tokens.ts";
import type { OpinionStore } from "./store.ts";

export interface OpinionPanelProps {
  store: OpinionStore;
  /** Selected segments, in document order, with a short label each (their heading path or text). */
  selected: { key: string; label: string }[];
  /** Labels for every segment key, for showing an opinion's targets. */
  segmentLabels: Map<string, string>;
  /** Whether the document still takes opinions. */
  open: boolean;
}

/** A short, one-line label for a stance on a target. */
function targetLabel(
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
  /** Opinions the reader chose to answer, by ID. */
  const answering = new Set<string>();
  const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
  const stances = new Map<string, HTMLSelectElement>();
  let busy = false;
  let message: { kind: "error" | "success"; text: string } | null = null;

  if (typeof document !== "undefined") {
    handle.props.store.addEventListener("change", () => handle.update(), {
      signal: handle.signal,
    });
    sessionStore.addEventListener("change", () => handle.update(), {
      signal: handle.signal,
    });
  }

  const fail = (e: unknown) => {
    message = {
      kind: "error",
      text: e instanceof OpinionApiError ? e.message : String(e),
    };
    handle.update();
  };

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    const { store, selected } = handle.props;
    const stanceOf = (key: string): Stance =>
      (stances.get(key)?.value as Stance | undefined) ?? "concern";
    const targets: Target[] = [
      ...selected.map((s) => ({
        kind: "segment" as const,
        segmentKey: s.key,
        stance: stanceOf(`s:${s.key}`),
      })),
      ...[...answering].map((id) => ({
        kind: "opinion" as const,
        opinionId: id,
        stance: stanceOf(`o:${id}`),
      })),
    ];
    if (targets.length === 0) {
      targets.push({ kind: "document", stance: stanceOf("d") });
    }
    busy = true;
    message = null;
    handle.update();
    try {
      await store.post({
        title: fields.title?.value ?? "",
        claim: fields.claim?.value ?? "",
        reason: fields.reason?.value ?? "",
        suggestion: fields.suggestion?.value ?? "",
        targets,
      });
      for (const field of Object.values(fields)) field.value = "";
      answering.clear();
      message = { kind: "success", text: "意見を投稿しました。" };
    } catch (e) {
      fail(e);
    } finally {
      busy = false;
      handle.update();
    }
  };

  const stanceSelect = (key: string, initial: Stance) => (
    <select
      aria-label="立場"
      defaultValue={initial}
      mix={[
        inputStyle,
        ref((node) => {
          stances.set(key, node as HTMLSelectElement);
        }),
      ]}
    >
      {STANCES.map((s) => <option key={s} value={s}>{STANCE_LABELS[s]}
      </option>)}
    </select>
  );

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
                  on("click", () => {
                    answering.add(opinion.id);
                    handle.update();
                  }),
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
    const { store, selected, open } = handle.props;
    if (!store.loaded) return <p mix={metaStyle}>意見を読み込んでいます…</p>;

    const keys = new Set(selected.map((s) => s.key));
    const shown = keys.size === 0
      ? store.opinions
      : store.opinions.filter((o) =>
        o.targets.some((t) => t.kind === "segment" && keys.has(t.segmentKey))
      );
    const answered = [...answering].map((id) => store.byId(id)).filter(
      (o): o is Opinion => o !== undefined,
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

        <h3>意見を書く</h3>
        {!open ? <p>募集は終了しました。</p> : sessionStore.userId === null
          ? (
            <p>
              意見を投稿するにはサインインしてください（ナビバー右上の「Sign
              In」）。
            </p>
          )
          : (
            <form mix={[formStyle, on<HTMLFormElement>("submit", onSubmit)]}>
              <fieldset mix={targetsFieldStyle}>
                <legend>何に対する意見か</legend>
                {selected.map((s) => (
                  <label key={`s:${s.key}`} mix={targetRowStyle}>
                    <span>「{s.label}」への</span>
                    {stanceSelect(`s:${s.key}`, "concern")}
                  </label>
                ))}
                {answered.map((o) => (
                  <label key={`o:${o.id}`} mix={targetRowStyle}>
                    <span>意見「{o.title}」への</span>
                    {stanceSelect(`o:${o.id}`, "support")}
                    <button
                      type="button"
                      mix={[
                        actionStyle,
                        on("click", () => {
                          answering.delete(o.id);
                          handle.update();
                        }),
                      ]}
                    >
                      外す
                    </button>
                  </label>
                ))}
                {selected.length === 0 && answered.length === 0
                  ? (
                    <label mix={targetRowStyle}>
                      <span>文書全体への</span>
                      {stanceSelect("d", "concern")}
                    </label>
                  )
                  : null}
                <span mix={metaStyle}>
                  段落をクリックすると対象に加えられます。
                </span>
              </fieldset>
              {(
                [
                  ["title", "要旨（一行）", false],
                  ["claim", "主張", true],
                  ["reason", "理由・根拠", true],
                  ["suggestion", "具体的な修正案（任意）", true],
                ] as const
              ).map(([name, label, multiline]) => (
                <label key={name} mix={labelStyle}>
                  {label}
                  {multiline
                    ? (
                      <textarea
                        rows={3}
                        required={name !== "suggestion"}
                        mix={[
                          inputStyle,
                          ref((node) => {
                            fields[name] = node as HTMLTextAreaElement;
                          }),
                        ]}
                      />
                    )
                    : (
                      <input
                        type="text"
                        required
                        maxlength={120}
                        mix={[
                          inputStyle,
                          ref((node) => {
                            fields[name] = node as HTMLInputElement;
                          }),
                        ]}
                      />
                    )}
                </label>
              ))}
              {message
                ? (
                  <div role="alert" data-kind={message.kind} mix={alertStyle}>
                    {message.text}
                  </div>
                )
                : null}
              <div>
                <button
                  type="submit"
                  disabled={busy}
                  mix={[actionStyle, primaryStyle]}
                >
                  投稿する
                </button>
              </div>
            </form>
          )}
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

const formStyle = css({ display: "grid", gap: "0.75rem" });

const targetsFieldStyle = css({
  display: "grid",
  gap: "0.4rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  padding: "0.5rem 0.75rem",
});

const targetRowStyle = css({
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.5rem",
});

const labelStyle = css({ display: "grid", gap: "0.3rem", fontWeight: 600 });

const inputStyle = css({
  font: "inherit",
  fontWeight: 400,
  padding: "0.4rem 0.55rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: color.bg,
  color: color.fg,
});
