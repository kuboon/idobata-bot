/**
 * DocumentView — the document page: the rendered document, with segments to select.
 *
 * The page is one static file for every document (`/d/_shell`, see `routes.document`), so the
 * document's ID comes from the URL and everything else from `GET /api/docs/:docId`. The Markdown is
 * rendered with `@kuboon/md` in one piece and cut back into the server's segments
 * (`lib/document.ts`); clicking a segment selects it, for the chat and the opinions that come next.
 */

import {
  clientEntry,
  createElement,
  css,
  type Handle,
  on,
  type RemixNode,
  type SerializableValue,
} from "@remix-run/component";
import {
  type CreateElement,
  hastToElement,
} from "@kuboon/md/hast_to_element.ts";

import { type Block, renderDocument, type Segment } from "../lib/document.ts";
import { deadlineLabel, formatDateTime } from "../lib/format.ts";
import { DOCUMENT_SHELL_ID, routes } from "../routes.ts";
import { sessionStore } from "../session.ts";
import { actionStyle, alertStyle, metaStyle, proseStyle } from "../theme.ts";
import { color, radius } from "../tokens.ts";

export interface DocumentViewProps {
  [key: string]: SerializableValue;
}

interface Detail {
  id: string;
  title: string;
  description: string;
  owner: { nickname: string };
  closesAt: string | null;
  open: boolean;
  opinionCount: number;
  version: { number: number; releasedAt: string | null };
  markdown: string;
  segments: Segment[];
}

/** The document ID in `/d/:docId`, or `null` on the shell's own URL. */
function docIdFromLocation(): string | null {
  const match = /^\/d\/([^/]+)\/?$/.exec(globalThis.location.pathname);
  const id = match ? decodeURIComponent(match[1]) : null;
  return id && id !== DOCUMENT_SHELL_ID ? id : null;
}

const element = createElement as unknown as CreateElement<RemixNode>;

export const DocumentView = clientEntry(
  import.meta.url,
  function DocumentView(handle: Handle<DocumentViewProps>) {
    let detail: Detail | null = null;
    let blocks: Block[] = [];
    let error = "";
    const selected = new Set<string>();

    const toggle = (key: string) => {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      handle.update();
    };

    if (typeof document !== "undefined") {
      void (async () => {
        const docId = docIdFromLocation();
        try {
          if (!docId) throw new Error("文書が指定されていません。");
          const response = await sessionStore.apiFetch(
            routes.api.docs.show.href({ docId }),
          );
          if (response.status === 404) {
            throw new Error("文書が見つかりません。");
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          detail = ((await response.json()) as { document: Detail }).document;
          blocks = await renderDocument(detail.markdown, detail.segments);
          document.title = `${detail.title} — idobata-bot`;
        } catch (e) {
          error = (e as Error).message;
        }
        handle.update();
      })();
    }

    return () => {
      if (error) {
        return (
          <div role="alert" data-kind="error" mix={alertStyle}>{error}</div>
        );
      }
      if (!detail) return <p mix={metaStyle}>読み込んでいます…</p>;

      return (
        <>
          <header mix={headerStyle}>
            <h1>{detail.title}</h1>
            {detail.description ? <p>{detail.description}</p> : null}
            <span mix={metaStyle}>
              {deadlineLabel(detail.closesAt, detail.open)} ・ 意見{" "}
              {detail.opinionCount} 件 ・ {detail.owner.nickname} ・ 第{" "}
              {detail.version.number} 版
              {detail.version.releasedAt
                ? `（${formatDateTime(detail.version.releasedAt)}）`
                : ""}
            </span>
          </header>

          <aside mix={selectionStyle}>
            {selected.size === 0
              ? <span>段落をクリックすると選択できます。</span>
              : (
                <>
                  <span>{selected.size} 件の段落を選択中</span>
                  <button
                    type="button"
                    mix={[
                      actionStyle,
                      on("click", () => {
                        selected.clear();
                        handle.update();
                      }),
                    ]}
                  >
                    選択を解除
                  </button>
                </>
              )}
          </aside>

          <article mix={proseStyle}>
            {blocks.map(({ segment, node }, i) => {
              const rendered = hastToElement(node, element) as RemixNode;
              if (!segment) return <div key={`n${i}`}>{rendered}</div>;
              const key = segment.key;
              return (
                <div
                  key={key}
                  data-segment={key}
                  data-selected={selected.has(key) ? "" : undefined}
                  mix={[segmentStyle, on("click", () => toggle(key))]}
                >
                  {rendered}
                </div>
              );
            })}
          </article>
        </>
      );
    };
  },
);

const headerStyle = css({
  marginBottom: "1.5rem",
  "& h1": { marginBottom: "0.5rem" },
});

const selectionStyle = css({
  position: "sticky",
  top: 0,
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
  marginBottom: "1rem",
  padding: "0.5rem 0.75rem",
  border: `1px solid ${color.border}`,
  borderRadius: radius.md,
  background: color.card,
  fontSize: "0.9rem",
});

const segmentStyle = css({
  marginInline: "-0.75rem",
  paddingInline: "0.75rem",
  borderInlineStart: "3px solid transparent",
  borderRadius: radius.sm,
  cursor: "pointer",
  "&:hover": { background: color.card },
  "&[data-selected]": {
    borderInlineStartColor: color.accent,
    background: color.card,
  },
});
