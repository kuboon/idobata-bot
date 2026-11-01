/**
 * The posting dialog: a modal `<dialog>` with the opinion form, or — for an AI's suggestion to
 * support an existing opinion — that opinion and a button to support it. What it shows is the
 * {@link ComposeStore}'s request; however the reader leaves it is reported back to whoever opened
 * it, which for the AI's `draft_opinion` is how the AI learns whether the opinion was posted.
 *
 * Every field is uncontrolled (`defaultValue` + `ref`) and keyed by the request's generation, so
 * a new draft is new elements with its values.
 */

import { css, type Handle, on, ref } from "@remix-run/component";
import {
  OpinionApiError,
  type Stance,
  STANCE_LABELS,
  STANCES,
  type Target,
} from "@kuboon/idobata-bot";

import { sessionStore } from "../session.ts";
import { actionStyle, alertStyle, metaStyle, primaryStyle } from "../theme.ts";
import { color, radius } from "../tokens.ts";
import type { ComposeStore } from "./compose.ts";
import { targetLabel } from "./panel.tsx";
import type { OpinionStore } from "./store.ts";

export interface PostDialogProps {
  compose: ComposeStore;
  store: OpinionStore;
  /** Labels for every segment key, for naming the targets. */
  segmentLabels: Map<string, string>;
}

/** What a target is about, without its stance. */
const targetKey = (t: Target) =>
  t.kind === "segment"
    ? `s:${t.segmentKey}`
    : t.kind === "opinion"
    ? `o:${t.opinionId}`
    : "d";

const FIELDS = [
  ["title", "タイトル", false],
  ["body", "本文（任意）", true],
] as const;

export function PostDialog(handle: Handle<PostDialogProps>) {
  let dialog: HTMLDialogElement | null = null;
  const fields: Record<string, HTMLInputElement | HTMLTextAreaElement> = {};
  /** Each target's stance select, by {@link targetKey}. */
  const stances = new Map<string, HTMLSelectElement>();
  /** The request's targets, which the reader may take some of out. */
  let targets: Target[] = [];
  let generation = -1;
  let busy = false;
  let error = "";

  /** Opens or closes the element to match the request. */
  const sync = () => {
    if (!dialog) return;
    const want = handle.props.compose.current !== null;
    if (want && !dialog.open) dialog.showModal();
    if (!want && dialog.open) dialog.close();
  };

  if (typeof document !== "undefined") {
    const { compose } = handle.props;
    compose.addEventListener("change", () => {
      if (compose.generation !== generation) {
        generation = compose.generation;
        const current = compose.current;
        targets = current?.kind === "opinion" ? [...current.draft.targets] : [];
        error = "";
        busy = false;
      }
      handle.update();
      setTimeout(sync);
    }, { signal: handle.signal });
    sessionStore.addEventListener("change", () => handle.update(), {
      signal: handle.signal,
    });
  }

  const fail = (e: unknown) => {
    error = e instanceof OpinionApiError ? e.message : String(e);
    busy = false;
    handle.update();
  };

  const onSubmit = async (event: Event) => {
    event.preventDefault();
    const { compose, store } = handle.props;
    busy = true;
    error = "";
    handle.update();
    try {
      const opinion = await store.post({
        title: fields.title?.value ?? "",
        body: fields.body?.value ?? "",
        targets: targets.map((t) => ({
          ...t,
          stance: (stances.get(targetKey(t))?.value as Stance | undefined) ??
            t.stance,
        })),
      });
      busy = false;
      compose.finish({ kind: "posted", opinion });
    } catch (e) {
      fail(e);
    }
  };

  const support = async (opinionId: string) => {
    busy = true;
    handle.update();
    try {
      await handle.props.store.setSupport(opinionId, true);
      busy = false;
      handle.props.compose.finish({ kind: "supported", opinionId });
    } catch (e) {
      fail(e);
    }
  };

  const close = () => handle.props.compose.finish({ kind: "closed" });

  // The dialog is modal, so the navbar's Sign In is out of reach; and signing in in this tab would
  // lose the draft and the chat, which live only in memory. So it signs in in another tab and
  // comes back to this dialog as it is.
  const signInNote = (
    <div data-kind="error" mix={[alertStyle, signInStyle]}>
      <span>
        投稿するにはサインインが必要です。サインインは新しいタブで開き、終わるとこの画面に戻ります（下書きはそのまま）。
      </span>
      <button
        type="button"
        mix={[
          actionStyle,
          primaryStyle,
          on("click", () => sessionStore.signInInNewTab()),
        ]}
      >
        サインイン / 登録
      </button>
    </div>
  );

  const errorNote = () =>
    error
      ? <div role="alert" data-kind="error" mix={alertStyle}>{error}</div>
      : null;

  const supportBody = (opinionId: string) => {
    const opinion = handle.props.store.byId(opinionId);
    const signedIn = sessionStore.userId !== null;
    return (
      <div mix={bodyStyle}>
        <h2>この意見に賛同しますか？</h2>
        <p mix={metaStyle}>
          AI は、同じ趣旨の意見がすでに出ていると判断しました。
        </p>
        {opinion
          ? (
            <blockquote mix={quoteStyle}>
              <strong>{opinion.title}</strong>
              {opinion.body ? <p mix={preWrapStyle}>{opinion.body}</p> : null}
              <span mix={metaStyle}>賛同 {opinion.supportCount}</span>
            </blockquote>
          )
          : <p mix={metaStyle}>意見を読み込んでいます…</p>}
        {signedIn ? null : signInNote}
        {errorNote()}
        <div mix={buttonsStyle}>
          <button
            type="button"
            disabled={busy || !signedIn || !opinion || opinion.supportedByMe}
            mix={[
              actionStyle,
              primaryStyle,
              on("click", () => void support(opinionId)),
            ]}
          >
            {opinion?.supportedByMe ? "賛同済み" : "賛同する"}
          </button>
          <button type="button" mix={[actionStyle, on("click", close)]}>
            閉じる
          </button>
        </div>
      </div>
    );
  };

  const opinionBody = (
    draft: Extract<
      NonNullable<ComposeStore["current"]>,
      { kind: "opinion" }
    >,
  ) => {
    const { store, segmentLabels } = handle.props;
    const signedIn = sessionStore.userId !== null;
    return (
      <form
        key={`f${generation}`}
        mix={[bodyStyle, on<HTMLFormElement>("submit", onSubmit)]}
      >
        <h2>意見を書く</h2>
        {draft.fromAssistant
          ? (
            <p mix={metaStyle}>
              AI が対話から下書きを作りました。直してから投稿してください。
            </p>
          )
          : null}
        <div mix={targetsStyle} aria-label="対象と立場">
          {targets.map((t) => (
            <div key={targetKey(t)} mix={targetRowStyle}>
              <span>
                {targetLabel(t, segmentLabels, store).replace(
                  /への.*$/,
                  "への",
                )}
              </span>
              <select
                aria-label="立場"
                mix={[
                  inputStyle,
                  ref((node) => {
                    stances.set(targetKey(t), node as HTMLSelectElement);
                  }),
                ]}
              >
                {STANCES.map((s) => (
                  // A select's `defaultValue` is not applied; the option says it.
                  <option key={s} value={s} selected={s === t.stance}>
                    {STANCE_LABELS[s]}
                  </option>
                ))}
              </select>
              {targets.length > 1
                ? (
                  <button
                    type="button"
                    mix={[
                      actionStyle,
                      on("click", () => {
                        targets = targets.filter((u) => u !== t);
                        handle.update();
                      }),
                    ]}
                  >
                    外す
                  </button>
                )
                : null}
            </div>
          ))}
        </div>
        {FIELDS.map(([name, label, multiline]) => (
          <label key={name} mix={labelStyle}>
            {label}
            {multiline
              ? (
                <textarea
                  rows={6}
                  defaultValue={draft.draft[name] ?? ""}
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
                  defaultValue={draft.draft[name] ?? ""}
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
        {signedIn ? null : signInNote}
        {errorNote()}
        <div mix={buttonsStyle}>
          <button
            type="submit"
            disabled={busy || !signedIn}
            mix={[actionStyle, primaryStyle]}
          >
            投稿する
          </button>
          <button type="button" mix={[actionStyle, on("click", close)]}>
            閉じる
          </button>
        </div>
      </form>
    );
  };

  return () => {
    const current = handle.props.compose.current;
    return (
      <dialog
        aria-label="意見の投稿"
        mix={[
          dialogStyle,
          ref((node) => {
            dialog = node as HTMLDialogElement;
            setTimeout(sync);
          }),
          // Escape closes the element itself; report it like the close button.
          on("close", () => {
            if (handle.props.compose.current) close();
          }),
        ]}
      >
        {current?.kind === "opinion"
          ? opinionBody(current)
          : current?.kind === "support"
          ? supportBody(current.opinionId)
          : null}
      </dialog>
    );
  };
}

const dialogStyle = css({
  width: "min(36rem, calc(100vw - 2rem))",
  maxHeight: "calc(100vh - 2rem)",
  padding: 0,
  border: `1px solid ${color.border}`,
  borderRadius: radius.lg,
  background: color.bg,
  color: color.fg,
  "&::backdrop": { background: "rgb(0 0 0 / 0.4)" },
});

const bodyStyle = css({
  display: "grid",
  gap: "0.75rem",
  padding: "1rem 1.25rem",
  "& h2": { fontSize: "1.1rem", margin: 0 },
});

const preWrapStyle = css({ whiteSpace: "pre-wrap" });

const signInStyle = css({
  display: "grid",
  justifyItems: "start",
  gap: "0.5rem",
});

const quoteStyle = css({
  margin: 0,
  padding: "0.5rem 0.75rem",
  borderInlineStart: `3px solid ${color.accent}`,
  background: color.card,
  "& p": { marginBlock: "0.35rem" },
});

const buttonsStyle = css({
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
});

const targetsStyle = css({ display: "grid", gap: "0.4rem" });

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
