/**
 * The document as the viewer renders it: the whole Markdown through `@kuboon/md`, cut back into
 * the server's segments.
 *
 * The document is rendered in one piece, not segment by segment, so that reference links,
 * footnotes and in-document anchors resolve. The server split the same source with the same parser
 * (`server/lib/segments.ts`), so each segment's text is a verbatim slice of the source; finding
 * where each slice starts gives the offset of the top-level element it rendered to.
 */

import { markdownToHast } from "@kuboon/md";
import type { Root, RootContent } from "hast";

/** A segment as `GET /api/docs/:docId` returns it. */
export interface Segment {
  key: string;
  kind: string;
  text: string;
  headingPath: string;
}

/** One top-level piece of the rendered document, and the segment it is, if any. */
export interface Block {
  /** The segment this element renders, or `null` for one that is not a segment (footnotes). */
  segment: Segment | null;
  node: RootContent;
}

/**
 * Renders a document's Markdown and pairs each top-level element with its segment.
 *
 * @param markdown The version's whole Markdown
 * @param segments Its segments, in order
 * @returns The rendered blocks, in order
 */
export async function renderDocument(
  markdown: string,
  segments: readonly Segment[],
): Promise<Block[]> {
  const byOffset = new Map<number, number>();
  let cursor = 0;
  segments.forEach((segment, index) => {
    const at = markdown.indexOf(segment.text, cursor);
    if (at === -1) return;
    byOffset.set(at, index);
    cursor = at + segment.text.length;
  });

  const tree: Root = await markdownToHast(markdown);
  const blocks: Block[] = [];
  // The segment after the last one matched: where an element without a position belongs.
  let next = 0;
  for (const node of tree.children) {
    if (node.type !== "element") continue;
    const offset = node.position?.start.offset;
    let index = offset === undefined ? undefined : byOffset.get(offset);
    // A code block `@kuboon/md` replaced with a drawing (Mermaid) comes back without a position.
    // It is the next segment in order, and that segment is a code block.
    if (offset === undefined && segments[next]?.kind === "code") index = next;
    if (index !== undefined) next = index + 1;
    blocks.push({
      segment: index === undefined ? null : segments[index],
      node,
    });
  }
  return blocks;
}
