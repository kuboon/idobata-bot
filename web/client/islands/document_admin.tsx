/**
 * DocumentAdmin — a document's page for its owner (`/d/:docId/admin`).
 *
 * - The document: title, description and deadline (`PATCH /api/docs/:docId`).
 * - Its opinions, hidden ones too, each with its moderation record, and the way to hide one or
 *   show it again — always with a reason, which is public (docs/design.md §5).
 * - What the chat's pre-filter turned away, counted per kind over the last 30 days.
 *
 * Like the document page, the build writes it once (`/d/_shell/admin`) and the Worker serves that
 * for every document; the ID comes from the URL and everything else from the API.
 */

import {
  clientEntry,
  css,
  type Handle,
  on,
  ref,
  type SerializableValue,
} from "@remix-run/component";
import {
  type Opinion,
  OpinionApiError,
  type OwnerView,
  STANCE_LABELS,
  type Target,
} from "@kuboon/idobata-bot";

import { formatDateTime, localInputValue } from "../lib/format.ts";
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
} from "../theme.ts";
import { color, radius } from "../tokens.ts";

export interface DocumentAdminProps {
  [key: string]: SerializableValue;
}

interface Detail {
  id: string;
  title: string;
  description: string;
  owner: { id: string };
  closesAt: string | null;
  segments: { key: string; text: string }[];
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

/** A segment's short name: the start of its text, without Markdown marks. */
function segmentLabel(text: string): string {
  const plain = text.replace(/^#{1,6}\s+/, "").replace(/[*_`>|\[\]#]/g, "")
    .replace(/\s+/g, " ").trim();
  return plain.length > 24 ? `${plain.slice(0, 24)}…` : plain;
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

    const moderate = async (opinion: Opinion) => {
      if (!docId) return;
      const hide = opinion.status !== "hidden";
      const reason = globalThis.prompt(
        hide
          ? `「${opinion.title}」を非表示にする理由（公開されます）`
          : `「${opinion.title}」を再表示する理由（公開されます）`,
      )?.trim();
      if (!reason) return;
      try {
        await opinionClient.moderate(opinion.id, {
          action: hide ? "hide" : "unhide",
          reason,
        });
        view = await opinionClient.manage(docId);
        notice = null;
      } catch (e) {
        notice = {
          kind: "error",
          text: `変更できませんでした: ${(e as Error).message}`,
        };
      }
      handle.update();
    };

    const targetLabel = (t: Target): string => {
      const stance = STANCE_LABELS[t.stance];
      if (t.kind === "document") return `文書全体への${stance}`;
      if (t.kind === "opinion") {
        const title = view?.opinions.find((o) => o.id === t.opinionId)?.title;
        return `意見「${title ?? "…"}」への${stance}`;
      }
      const segment = detail?.segments.find((s) => s.key === t.segmentKey);
      return `「${
        segment ? segmentLabel(segment.text) : "段落"
      }」への${stance}`;
    };

    const opinionItem = (opinion: Opinion) => {
      const log = (view?.moderation ?? []).filter((l) =>
        l.opinionId === opinion.id
      );
      return (
        <li key={opinion.id} data-status={opinion.status} mix={opinionStyle}>
          <div mix={opinionHeadStyle}>
            <strong>{opinion.title}</strong>
            {opinion.status === "hidden"
              ? <span mix={badgeStyle}>非表示</span>
              : null}
          </div>
          <span mix={metaStyle}>
            {opinion.targets.map(targetLabel).join("、")}
          </span>
          {opinion.body ? <p mix={preWrapStyle}>{opinion.body}</p> : null}
          <span mix={metaStyle}>
            {opinion.author.nickname} ・ {formatDateTime(opinion.createdAt)}
            {" "}
            ・ 賛同 {opinion.supportCount}
          </span>
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
          <div>
            <button
              type="button"
              mix={[
                actionStyle,
                opinion.status === "hidden" ? undefined : dangerStyle,
                on("click", () =>
                  void moderate(opinion)),
              ]}
            >
              {opinion.status === "hidden" ? "再表示する" : "非表示にする"}
            </button>
          </div>
        </li>
      );
    };

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

      const hiddenCount = view.opinions.filter((o) => o.status === "hidden")
        .length;
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
                    ref((node) => (fields.closesAt = node as HTMLInputElement)),
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
            <h2>
              意見（{view.opinions.length} 件
              {hiddenCount ? `・うち非表示 ${hiddenCount} 件` : ""}）
            </h2>
            <p mix={metaStyle}>
              非表示にした意見は読者に見えなくなりますが、件数と理由は公開されます。
            </p>
            {view.opinions.length === 0
              ? <p>まだ意見はありません。</p>
              : <ul mix={listStyle}>{view.opinions.map(opinionItem)}</ul>}
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
        </>
      );
    };
  },
);

const formStyle = css({ display: "grid", gap: "0.75rem" });

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

const preWrapStyle = css({ whiteSpace: "pre-wrap" });

const listStyle = css({ listStyle: "none", padding: 0, margin: 0 });

const opinionStyle = css({
  display: "grid",
  gap: "0.35rem",
  paddingBlock: "0.75rem",
  borderTop: `1px solid ${color.border}`,
  "& > p": { margin: 0 },
  '&[data-status="hidden"]': { opacity: 0.7 },
});

const opinionHeadStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
});

const badgeStyle = css({
  padding: "0.05rem 0.5rem",
  borderRadius: "999px",
  border: `1px solid ${color.border}`,
  color: color.muted,
  fontSize: "0.75rem",
});

const logStyle = css({
  margin: 0,
  paddingLeft: "1.1rem",
  color: color.muted,
  fontSize: "0.85rem",
});

const statsStyle = css({ margin: 0, paddingLeft: "1.1rem" });
