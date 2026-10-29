/**
 * DocumentView — the document page: the rendered document, with segments to select.
 *
 * The page is one static file for every document (`/d/_shell`, see `routes.document`), so the
 * document's ID comes from the URL and everything else from `GET /api/docs/:docId`. The Markdown is
 * rendered with `@kuboon/md` in one piece and cut back into the server's segments
 * (`lib/document.ts`); clicking a segment selects it. A segment with opinions about it is
 * underlined and shows how many, and the opinion panel (`opinions/panel.tsx`) opens right after the
 * last selected segment — or, with nothing selected, after the document — with those opinions and
 * the buttons to talk with the AI or write one. The AI chat (`opinions/assistant.ts`) is one per
 * page, opened from the button always in the corner, and reads and sets the selection. Both end in
 * the posting dialog (`opinions/post_dialog.tsx`), which there is one of for the page.
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
import type { HelperAgentPanel } from "@remix-kbn/helper-agent/client";
import { openAssistant, type PageSelection } from "../opinions/assistant.ts";
import { ComposeStore } from "../opinions/compose.ts";
import { OpinionPanel } from "../opinions/panel.tsx";
import { PostDialog } from "../opinions/post_dialog.tsx";
import { OpinionStore } from "../opinions/store.ts";
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

/** A segment's short name for the panel: a heading's text, or the start of the block. */
function segmentLabel(segment: Segment): string {
  const plain = segment.text
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*_`>|\[\]#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > 24 ? `${plain.slice(0, 24)}…` : plain;
}

export const DocumentView = clientEntry(
  import.meta.url,
  function DocumentView(handle: Handle<DocumentViewProps>) {
    let detail: Detail | null = null;
    let blocks: Block[] = [];
    let error = "";
    let store: OpinionStore | null = null;
    let segmentLabels = new Map<string, string>();
    const selected = new Set<string>();
    const compose = new ComposeStore();
    /** The chat in the corner — one per page, made on first use. */
    let assistant: HelperAgentPanel | null = null;

    /** The selection by block number, for the AI's tools. */
    const pageSelection: PageSelection = {
      current: () =>
        (detail?.segments ?? []).flatMap((s, index) =>
          selected.has(s.key) ? [{ index, text: s.text }] : []
        ),
      select(indices) {
        const segments = detail?.segments ?? [];
        const picked = [...new Set(indices)].sort((a, b) => a - b).map((i) => {
          const segment = segments[i];
          if (!segment) throw new Error(`文書ブロック ${i} はありません。`);
          return { index: i, segment };
        });
        selected.clear();
        for (const { segment } of picked) selected.add(segment.key);
        handle.update();
        setTimeout(() =>
          document
            .querySelector(`[data-segment="${picked[0].segment.key}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" })
        );
        return picked.map(({ index, segment }) => ({
          index,
          text: segment.text,
          opinions: store?.aboutSegment(segment.key).length ?? 0,
        }));
      },
    };

    /** Shows the chat, opening it the first time. */
    const talk = () => {
      if (!detail) return;
      if (assistant) assistant.show();
      else {
        assistant = openAssistant({
          documentId: detail.id,
          versionNumber: detail.version.number,
          compose,
          selection: pageSelection,
        });
        // The launcher comes back when the panel is closed.
        assistant.dialog.addEventListener("close", () => handle.update());
      }
      handle.update();
    };
    handle.signal.addEventListener("abort", () => assistant?.dispose());

    /**
     * A click selects that paragraph alone; Ctrl/⌘/Shift-click adds it to (or takes it out of)
     * the selection. Clicking the only selected paragraph again clears the selection.
     */
    const select = (key: string, event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
      } else if (selected.size === 1 && selected.has(key)) {
        selected.clear();
      } else {
        selected.clear();
        selected.add(key);
      }
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
          segmentLabels = new Map(
            detail.segments.map((s) => [s.key, segmentLabel(s)]),
          );
          document.title = `${detail.title} — idobata-bot`;
          store = new OpinionStore(detail.id);
          store.addEventListener("change", () => handle.update(), {
            signal: handle.signal,
          });
          // Signing in or out changes which opinions are yours and which you support.
          sessionStore.addEventListener("change", () => void store?.load(), {
            signal: handle.signal,
          });
          void store.load();
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

      // The selection in document order: the panel goes after the last selected segment.
      const selection = detail.segments.filter((s) => selected.has(s.key));
      const lastSelected = selection.at(-1)?.key ?? null;
      const panel = store
        ? (
          <OpinionPanel
            store={store}
            selected={selection.map((s) => ({
              key: s.key,
              label: segmentLabels.get(s.key) ?? "",
            }))}
            segmentLabels={segmentLabels}
            open={detail.open}
            compose={compose}
            onTalk={talk}
          />
        )
        : null;

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
              ? (
                <span>
                  段落をクリックすると選択できます（Ctrl / ⌘ / Shift
                  を押しながらで複数）。
                </span>
              )
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
            {blocks.flatMap(({ segment, node }, i) => {
              const rendered = hastToElement(node, element) as RemixNode;
              if (!segment) return [<div key={`n${i}`}>{rendered}</div>];
              const key = segment.key;
              const count = store?.aboutSegment(key).length ?? 0;
              const block = (
                <div
                  key={key}
                  data-segment={key}
                  data-selected={selected.has(key) ? "" : undefined}
                  data-opinions={count ? "" : undefined}
                  title={count ? `意見 ${count} 件。クリックで表示` : undefined}
                  mix={[
                    segmentStyle,
                    on("click", (event) => select(key, event)),
                  ]}
                >
                  {count ? <span mix={countStyle}>意見 {count}</span> : null}
                  {rendered}
                </div>
              );
              return key === lastSelected && panel
                ? [block, <div key="opinion-panel">{panel}</div>]
                : [block];
            })}
          </article>
          {lastSelected === null ? panel : null}
          {detail.open && !assistant?.open
            ? (
              <button
                type="button"
                aria-label="AI と対話する"
                mix={[launcherStyle, on("click", talk)]}
              >
                <span aria-hidden="true">💬</span> AI と対話
              </button>
            )
            : null}
          {store
            ? (
              <PostDialog
                compose={compose}
                store={store}
                segmentLabels={segmentLabels}
              />
            )
            : null}
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

const launcherStyle = css({
  position: "fixed",
  insetInlineEnd: "1rem",
  insetBlockEnd: "1rem",
  zIndex: 10,
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  padding: "0.7rem 1.1rem",
  border: "none",
  borderRadius: "999px",
  background: color.accent,
  color: color.onAccent,
  font: "inherit",
  fontWeight: 600,
  boxShadow: "0 0.5rem 1.5rem rgb(0 0 0 / 0.2)",
  cursor: "pointer",
});

const countStyle = css({
  float: "right",
  marginInlineStart: "0.5rem",
  marginTop: "0.35rem",
  padding: "0.05rem 0.5rem",
  borderRadius: "999px",
  background: color.card,
  border: `1px solid ${color.border}`,
  color: color.muted,
  fontSize: "0.75rem",
  fontWeight: 400,
});

const segmentStyle = css({
  marginInline: "-0.75rem",
  paddingInline: "0.75rem",
  borderInlineStart: "3px solid transparent",
  borderRadius: radius.sm,
  cursor: "pointer",
  "&:hover": { background: color.card },
  // Paragraphs with opinions are underlined before anything is selected.
  "&[data-opinions]": {
    textDecorationLine: "underline",
    textDecorationStyle: "dotted",
    textDecorationColor: color.accent,
    textDecorationThickness: "2px",
    textUnderlineOffset: "0.3em",
  },
  "&[data-selected]": {
    borderInlineStartColor: color.accent,
    background: color.card,
  },
});
