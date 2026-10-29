/**
 * NewDocumentForm — registers a Markdown document through `POST /api/docs`.
 *
 * Signing in is required to register; signed out, the form says so instead of showing fields.
 * Every field is uncontrolled (`defaultValue` + `ref`): a `value` bound to state would fight the
 * runtime's reflection and revert keystrokes.
 */

import {
  clientEntry,
  css,
  type Handle,
  on,
  ref,
  type SerializableValue,
} from "@remix-run/component";

import { defaultDeadline } from "../lib/format.ts";
import { routes } from "../routes.ts";
import { sessionStore } from "../session.ts";
import { actionStyle, alertStyle, metaStyle, primaryStyle } from "../theme.ts";
import { color, font, radius } from "../tokens.ts";

export interface NewDocumentFormProps {
  [key: string]: SerializableValue;
}

export const NewDocumentForm = clientEntry(
  import.meta.url,
  function NewDocumentForm(handle: Handle<NewDocumentFormProps>) {
    const fields: {
      title?: HTMLInputElement;
      description?: HTMLTextAreaElement;
      closesAt?: HTMLInputElement;
      markdown?: HTMLTextAreaElement;
    } = {};
    let submitting = false;
    let error = "";

    if (typeof document !== "undefined") {
      sessionStore.addEventListener("change", () => handle.update(), {
        signal: handle.signal,
      });
      void sessionStore.load();
    }

    const onSubmit = async (event: Event) => {
      event.preventDefault();
      const closesAtLocal = fields.closesAt?.value ?? "";
      submitting = true;
      error = "";
      handle.update();
      try {
        const response = await sessionStore.apiFetch(
          routes.api.docs.create.href(),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: fields.title?.value ?? "",
              description: fields.description?.value ?? "",
              // `datetime-local` is the reader's local time; the API takes an instant.
              closesAt: closesAtLocal
                ? new Date(closesAtLocal).toISOString()
                : null,
              markdown: fields.markdown?.value ?? "",
            }),
          },
        );
        const body = await response.json() as { id?: string; error?: string };
        if (!response.ok || !body.id) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        globalThis.location.href = routes.document.href({ docId: body.id });
      } catch (e) {
        error = `登録できませんでした: ${(e as Error).message}`;
        submitting = false;
        handle.update();
      }
    };

    return () => {
      if (!sessionStore.ready) return <p mix={metaStyle}>確認しています…</p>;
      if (!sessionStore.userId) {
        return (
          <p>
            文書を登録するにはサインインしてください（ナビバー右上の「Sign
            In」）。
          </p>
        );
      }

      return (
        <form mix={[formStyle, on<HTMLFormElement>("submit", onSubmit)]}>
          <label mix={labelStyle}>
            タイトル
            <input
              type="text"
              required
              maxlength={200}
              mix={[
                inputStyle,
                ref((node) => (fields.title = node as HTMLInputElement)),
              ]}
            />
          </label>
          <label mix={labelStyle}>
            説明（任意）
            <textarea
              rows={3}
              maxlength={2000}
              mix={[
                inputStyle,
                ref((
                  node,
                ) => (fields.description = node as HTMLTextAreaElement)),
              ]}
            />
          </label>
          <label mix={labelStyle}>
            募集期日（既定は 1 か月後の 0:00。空にすると期限なし。過ぎると AI
            との対話と投稿を止めます）
            <input
              type="datetime-local"
              // Rendered only in the browser (the form waits for the session), so "now" is the
              // reader's, not the static build's.
              defaultValue={defaultDeadline()}
              mix={[
                inputStyle,
                ref((node) => (fields.closesAt = node as HTMLInputElement)),
              ]}
            />
          </label>
          <label mix={labelStyle}>
            本文（Markdown）
            <textarea
              rows={20}
              required
              mix={[
                inputStyle,
                markdownStyle,
                ref((node) => (fields.markdown = node as HTMLTextAreaElement)),
              ]}
            />
          </label>
          {error
            ? <div role="alert" data-kind="error" mix={alertStyle}>{error}</div>
            : null}
          <div>
            <button
              type="submit"
              disabled={submitting}
              mix={[actionStyle, primaryStyle]}
            >
              登録する
            </button>
          </div>
        </form>
      );
    };
  },
);

const formStyle = css({ display: "grid", gap: "1rem" });

const labelStyle = css({
  display: "grid",
  gap: "0.35rem",
  fontWeight: 600,
});

const inputStyle = css({
  font: "inherit",
  fontWeight: 400,
  padding: "0.45rem 0.6rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: color.bg,
  color: color.fg,
});

const markdownStyle = css({ fontFamily: font.mono, fontSize: "0.9rem" });
