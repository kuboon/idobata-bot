/**
 * DocumentAdmin — a document's page for its owner (`/d/:docId/admin`).
 *
 * Two tabs, on a wide page (`wide` in the layout), the first shown unless the URL says `#text`:
 *
 * - 設定と意見: title, description and deadline (`PATCH /api/docs/:docId`), and what the chat's
 *   pre-filter turned away, counted per kind over the last 30 days. Opinions are moderated on the
 *   document page itself, in its 管理 mode (`opinions/panel.tsx`).
 * - 本文: the next version as a draft, with each block's ID as a marker line, saved and then
 *   released (`/api/docs/:docId/draft`), beside a live preview. A block that keeps its ID keeps
 *   its opinions.
 *
 * Like the document page, the build writes it once (`/d/_shell/admin`) and the Worker serves that
 * for every document; the ID comes from the URL and everything else from the API.
 */

import {
  clientEntry,
  createElement,
  css,
  type Handle,
  on,
  ref,
  type RemixNode,
  type SerializableValue,
} from "@remix-run/component";
import { markdownToHast } from "@kuboon/md";
import {
  type CreateElement,
  hastToElement,
} from "@kuboon/md/hast_to_element.ts";
import type { Root } from "hast";
import { OpinionApiError, type OwnerView } from "@kuboon/idobata-bot";

import { localInputValue } from "../lib/format.ts";
import { opinionClient } from "../opinions/store.ts";
import { DOCUMENT_SHELL_ID, routes } from "../routes.ts";
import { sessionStore } from "../session.ts";
import {
  actionStyle,
  alertStyle,
  cardStyle,
  dangerStyle,
  metaStyle,
  primaryStyle,
  proseStyle,
} from "../theme.ts";
import { color, radius } from "../tokens.ts";

const element = createElement as unknown as CreateElement<RemixNode>;

type Tab = "text" | "manage";
const TABS: [Tab, string][] = [["manage", "設定と意見"], ["text", "本文"]];

export interface DocumentAdminProps {
  [key: string]: SerializableValue;
}

/** The next version as the owner edits it (`GET /api/docs/:docId/draft`). */
interface Draft {
  number: number;
  markdown: string;
  saved: boolean;
  released: number;
}

interface Detail {
  id: string;
  title: string;
  description: string;
  owner: { id: string };
  closesAt: string | null;
}

/** The pre-filter's kinds, as the owner reads them. */
const FILTER_KIND_LABELS: Record<string, string> = {
  off_topic: "文書と関係ない話題",
  injection: "AI を操作しようとする発言",
  meta: "使い方の質問",
  about_document: "文書について（確信が低く弾いたもの）",
};

/** The document ID in `/d/:docId/admin`, or `null` on the shell's own URL. */
function docIdFromLocation(): string | null {
  const match = /^\/d\/([^/]+)\/admin\/?$/.exec(globalThis.location.pathname);
  const id = match ? decodeURIComponent(match[1]) : null;
  return id && id !== DOCUMENT_SHELL_ID ? id : null;
}

export const DocumentAdmin = clientEntry(
  import.meta.url,
  function DocumentAdmin(handle: Handle<DocumentAdminProps>) {
    const docId = typeof document === "undefined" ? null : docIdFromLocation();
    let detail: Detail | null = null;
    let view: OwnerView | null = null;
    let error = "";
    let notice: { kind: "success" | "error"; text: string } | null = null;
    let saving = false;
    let loadedFor: string | null = null;
    let draft: Draft | null = null;
    /** Bumped when the draft comes back from the server, so the editor shows its text. */
    let draftGeneration = 0;
    /** The editor's text as the preview shows it; rendered a moment after typing stops. */
    let preview: Root | null = null;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previewRun = 0;
    let tab: Tab = typeof location !== "undefined" &&
        location.hash === "#text"
      ? "text"
      : "manage";
    let editor: HTMLTextAreaElement | null = null;
    let releaseNote: HTMLInputElement | null = null;
    const fields: {
      title?: HTMLInputElement;
      description?: HTMLTextAreaElement;
      closesAt?: HTMLInputElement;
    } = {};

    const load = async () => {
      const userId = sessionStore.userId;
      if (!docId || !userId || loadedFor === userId) {
        handle.update();
        return;
      }
      loadedFor = userId;
      try {
        const response = await sessionStore.apiFetch(
          routes.api.docs.show.href({ docId }),
        );
        if (response.status === 404) throw new Error("文書が見つかりません。");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        detail = ((await response.json()) as { document: Detail }).document;
        view = await opinionClient.manage(docId);
        draft = await draftRequest("GET");
        draftGeneration++;
        error = "";
      } catch (e) {
        error = e instanceof OpinionApiError && e.status === 403
          ? "この文書のオーナーではありません。"
          : (e as Error).message;
      }
      handle.update();
    };

    if (typeof document !== "undefined") {
      sessionStore.addEventListener("change", () => void load(), {
        signal: handle.signal,
      });
      void sessionStore.load().then(load);
    }

    const save = async (event: Event) => {
      event.preventDefault();
      if (!docId) return;
      saving = true;
      notice = null;
      handle.update();
      try {
        const closesAt = fields.closesAt?.value ?? "";
        const response = await sessionStore.apiFetch(
          routes.api.docs.update.href({ docId }),
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              title: fields.title?.value ?? "",
              description: fields.description?.value ?? "",
              // `datetime-local` is local time; the API takes an instant. Empty: no deadline.
              closesAt: closesAt ? new Date(closesAt).toISOString() : null,
            }),
          },
        );
        const body = await response.json().catch(() => ({})) as {
          document?: Detail;
          error?: string;
        };
        if (!response.ok || !body.document) {
          throw new Error(body.error ?? `HTTP ${response.status}`);
        }
        detail = body.document;
        notice = { kind: "success", text: "保存しました。" };
      } catch (e) {
        notice = {
          kind: "error",
          text: `保存できませんでした: ${(e as Error).message}`,
        };
      } finally {
        saving = false;
        handle.update();
      }
    };

    /** One call to the draft API; its `draft`, or `null` for one that answers with none. */
    const draftRequest = async (
      method: "GET" | "PUT" | "DELETE",
      body?: unknown,
    ): Promise<Draft | null> => {
      const response = await sessionStore.apiFetch(
        routes.api.docs.draft.href({ docId: docId! }),
        body === undefined ? { method } : {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (response.status === 204) return null;
      const json = await response.json().catch(() => ({})) as {
        draft?: Draft;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(json.error ?? `HTTP ${response.status}`);
      }
      return json.draft ?? null;
    };

    /** Runs a step on the draft, reporting how it went. */
    const draftStep = async (step: () => Promise<string>) => {
      saving = true;
      notice = null;
      handle.update();
      try {
        notice = { kind: "success", text: await step() };
      } catch (e) {
        notice = {
          kind: "error",
          text: `できませんでした: ${(e as Error).message}`,
        };
      } finally {
        saving = false;
        handle.update();
      }
    };

    const saveDraft = () =>
      draftRequest("PUT", { markdown: editor?.value ?? "" }).then((d) => {
        draft = d;
        draftGeneration++;
      });

    const onSaveDraft = () =>
      draftStep(async () => {
        await saveDraft();
        return `第 ${draft?.number} 版の下書きを保存しました。ID の無かった段落には ID を付けました。`;
      });

    const onRelease = () => {
      if (
        !globalThis.confirm(
          `第 ${draft?.number} 版としてリリースします。読者にはこの版が表示されます。よろしいですか？`,
        )
      ) return;
      void draftStep(async () => {
        await saveDraft();
        const response = await sessionStore.apiFetch(
          routes.api.docs.release.href({ docId: docId! }),
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ releaseNote: releaseNote?.value ?? "" }),
          },
        );
        const json = await response.json().catch(() => ({})) as {
          document?: Detail;
          error?: string;
        };
        if (!response.ok || !json.document) {
          throw new Error(json.error ?? `HTTP ${response.status}`);
        }
        detail = json.document;
        const number = draft?.number;
        draft = await draftRequest("GET");
        draftGeneration++;
        return `第 ${number} 版をリリースしました。`;
      });
    };

    const onDiscard = () => {
      if (!globalThis.confirm("下書きを破棄します。よろしいですか？")) return;
      void draftStep(async () => {
        await draftRequest("DELETE");
        draft = await draftRequest("GET");
        draftGeneration++;
        return "下書きを破棄しました。";
      });
    };

    const renderPreview = async () => {
      const run = ++previewRun;
      const tree = await markdownToHast(editor?.value ?? "");
      // A later keystroke started a newer render: that one is shown instead.
      if (run !== previewRun) return;
      preview = tree;
      handle.update();
    };
    const schedulePreview = (delay = 200) => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => void renderPreview(), delay);
    };

    const switchTab = (next: Tab) => {
      tab = next;
      history.replaceState(null, "", next === "text" ? "#text" : "#");
      handle.update();
    };

    const tabBar = () => (
      <div role="tablist" aria-label="管理の項目" mix={tabListStyle}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id ? "true" : "false"}
            mix={[
              tabStyle,
              on("click", () => switchTab(id)),
            ]}
          >
            {label}
          </button>
        ))}
      </div>
    );

    const draftSection = (d: Draft) => (
      <section mix={cardStyle}>
        <p mix={metaStyle}>
          {d.saved
            ? `第 ${d.number} 版の下書き（未公開）。読者には第 ${d.released} 版が表示されています。`
            : `第 ${d.released} 版が公開中です。書き換えて保存すると、第 ${d.number} 版の下書きになります。`}
        </p>
        <p mix={metaStyle}>
          各段落の前の行の <code>{"<!-- #… -->"}</code>{" "}
          はその段落の ID です。ID
          を残した段落の意見は、新しい版でもその段落に付いたままです。段落を動かすときは
          ID の行ごと動かしてください。保存すると、ID の無い段落に新しい ID
          が付きます。
        </p>
        <div mix={splitStyle}>
          <textarea
            key={`d${draftGeneration}`}
            aria-label="本文（Markdown）"
            spellcheck={false}
            defaultValue={d.markdown}
            mix={[
              inputStyle,
              editorStyle,
              ref((node) => {
                editor = node as HTMLTextAreaElement;
                schedulePreview(0);
              }),
              on("input", () => schedulePreview()),
            ]}
          />
          <article aria-label="プレビュー" mix={[proseStyle, previewStyle]}>
            {preview
              ? preview.children.map((node, i) => (
                <div key={i}>{hastToElement(node, element) as RemixNode}</div>
              ))
              : <p mix={metaStyle}>プレビューを描いています…</p>}
          </article>
        </div>
        <label mix={labelStyle}>
          この版の説明（任意。リリース時に記録されます）
          <input
            type="text"
            maxlength={2000}
            mix={[
              inputStyle,
              ref((node) => (releaseNote = node as HTMLInputElement)),
            ]}
          />
        </label>
        <div mix={buttonsStyle}>
          <button
            type="button"
            disabled={saving}
            mix={[actionStyle, on("click", () => void onSaveDraft())]}
          >
            下書きを保存
          </button>
          <button
            type="button"
            disabled={saving}
            mix={[actionStyle, primaryStyle, on("click", onRelease)]}
          >
            保存してリリース
          </button>
          {d.saved
            ? (
              <button
                type="button"
                disabled={saving}
                mix={[actionStyle, dangerStyle, on("click", onDiscard)]}
              >
                下書きを破棄
              </button>
            )
            : null}
        </div>
      </section>
    );

    return () => {
      if (typeof document === "undefined" || !sessionStore.ready) {
        return <p mix={metaStyle}>読み込んでいます…</p>;
      }
      if (!docId) {
        return (
          <div role="alert" data-kind="error" mix={alertStyle}>
            文書が指定されていません。
          </div>
        );
      }
      if (!sessionStore.userId) {
        return (
          <p>
            管理するには、ナビバー右上の「Sign In」からサインインしてください。
          </p>
        );
      }
      if (error) {
        return (
          <div role="alert" data-kind="error" mix={alertStyle}>{error}</div>
        );
      }
      if (!detail || !view) return <p mix={metaStyle}>読み込んでいます…</p>;

      const filterTotals = new Map<string, number>();
      for (const s of view.filterStats) {
        filterTotals.set(s.kind, (filterTotals.get(s.kind) ?? 0) + s.count);
      }

      return (
        <>
          <p>
            <a href={routes.document.href({ docId })}>← 文書のページへ</a>
          </p>
          <h1>文書の管理</h1>

          {notice
            ? (
              <div role="alert" data-kind={notice.kind} mix={alertStyle}>
                {notice.text}
              </div>
            )
            : null}

          {tabBar()}

          <div role="tabpanel" hidden={tab !== "text"}>
            {draft ? draftSection(draft) : null}
          </div>

          <div role="tabpanel" hidden={tab !== "manage"}>
            <section mix={cardStyle}>
              <h2>文書</h2>
              <form mix={[formStyle, on<HTMLFormElement>("submit", save)]}>
                <label mix={labelStyle}>
                  タイトル
                  <input
                    type="text"
                    required
                    maxlength={200}
                    defaultValue={detail.title}
                    mix={[
                      inputStyle,
                      ref((node) => (fields.title = node as HTMLInputElement)),
                    ]}
                  />
                </label>
                <label mix={labelStyle}>
                  説明
                  <textarea
                    rows={3}
                    defaultValue={detail.description}
                    mix={[
                      inputStyle,
                      ref((
                        node,
                      ) => (fields.description = node as HTMLTextAreaElement)),
                    ]}
                  />
                </label>
                <label mix={labelStyle}>
                  募集期日（空にすると期限なし。過去の日時にすると今すぐ終了）
                  <input
                    type="datetime-local"
                    defaultValue={detail.closesAt
                      ? localInputValue(new Date(detail.closesAt))
                      : ""}
                    mix={[
                      inputStyle,
                      ref((
                        node,
                      ) => (fields.closesAt = node as HTMLInputElement)),
                    ]}
                  />
                </label>
                <div>
                  <button
                    type="submit"
                    disabled={saving}
                    mix={[actionStyle, primaryStyle]}
                  >
                    保存する
                  </button>
                </div>
              </form>
            </section>

            <section mix={cardStyle}>
              <h2>意見</h2>
              <p>
                意見の非表示・再表示は、
                <a href={routes.document.href({ docId })}>文書のページ</a>
                で「管理」をオンにして行います（オーナーにだけ表示されます）。
              </p>
            </section>

            <section mix={cardStyle}>
              <h2>AI が弾いた発言（直近 30 日）</h2>
              <p mix={metaStyle}>
                文書と関係ない発言は、AI
                に届く前に弾いています。件数だけを数え、発言は残していません。
              </p>
              {filterTotals.size === 0
                ? <p>ありません。</p>
                : (
                  <ul mix={statsStyle}>
                    {[...filterTotals].map(([kind, count]) => (
                      <li key={kind}>
                        {FILTER_KIND_LABELS[kind] ?? kind}: {count} 件
                      </li>
                    ))}
                  </ul>
                )}
            </section>
          </div>
        </>
      );
    };
  },
);

const formStyle = css({ display: "grid", gap: "0.75rem" });

const tabListStyle = css({
  display: "flex",
  gap: "0.25rem",
  borderBottom: `1px solid ${color.border}`,
  marginBottom: "1rem",
});

const tabStyle = css({
  font: "inherit",
  fontWeight: 600,
  padding: "0.5rem 1rem",
  border: "none",
  borderBottom: "2px solid transparent",
  marginBottom: "-1px",
  background: "none",
  color: color.muted,
  cursor: "pointer",
  '&[aria-selected="true"]': {
    color: color.fg,
    borderBottomColor: color.accent,
  },
});

/** Editor and preview side by side; stacked on a narrow screen. */
const splitStyle = css({
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: "1rem",
  "@media (min-width: 56rem)": { gridTemplateColumns: "1fr 1fr" },
});

const previewStyle = css({
  minWidth: 0,
  maxHeight: "75vh",
  overflowY: "auto",
  padding: "0.25rem 1rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
});

const editorStyle = css({
  width: "100%",
  boxSizing: "border-box",
  minHeight: "75vh",
  resize: "vertical",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.9rem",
  lineHeight: 1.5,
});

const buttonsStyle = css({ display: "flex", flexWrap: "wrap", gap: "0.5rem" });

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

const statsStyle = css({ margin: 0, paddingLeft: "1.1rem" });
