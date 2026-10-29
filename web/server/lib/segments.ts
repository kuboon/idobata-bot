/**
 * Markdown → segments: the unit a reader selects, an opinion targets, and the AI cites.
 *
 * A segment is one top-level Markdown block — a heading, a paragraph, a whole list, a table, a
 * code block, a block quote — kept as its own Markdown source, sliced out of the document exactly
 * as written (docs/design.md §4).
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
    });
    if (node.type === "heading") {
      while (headings.length < node.depth - 1) headings.push("");
      headings.push(headingText(node));
    }
  }

  return segments;
}

/**
 * A key for a new segment: short, unique within its version, and kept by the same block in later
 * versions once versions are matched up (docs/design.md §4).
 */
export function newSegmentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("")
    .slice(0, 10);
}
