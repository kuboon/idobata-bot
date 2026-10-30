/**
 * Markdown → segments: the unit a reader selects, an opinion targets, and the AI cites.
 *
 * A segment is one top-level Markdown block — a heading, a paragraph, a whole list, a table, a
 * code block, a block quote — kept as its own Markdown source, sliced out of the document exactly
 * as written (docs/architecture.md §3).
 *
 * The blocks are the top-level nodes of the same parser `@kuboon/md` renders with (remark-parse +
 * remark-gfm), so a segment is always one whole thing the reader sees as one thing. The viewer
 * renders the whole document with `@kuboon/md` and finds each segment's element by its source
 * offset (`client/lib/document.ts`); because both sides parse alike, the two line up.
 */

import type { RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { SegmentKind } from "../db/schema.ts";

/** One block of the document, before it has a row ID or a key. */
export interface ParsedSegment {
  kind: SegmentKind;
  /** The block's Markdown source, sliced out of the document. */
  text: string;
  /** The headings above it, outermost first, joined with ` > ` (`""` at the top). */
  headingPath: string;
  /** Where its first line starts in the (line-ending normalised) document. */
  lineStart: number;
}

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * What a top-level node becomes, or `null` for one that is not a segment.
 *
 * Thematic breaks and link reference definitions render as nothing anyone could have an opinion
 * about, raw HTML is dropped by `@kuboon/md`, and footnote definitions render together in a
 * footnotes section at the end rather than where they were written — so none of them are
 * segments.
 */
function kindOf(node: RootContent): SegmentKind | null {
  switch (node.type) {
    case "heading":
      return "heading";
    case "list":
      return "list";
    case "table":
      return "table";
    case "code":
      return "code";
    case "blockquote":
      return "quote";
    case "paragraph":
      return "paragraph";
    default:
      return null;
  }
}

/** A heading's plain text, without a trailing `{#custom-id}`. */
function headingText(node: RootContent): string {
  const text = (function collect(n: unknown): string {
    const value = (n as { value?: unknown }).value;
    if (typeof value === "string") return value;
    const children = (n as { children?: unknown[] }).children ?? [];
    return children.map(collect).join("");
  })(node);
  return text.replace(/\s*\{#[\w-]+\}\s*$/, "").trim();
}

/**
 * Splits a Markdown document into its top-level blocks.
 *
 * @param markdown The document
 * @returns The blocks, in document order
 */
export function parseSegments(markdown: string): ParsedSegment[] {
  const source = markdown.replace(/\r\n?/g, "\n");
  const tree = parser.parse(source);
  const headings: string[] = [];
  const segments: ParsedSegment[] = [];

  for (const node of tree.children) {
    const kind = kindOf(node);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (kind === null || start === undefined || end === undefined) continue;

    if (node.type === "heading") {
      // A heading's own path is the headings above it, not including itself.
      headings.length = Math.min(headings.length, node.depth - 1);
    }
    segments.push({
      kind,
      text: source.slice(start, end),
      headingPath: headings.filter(Boolean).join(" > "),
      lineStart: source.lastIndexOf("\n", start - 1) + 1,
    });
    if (node.type === "heading") {
      while (headings.length < node.depth - 1) headings.push("");
      headings.push(headingText(node));
    }
  }

  return segments;
}

/** A segment key the owner may write: what {@link newSegmentKey} makes, or their own. */
export const SEGMENT_KEY_PATTERN = /^[\w-]{1,40}$/;

/** A key marker on a line of its own: `<!-- #k7f2a9 -->`. */
const MARKER = /^<!--\s*#([\w-]{1,40})\s*-->$/;

/**
 * The document as the owner edits it: each segment preceded by a line with its key, as an HTML
 * comment — invisible to any Markdown renderer, and the same for every kind of block
 * (docs/architecture.md §3).
 *
 * @param markdown The document, without markers
 * @param keys Each segment's key, in order
 */
export function withKeyMarkers(markdown: string, keys: string[]): string {
  const source = markdown.replace(/\r\n?/g, "\n");
  let out = "";
  let at = 0;
  parseSegments(source).forEach((segment, i) => {
    const key = keys[i];
    if (key === undefined) return;
    out += source.slice(at, segment.lineStart) + `<!-- #${key} -->\n`;
    at = segment.lineStart;
  });
  return out + source.slice(at);
}

/**
 * Takes the key markers out of an edited document: the clean Markdown, which is what is stored and
 * rendered, and the key each of its segments was marked with — `null` for one without a marker,
 * which gets a new key. A marker belongs to the next segment after it; one followed by another
 * marker, or by nothing, is dropped.
 *
 * Only a marker that is a top-level block of its own counts. One in the middle of a paragraph's
 * lines would have split the paragraph, so a blank line is left in its place to keep the split.
 *
 * @throws Error if taking the markers out changes how the document splits into segments
 */
export function readKeyMarkers(
  markdown: string,
): { markdown: string; keys: (string | null)[] } {
  const source = markdown.replace(/\r\n?/g, "\n");
  const tree = parser.parse(source);
  const keys: (string | null)[] = [];
  const cuts: { from: number; to: number }[] = [];
  let pending: string | null = null;

  for (const node of tree.children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const marker = node.type === "html" ? MARKER.exec(node.value.trim()) : null;
    if (marker) {
      pending = marker[1];
      const from = source.lastIndexOf("\n", start - 1) + 1;
      cuts.push({ from, to: source[end] === "\n" ? end + 1 : end });
    } else if (kindOf(node) !== null) {
      keys.push(pending);
      pending = null;
    }
  }

  let clean = "";
  let at = 0;
  for (const cut of cuts) {
    clean += source.slice(at, cut.from);
    // Right after a line of text, taking the marker's line out would join that line to the next.
    if (clean !== "" && !clean.endsWith("\n\n")) clean += "\n";
    at = cut.to;
  }
  clean += source.slice(at);

  if (parseSegments(clean).length !== keys.length) {
    throw new Error("removing the ID lines changed the document's blocks");
  }
  return { markdown: clean, keys };
}

/**
 * A key for a new segment: short, unique within its version, and kept by the same block in later
 * versions once versions are matched up (docs/architecture.md §3).
 */
export function newSegmentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("")
    .slice(0, 10);
}
