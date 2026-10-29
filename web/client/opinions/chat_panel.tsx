/**
 * The chat with the AI about the document: the conversation, a draft card for each opinion the AI
 * put forward, and the box to write in. Drafts go into the opinion form through `onDraft`; the
 * reader edits and posts them there — the AI never posts.
 */

import { css, type Handle, on, ref } from "@remix-run/component";
import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatDraft,
  STANCE_LABELS,
} from "@kuboon/idobata-bot";

import { actionStyle, alertStyle, metaStyle, primaryStyle } from "../theme.ts";
import { color, radius } from "../tokens.ts";
import type { ChatStore } from "./chat.ts";
import type { OpinionStore } from "./store.ts";

export interface ChatPanelProps {
  chat: ChatStore;
  store: OpinionStore;
  /** The selection now, which a new conversation starts from. */
  selectedKeys: string[];
  segmentLabels: Map<string, string>;
  /** Puts a draft into the opinion form, or supports the opinion it names. */
  onDraft(draft: ChatDraft): void;
}

export function ChatPanel(handle: Handle<ChatPanelProps>) {
  let input: HTMLTextAreaElement | null = null;

  if (typeof document !== "undefined") {
    handle.props.chat.addEventListener("change", () => handle.update(), {
      signal: handle.signal,
    });
  }

  const send = () => {
    const { chat, selectedKeys } = handle.props;
    const text = input?.value.trim() ?? "";
    if (!text || chat.busy) return;
    if (input) input.value = "";
    void chat.send(text, selectedKeys).then(() => {
      // A failed turn gives the message back, to send again.
      if (chat.error && input && !input.value) input.value = text;
    });
  };

  const draftCard = (draft: ChatDraft, i: number) => {
    const { store, segmentLabels, onDraft } = handle.props;
    if (draft.type === "support") {
      const opinion = store.byId(draft.opinionId);
      return (
        <li key={`d${i}`} mix={draftStyle}>
          <span mix={metaStyle}>賛同の提案</span>
          <strong>{opinion?.title ?? "（見つからない意見）"}</strong>
          {opinion
            ? (
              <div>
                <button
                  type="button"
                  mix={[actionStyle, on("click", () => onDraft(draft))]}
                >
                  この意見に賛同する
                </button>
              </div>
            )
            : null}
        </li>
      );
    }
    const { input } = draft;
    return (
      <li key={`d${i}`} mix={draftStyle}>
        <span mix={metaStyle}>意見の下書き</span>
        <strong>{input.title}</strong>
        <ul mix={chipsStyle}>
          {input.targets.map((t) => (
            <li key={JSON.stringify(t)}>
              {t.kind === "segment"
                ? `「${segmentLabels.get(t.segmentKey) ?? "段落"}」`
                : t.kind === "opinion"
                ? `意見「${store.byId(t.opinionId)?.title ?? "…"}」`
                : "文書全体"}
              への{STANCE_LABELS[t.stance]}
            </li>
          ))}
        </ul>
        <p>{input.claim}</p>
        {input.reason ? <p mix={metaStyle}>理由: {input.reason}</p> : null}
        {input.suggestion
          ? <p mix={metaStyle}>修正案: {input.suggestion}</p>
          : null}
        <div>
          <button
            type="button"
            mix={[actionStyle, primaryStyle, on("click", () => onDraft(draft))]}
          >
            フォームに入れて編集する
          </button>
        </div>
      </li>
    );
  };

  return () => {
    const { chat, selectedKeys, segmentLabels } = handle.props;
    const entries = chat.entries;
    const startKeys = chat.started ? chat.segmentKeys : selectedKeys;
    const about = startKeys.length === 0
      ? "文書全体"
      : startKeys.map((k) => `「${segmentLabels.get(k) ?? "段落"}」`).join(
        "、",
      );

    return (
      <section mix={chatStyle} aria-label="AI と話す">
        <h3>AI と話す</h3>
        <p mix={metaStyle}>
          {chat.started ? `${about}についての会話` : `${about}について話します`}
          。会話はこのタブの中にだけ残り、サーバーには保存されません。
        </p>
        {entries.length
          ? (
            <ul mix={logStyle} aria-live="polite">
              {entries.map((e, i) =>
                e.kind === "draft"
                  ? draftCard(e.draft, i)
                  : (
                    <li key={`m${i}`} data-role={e.role} mix={bubbleStyle}>
                      {e.text}
                    </li>
                  )
              )}
              {chat.streaming
                ? (
                  <li key="streaming" data-role="assistant" mix={bubbleStyle}>
                    {chat.streaming}
                  </li>
                )
                : null}
            </ul>
          )
          : null}
        {chat.busy && !chat.streaming
          ? <p mix={metaStyle}>考えています…</p>
          : null}
        {chat.error
          ? (
            <div role="alert" data-kind="error" mix={alertStyle}>
              {chat.error}
            </div>
          )
          : null}
        <form
          mix={[
            inputRowStyle,
            on<HTMLFormElement>("submit", (event) => {
              event.preventDefault();
              send();
            }),
          ]}
        >
          <textarea
            rows={2}
            maxlength={CHAT_MESSAGE_MAX_LENGTH}
            aria-label="AI へのメッセージ"
            placeholder="気になったこと、疑問、意見を書いてください"
            mix={[
              textareaStyle,
              ref((node) => {
                input = node as HTMLTextAreaElement;
              }),
              on("keydown", (event) => {
                if (
                  event.key === "Enter" && (event.metaKey || event.ctrlKey)
                ) {
                  event.preventDefault();
                  send();
                }
              }),
            ]}
          />
          <div mix={buttonsStyle}>
            <button
              type="submit"
              disabled={chat.busy}
              mix={[actionStyle, primaryStyle]}
            >
              送る
            </button>
            {chat.started
              ? (
                <button
                  type="button"
                  disabled={chat.busy}
                  mix={[actionStyle, on("click", () => chat.reset())]}
                >
                  新しい会話
                </button>
              )
              : null}
          </div>
        </form>
      </section>
    );
  };
}

const chatStyle = css({
  display: "grid",
  gap: "0.5rem",
  paddingBlock: "0.75rem",
  borderTop: `1px solid ${color.border}`,
});

const logStyle = css({
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gap: "0.5rem",
  maxHeight: "28rem",
  overflowY: "auto",
});

const bubbleStyle = css({
  padding: "0.5rem 0.75rem",
  borderRadius: radius.md,
  whiteSpace: "pre-wrap",
  maxWidth: "90%",
  '&[data-role="user"]': {
    justifySelf: "end",
    background: color.accent,
    color: "#fff",
  },
  '&[data-role="assistant"]': {
    justifySelf: "start",
    border: `1px solid ${color.border}`,
  },
});

const draftStyle = css({
  display: "grid",
  gap: "0.3rem",
  padding: "0.6rem 0.75rem",
  border: `1px dashed ${color.accent}`,
  borderRadius: radius.md,
  "& > p": { margin: 0 },
});

const chipsStyle = css({
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: "0.35rem",
  fontSize: "0.8rem",
});

const inputRowStyle = css({ display: "grid", gap: "0.5rem" });

const buttonsStyle = css({ display: "flex", gap: "0.5rem" });

const textareaStyle = css({
  font: "inherit",
  padding: "0.4rem 0.55rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: color.bg,
  color: color.fg,
});
