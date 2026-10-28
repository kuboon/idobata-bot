/**
 * ProfileCard — a `@remix-run/component` clientEntry for the `/my` page.
 *
 * Shows and changes the nickname this app shows on the user's opinions. It starts as the IdP's
 * nickname on first sign-in and is this app's own from then on (docs/design.md §5), so it is read
 * from and written to `/api/me`, never to the IdP.
 *
 * The field is uncontrolled (`defaultValue` + a `ref`): a `value` bound to state would fight the
 * runtime's own reflection and revert keystrokes.
 */

import {
  clientEntry,
  css,
  type Handle,
  on,
  ref,
  type SerializableValue,
} from "@remix-run/component";

import { routes } from "../routes.ts";
import { sessionStore } from "../session.ts";
import { actionStyle, alertStyle, cardStyle, primaryStyle } from "../theme.ts";
import { color, radius } from "../tokens.ts";

export interface ProfileCardProps {
  [key: string]: SerializableValue;
}

/** Matches the server's limit (`NICKNAME_MAX_LENGTH`). */
const NICKNAME_MAX_LENGTH = 40;

type Status = { message: string; kind: "success" | "error" } | null;

export const ProfileCard = clientEntry(
  import.meta.url,
  function ProfileCard(handle: Handle<ProfileCardProps>) {
    let nickname: string | null = null;
    let loadedFor: string | null = null;
    let saving = false;
    let status: Status = null;
    let input: HTMLInputElement | undefined;

    const load = async () => {
      const userId = sessionStore.userId;
      if (!userId || loadedFor === userId) return;
      loadedFor = userId;
      try {
        const response = await sessionStore.apiFetch(
          routes.api.me.show.href(),
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        nickname = ((await response.json()) as { nickname: string }).nickname;
      } catch (error) {
        status = {
          message: `表示名を読み込めませんでした: ${(error as Error).message}`,
          kind: "error",
        };
      }
      handle.update();
    };

    if (typeof document !== "undefined") {
      sessionStore.addEventListener("change", () => {
        if (!sessionStore.userId) {
          nickname = null;
          loadedFor = null;
        }
        handle.update();
        void load();
      }, { signal: handle.signal });
      void sessionStore.load().then(load);
    }

    const onSave = async () => {
      const next = input?.value.trim() ?? "";
      if (!next || next.length > NICKNAME_MAX_LENGTH) {
        status = {
          message: `表示名は 1〜${NICKNAME_MAX_LENGTH} 文字にしてください。`,
          kind: "error",
        };
        handle.update();
        return;
      }
      saving = true;
      status = null;
      handle.update();
      try {
        const response = await sessionStore.apiFetch(
          routes.api.me.update.href(),
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ nickname: next }),
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        nickname = ((await response.json()) as { nickname: string }).nickname;
        if (input) input.value = nickname;
        status = { message: "表示名を変更しました。", kind: "success" };
      } catch (error) {
        status = {
          message: `変更できませんでした: ${(error as Error).message}`,
          kind: "error",
        };
      } finally {
        saving = false;
        handle.update();
      }
    };

    return () => {
      if (!sessionStore.userId) return null;

      return (
        <section mix={cardStyle}>
          <h2>表示名</h2>
          <p>
            投稿した意見に表示される名前です。このサイトでだけ使われ、id.kbn.one
            の名前は変わりません。
          </p>
          {nickname === null ? <p>読み込んでいます…</p> : (
            <div mix={rowStyle}>
              <input
                type="text"
                aria-label="表示名"
                maxlength={NICKNAME_MAX_LENGTH}
                defaultValue={nickname}
                mix={[
                  inputStyle,
                  ref((node) => {
                    input = node as HTMLInputElement;
                  }),
                ]}
              />
              <button
                type="button"
                disabled={saving}
                mix={[actionStyle, primaryStyle, on("click", onSave)]}
              >
                変更する
              </button>
            </div>
          )}
          {status
            ? (
              <div role="alert" data-kind={status.kind} mix={alertStyle}>
                <span>{status.message}</span>
              </div>
            )
            : null}
        </section>
      );
    };
  },
);

const rowStyle = css({
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
  alignItems: "center",
});

const inputStyle = css({
  font: "inherit",
  flex: "1 1 14rem",
  padding: "0.4rem 0.6rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: color.bg,
  color: color.fg,
});
