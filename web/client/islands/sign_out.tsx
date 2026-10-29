/**
 * SignOut — the end of the `/my` page: a sign-out button while signed in, and a pointer to the
 * navbar's 「Sign In」 while not. Signing in starts from the navbar (NavAuth).
 *
 * Until the session check settles it says so, which is also what the browser smoke test waits to
 * see go away — the sign that the island hydrated and ran.
 */

import {
  clientEntry,
  type Handle,
  on,
  type SerializableValue,
} from "@remix-run/component";

import { sessionStore } from "../session.ts";
import { actionStyle, alertStyle, metaStyle } from "../theme.ts";

export interface SignOutProps {
  [key: string]: SerializableValue;
}

export const SignOut = clientEntry(
  import.meta.url,
  function SignOut(handle: Handle<SignOutProps>) {
    let busy = false;
    let error = "";

    if (typeof document !== "undefined") {
      sessionStore.addEventListener("change", () => handle.update(), {
        signal: handle.signal,
      });
      void sessionStore.load();
    }

    const signOut = async () => {
      busy = true;
      error = "";
      handle.update();
      try {
        await sessionStore.signOut();
      } catch (e) {
        error = `サインアウトに失敗しました: ${(e as Error).message}`;
      } finally {
        busy = false;
        handle.update();
      }
    };

    return () => {
      if (!sessionStore.ready) {
        return <p mix={metaStyle}>セッションを確認しています…</p>;
      }
      if (sessionStore.userId === null) {
        return (
          <p>
            ナビバー右上の「Sign
            In」からサインインすると、自分の文書や意見がここに出ます。
          </p>
        );
      }
      return (
        <div>
          {error
            ? <div role="alert" data-kind="error" mix={alertStyle}>{error}</div>
            : null}
          <button
            type="button"
            disabled={busy}
            mix={[actionStyle, on("click", signOut)]}
          >
            サインアウト
          </button>
        </div>
      );
    };
  },
);
