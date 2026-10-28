/**
 * Markdown → segments: the unit a reader selects, an opinion targets, and the AI cites.
 *
 * A segment is one top-level Markdown block — a heading, a paragraph, a whole list, a table, a
 * code block, a block quote — kept as its own Markdown source, so the browser renders it and the
 * AI reads it exactly as written (docs/design.md §4). Splitting is deterministic and needs no
 * parser: blocks are told apart by their first line, the way CommonMark does at the top level.
 *
 * What this does not try to be is a full CommonMark block parser. Setext headings, HTML blocks and
 * link reference definitions come out as paragraphs, which is what they look like to a reader
 * selecting text anyway.
 */

import type { SegmentKind } from "../db/schema.ts";

/** One block of the document, before it has a row ID or a key. */
export interface ParsedSegment {
  kind: SegmentKind;
  /** The block's Markdown source, trimmed of surrounding blank lines. */
  text: string;
  /** The headings above it, outermost first, joined with ` > ` (`""` at the top). */
  headingPath: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t#]*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTE = /^ {0,3}>/;
const TABLE_ROW = /^ {0,3}\|/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BLANK = /^[ \t]*$/;
const INDENTED = /^(?: {2,}|\t)/;

/**
 * Splits a Markdown document into its top-level blocks.
 *
 * Thematic breaks (`---`) separate blocks and are not segments themselves: there is nothing in
 * one to have an opinion about.
 *
 * @param markdown The document
 * @returns The blocks, in document order
 */
export function parseSegments(markdown: string): ParsedSegment[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const segments: ParsedSegment[] = [];
  const headings: string[] = [];
  let i = 0;

  const push = (kind: SegmentKind, block: string[]) => {
    const text = block.join("\n").replace(/^\n+|\s+$/g, "");
    if (text) {
      segments.push({
        kind,
        text,
        headingPath: headings.filter(Boolean).join(" > "),
      });
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (BLANK.test(line) || THEMATIC_BREAK.test(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const block = [line];
      i++;
      while (i < lines.length) {
        block.push(lines[i]);
        const closing = FENCE.exec(lines[i]);
        i++;
        if (
          closing && closing[1][0] === marker[0] &&
          closing[1].length >= marker.length &&
          lines[i - 1].trim() === closing[1]
        ) break;
      }
      push("code", block);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const depth = heading[1].length;
      const title = (heading[2] ?? "").replace(/\s*\{#[\w-]+\}$/, "").trim();
      // The heading's own path is the headings above it, not including itself.
      headings.length = Math.min(headings.length, depth - 1);
      push("heading", [line]);
      while (headings.length < depth - 1) headings.push("");
      headings.push(title);
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const block: string[] = [];
      while (i < lines.length && !BLANK.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      push("quote", block);
      continue;
    }

    if (TABLE_ROW.test(line)) {
      const block: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      push("table", block);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      // A list runs until a blank line is followed by something that is neither another item nor
      // indented into the last one.
      const block: string[] = [];
      while (i < lines.length) {
        const current = lines[i];
        if (BLANK.test(current)) {
          const next = lines[i + 1];
          if (
            next === undefined || !(LIST_ITEM.test(next) || INDENTED.test(next))
          ) break;
          block.push(current);
          i++;
          continue;
        }
        if (
          block.length > 0 && !LIST_ITEM.test(current) &&
          !INDENTED.test(current) &&
          (HEADING.test(current) || FENCE.test(current) ||
            THEMATIC_BREAK.test(current))
        ) break;
        block.push(current);
        i++;
      }
      push("list", block);
      continue;
    }

    // A paragraph: until a blank line, or a line that starts another kind of block.
    const block: string[] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (
        BLANK.test(current) ||
        (block.length > 0 &&
          (HEADING.test(current) || FENCE.test(current) ||
            QUOTE.test(current) ||
            THEMATIC_BREAK.test(current) || LIST_ITEM.test(current)))
      ) break;
      block.push(current);
      i++;
    }
    push("paragraph", block);
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
