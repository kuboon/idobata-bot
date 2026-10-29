/**
 * What the chat's tools do. The model calls them by name with the inputs `prompt.ts` describes;
 * each answers with text for the model. They read opinions through the opinion service's own
 * functions, as a signed-out reader — the model sees what anyone can see.
 */

import type { ChatDraft, Opinion, Stance, Target } from "@kuboon/idobata-bot";

import type { SegmentView } from "../documents.ts";
import { getOpinionDetail, listOpinions } from "../opinions.ts";

/** What a tool sees of the conversation. */
export interface ToolContext {
  documentId: string;
  /** The conversation's version, in order — block `i` is `segments[i]`. */
  segments: readonly SegmentView[];
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

const SEARCH_LIMIT = 10;
const EXCERPT_LENGTH = 200;

const excerpt = (text: string) =>
  text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;

/** An opinion as the model reads it, with targets named by block index. */
function describe(opinion: Opinion, context: ToolContext, full = false) {
  return {
    id: opinion.id,
    title: opinion.title,
    body: full ? opinion.body : excerpt(opinion.body),
    targets: opinion.targets.map((t) => {
      if (t.kind === "segment") {
        const index = context.segments.findIndex((s) => s.key === t.segmentKey);
        // A segment of another version has no block here.
        return { kind: "segment", segment_index: index, stance: t.stance };
      }
      if (t.kind === "opinion") {
        return { kind: "opinion", opinion_id: t.opinionId, stance: t.stance };
      }
      return { kind: "document", stance: t.stance };
    }),
    support_count: opinion.supportCount,
    status: opinion.status,
  };
}

/** Lower-cased words of a query, split on spaces of either width. */
function terms(query: string): string[] {
  return query.toLowerCase().split(/[\s　、。,.]+/).filter(Boolean);
}

async function searchOpinions(
  input: { query: string; segment_indices: number[] },
  context: ToolContext,
): Promise<ToolResult> {
  const { opinions } = await listOpinions(context.documentId, null);
  const keys = new Set(
    input.segment_indices.map((i) => context.segments[i]?.key).filter(Boolean),
  );
  const words = terms(input.query);

  // Matching is by words for now; similar-opinion search with embeddings comes later
  // (docs/architecture.md §7).
  const scored = opinions
    .filter((o) =>
      keys.size === 0 ||
      o.targets.some((t) => t.kind === "segment" && keys.has(t.segmentKey))
    )
    .map((o) => {
      const haystack = `${o.title} ${o.body}`.toLowerCase();
      return { o, score: words.filter((w) => haystack.includes(w)).length };
    })
    .filter(({ score }) => words.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || b.o.supportCount - a.o.supportCount)
    .slice(0, SEARCH_LIMIT);

  return {
    content: JSON.stringify({
      opinions: scored.map(({ o }) => describe(o, context)),
      total_on_document: opinions.length,
    }),
  };
}

async function getOpinion(
  input: { opinion_id: string },
  context: ToolContext,
): Promise<ToolResult> {
  const opinion = await getOpinionDetail(input.opinion_id, null);
  if (!opinion || opinion.documentId !== context.documentId) {
    return { content: "その ID の意見はこの文書にありません。", isError: true };
  }
  return {
    content: JSON.stringify({
      ...describe(opinion, context, true),
      responses: opinion.incoming.map((o) => describe(o, context)),
    }),
  };
}

export interface DraftInput {
  type: "opinion" | "support";
  support_opinion_id: string;
  title: string;
  body: string;
  targets: {
    kind: "segment" | "document" | "opinion";
    segment_index: number;
    opinion_id: string;
    stance: Stance;
  }[];
}

/**
 * Checks a `draft_opinion` call and turns it into what the browser opens the posting dialog with:
 * block numbers become segment keys, and an opinion to support must be on this document.
 *
 * @returns The draft, or the error result the model reads instead
 */
export async function resolveDraft(
  input: DraftInput,
  context: ToolContext,
): Promise<{ draft: ChatDraft } | { error: ToolResult }> {
  const error = (content: string) => ({ error: { content, isError: true } });
  if (input.type === "support") {
    const opinion = await getOpinionDetail(input.support_opinion_id, null);
    if (!opinion || opinion.documentId !== context.documentId) {
      return error("その ID の意見はこの文書にありません。");
    }
    return { draft: { type: "support", opinionId: opinion.id } };
  }

  const targets: Target[] = [];
  for (const t of input.targets ?? []) {
    if (t.kind === "segment") {
      const segment = context.segments[t.segment_index];
      if (!segment) {
        return error(`文書ブロック ${t.segment_index} はありません。`);
      }
      targets.push({
        kind: "segment",
        segmentKey: segment.key,
        stance: t.stance,
      });
    } else if (t.kind === "opinion") {
      targets.push({
        kind: "opinion",
        opinionId: t.opinion_id,
        stance: t.stance,
      });
    } else {
      targets.push({ kind: "document", stance: t.stance });
    }
  }
  if (targets.length === 0) {
    return error(
      "targets が空です。何に対する意見か、一つ以上指定してください。",
    );
  }
  if (!input.title?.trim()) return error("title は必須です。");
  return {
    draft: {
      type: "opinion",
      input: {
        title: input.title,
        body: input.body ?? "",
        targets,
      },
    },
  };
}

/**
 * Runs one of the server's tools. `draft_opinion` is not one: the browser runs it, after
 * {@link resolveDraft}.
 *
 * @returns The result for the model — an unknown tool or a failure is an error result, so the
 *   model can recover rather than the turn ending
 */
export async function runTool(
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "search_opinions":
        return await searchOpinions(input as never, context);
      case "get_opinion":
        return await getOpinion(input as never, context);
      default:
        return { content: `ツール ${name} はありません。`, isError: true };
    }
  } catch (error) {
    console.error("chat tool failed", name, error);
    return { content: "ツールの実行に失敗しました。", isError: true };
  }
}
