/**
 * The owner's tools on the remote MCP server: what the owner can do on the web — their documents,
 * the next version's draft and its release, the settings, the opinions with their moderation, and
 * the pre-filter's counts — for an AI acting for them (docs/architecture.md §11).
 *
 * Each tool calls the same functions the web API does (`lib/documents.ts`, `lib/opinions.ts`), so
 * the rules are the same: only the document's owner reads its draft or moderates its opinions, and
 * a moderation always carries a reason, which is public.
 *
 * One server is built per request for the user the access token names (`server/mcp/mod.ts`).
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  createDocument,
  discardDraft,
  getDocument,
  getDraft,
  listDocuments,
  parseDocumentPatch,
  parseMarkdown,
  parseNewDocument,
  RELEASE_NOTE_MAX_LENGTH,
  releaseDraft,
  saveDraft,
  updateDocument,
} from "../lib/documents.ts";
import {
  assertOwner,
  moderateOpinion,
  OpinionError,
  ownerView,
  parseModerationInput,
} from "../lib/opinions.ts";
import { ensureUser } from "../middleware/auth.ts";

/** A tool's answer: the value as JSON text, which is what an MCP client shows the model. */
type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

/** A refusal the owner can act on (not found, not theirs, invalid input) as a tool error. */
async function run(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (e) {
    if (e instanceof OpinionError) return fail(e.message);
    throw e;
  }
}

const documentId = z.string().describe("文書の ID");

/**
 * The MCP server for one owner.
 *
 * @param userId The IdP user the access token was issued to (its `sub`)
 */
export function ownerServer(userId: string): McpServer {
  const server = new McpServer(
    { name: "idobata-bot", version: "1.0.0" },
    {
      instructions:
        "idobata-bot の文書オーナー向けの操作。自分の文書の一覧、登録、設定（タイトル・説明・募集期日）の変更、" +
        "次の版の下書き（Markdown。各段落の前の行の `<!-- #ID -->` が段落 ID で、残した段落の意見は新しい版に引き継がれる）の" +
        "保存・破棄・リリース、意見の一覧と非表示・再表示（理由は公開される）、AI が弾いた発言の件数。",
    },
  );

  server.registerTool(
    "list_my_documents",
    {
      description: "自分が登録した文書の一覧（新しい順）。",
      annotations: { readOnlyHint: true },
    },
    () => run(async () => ok({ documents: await listDocuments(userId) })),
  );

  server.registerTool(
    "get_document",
    {
      description:
        "文書の公開済みの版: Markdown 全文と段落（ID・種類・本文）。version を省くと最新版。",
      inputSchema: z.object({
        document_id: documentId,
        version: z.number().int().positive().optional().describe("版の番号"),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ document_id, version }) =>
      run(async () => {
        const document = await getDocument(document_id, version);
        return document ? ok({ document }) : fail("document not found");
      }),
  );

  server.registerTool(
    "create_document",
    {
      description:
        "文書を新しく登録する（第 1 版として公開される）。markdown に段落 ID の行があればそれを使い、無い段落には振る。",
      inputSchema: z.object({
        title: z.string(),
        description: z.string().optional(),
        closes_at: z.string().nullable().optional().describe(
          "募集期日（ISO 8601）。null か省略で期限なし",
        ),
        markdown: z.string(),
      }),
    },
    ({ title, description, closes_at, markdown }) =>
      run(async () => {
        const parsed = parseNewDocument({
          title,
          description,
          closesAt: closes_at,
          markdown,
        });
        if (!parsed.ok) return fail(parsed.error);
        await ensureUser(userId, undefined);
        const id = await createDocument(userId, parsed.value);
        return ok({ id, document: await getDocument(id) });
      }),
  );

  server.registerTool(
    "update_document",
    {
      description:
        "文書のタイトル・説明・募集期日を変える（渡した項目だけ）。closes_at に null で期限なし、過去の日時で即終了。",
      inputSchema: z.object({
        document_id: documentId,
        title: z.string().optional(),
        description: z.string().optional(),
        closes_at: z.string().nullable().optional(),
      }),
    },
    ({ document_id, title, description, closes_at }) =>
      run(async () => {
        await assertOwner(document_id, userId);
        const parsed = parseDocumentPatch({
          title,
          description,
          closesAt: closes_at,
        });
        if (!parsed.ok) return fail(parsed.error);
        await updateDocument(document_id, parsed.value);
        return ok({ document: await getDocument(document_id) });
      }),
  );

  server.registerTool(
    "get_draft",
    {
      description:
        "次の版の下書き（段落 ID の行 `<!-- #ID -->` 付きの Markdown）。下書きが無ければ最新版を出発点として返す（saved: false）。",
      inputSchema: z.object({ document_id: documentId }),
      annotations: { readOnlyHint: true },
    },
    ({ document_id }) =>
      run(async () => {
        await assertOwner(document_id, userId);
        return ok({ draft: await getDraft(document_id) });
      }),
  );

  server.registerTool(
    "save_draft",
    {
      description:
        "次の版の下書きを保存する（前の下書きを置き換える。読者にはまだ見えない）。段落 ID の行を残した段落は同じ段落とみなされ、意見が引き継がれる。ID の無い段落には新しい ID を振って返す。リストの項目の間に ID 行は置けない（リストは全体で 1 段落）。",
      inputSchema: z.object({
        document_id: documentId,
        markdown: z.string(),
      }),
    },
    ({ document_id, markdown }) =>
      run(async () => {
        await assertOwner(document_id, userId);
        const parsed = parseMarkdown(markdown);
        if (!parsed.ok) return fail(parsed.error);
        return ok({ draft: await saveDraft(document_id, parsed.value) });
      }),
  );

  server.registerTool(
    "discard_draft",
    {
      description: "下書きを破棄する。",
      inputSchema: z.object({ document_id: documentId }),
      annotations: { destructiveHint: true },
    },
    ({ document_id }) =>
      run(async () => {
        await assertOwner(document_id, userId);
        return await discardDraft(document_id)
          ? ok({ discarded: true })
          : fail("no draft");
      }),
  );

  server.registerTool(
    "release_draft",
    {
      description:
        "保存済みの下書きを新しい版としてリリースする。以後、読者・AI との対話・新しい意見はこの版になる。前の版も読める。",
      inputSchema: z.object({
        document_id: documentId,
        release_note: z.string().max(RELEASE_NOTE_MAX_LENGTH).optional()
          .describe("この版の説明"),
      }),
    },
    ({ document_id, release_note }) =>
      run(async () => {
        await assertOwner(document_id, userId);
        const number = await releaseDraft(
          document_id,
          release_note?.trim() ?? "",
        );
        if (number === null) return fail("no draft");
        return ok({
          released: number,
          document: await getDocument(document_id),
        });
      }),
  );

  server.registerTool(
    "list_opinions_for_owner",
    {
      description:
        "文書への意見すべて（非表示のものも含む。status が hidden）と、モデレーションの記録。",
      inputSchema: z.object({ document_id: documentId }),
      annotations: { readOnlyHint: true },
    },
    ({ document_id }) =>
      run(async () => {
        const { opinions, moderation } = await ownerView(document_id, userId);
        return ok({ opinions, moderation });
      }),
  );

  server.registerTool(
    "moderate_opinion",
    {
      description:
        "意見を非表示にする（hide）か、再表示する（unhide）。理由は必須で、公開される。",
      inputSchema: z.object({
        opinion_id: z.string(),
        action: z.enum(["hide", "unhide"]),
        reason: z.string(),
      }),
    },
    ({ opinion_id, action, reason }) =>
      run(async () => {
        const input = parseModerationInput({ action, reason });
        return ok({
          opinion: await moderateOpinion(opinion_id, userId, input),
        });
      }),
  );

  server.registerTool(
    "get_filter_stats",
    {
      description:
        "AI との対話で、文書と関係ないなどの理由で前段フィルタが弾いた発言の件数（直近 30 日、日・種類ごと）。発言そのものは残していない。",
      inputSchema: z.object({ document_id: documentId }),
      annotations: { readOnlyHint: true },
    },
    ({ document_id }) =>
      run(async () => {
        const { filterStats } = await ownerView(document_id, userId);
        return ok({ filterStats });
      }),
  );

  return server;
}
