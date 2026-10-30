/**
 * Documents and their versions, as the API hands them out.
 *
 * A document is registered as Markdown and stored as version 1, already released, split into
 * segments (docs/architecture.md §3). The owner then writes the next version as a draft — at
 * most one per document — and releases it. The Markdown the owner edits carries each segment's
 * key as a marker line (`segments.ts`); a segment that keeps its key keeps its opinions. Diffs
 * and adoptions build on the same tables later.
 */

import { sql } from "@remix-run/data-table";

import { chunksForD1, getDb } from "../db/mod.ts";
import {
  documents,
  newId,
  now,
  type SegmentKind,
  segments,
  versions,
} from "../db/schema.ts";
import {
  newSegmentKey,
  parseSegments,
  readKeyMarkers,
  SEGMENT_KEY_PATTERN,
  withKeyMarkers,
} from "./segments.ts";

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;
/** Roughly a long policy paper; the whole document goes into every chat turn's context. */
export const MARKDOWN_MAX_LENGTH = 200_000;
export const RELEASE_NOTE_MAX_LENGTH = 2000;

/** A document as the list and the viewer show it. */
export interface DocumentSummary {
  id: string;
  title: string;
  description: string;
  owner: { id: string; nickname: string };
  /** The deadline, or `null` for none. */
  closesAt: string | null;
  /** Whether chat and posting are still open — see {@link isOpen}. */
  open: boolean;
  opinionCount: number;
  createdAt: string;
}

/** One block of a version, as the viewer renders it and an opinion targets it. */
export interface SegmentView {
  key: string;
  kind: SegmentKind;
  /** The block's Markdown source. */
  text: string;
  headingPath: string;
}

export interface DocumentDetail extends DocumentSummary {
  version: { number: number; releasedAt: string | null };
  /**
   * The version's whole Markdown. The viewer renders it in one piece (so references and footnotes
   * resolve) and finds each segment in it by its text.
   */
  markdown: string;
  versions: { number: number; releasedAt: string | null }[];
  segments: SegmentView[];
}

/**
 * Whether a document still takes chat and opinions: until its deadline, or always without one.
 * The check is made per request rather than by a job that flips a flag (docs/design.md §7).
 */
export function isOpen(closesAt: string | null, at = new Date()): boolean {
  return closesAt === null || at.getTime() < Date.parse(closesAt);
}

/** What `POST /api/docs` takes, once validated. */
export interface NewDocument {
  title: string;
  description: string;
  closesAt: string | null;
  markdown: string;
}

/**
 * Checks and normalises a `POST /api/docs` body.
 *
 * @returns The document, or the reason it was refused
 */
export function parseNewDocument(
  body: unknown,
): { ok: true; value: NewDocument } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string"
    ? input.description.trim()
    : "";
  const closesAtRaw = input.closesAt;

  if (!title || title.length > TITLE_MAX_LENGTH) {
    return {
      ok: false,
      error: `title must be 1–${TITLE_MAX_LENGTH} characters`,
    };
  }
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    return {
      ok: false,
      error: `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
    };
  }
  const markdown = parseMarkdown(input.markdown);
  if (!markdown.ok) return markdown;

  let closesAt: string | null = null;
  if (closesAtRaw !== undefined && closesAtRaw !== null && closesAtRaw !== "") {
    const at = typeof closesAtRaw === "string" ? Date.parse(closesAtRaw) : NaN;
    if (Number.isNaN(at)) {
      return { ok: false, error: "closesAt must be an ISO 8601 date-time" };
    }
    closesAt = new Date(at).toISOString();
  }

  return {
    ok: true,
    value: { title, description, closesAt, markdown: markdown.value },
  };
}

/**
 * Checks a version's Markdown as the owner wrote it, key markers and all.
 *
 * @returns The Markdown, line endings normalised — once, here, so the stored source and the
 *   segments sliced from it agree byte for byte (the viewer finds each segment in the source by
 *   its text) — or the reason it was refused
 */
export function parseMarkdown(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  const markdown = typeof raw === "string" ? raw.replace(/\r\n?/g, "\n") : "";
  if (markdown.length > MARKDOWN_MAX_LENGTH) {
    return {
      ok: false,
      error: `markdown must be at most ${MARKDOWN_MAX_LENGTH} characters`,
    };
  }
  let segmentCount: number;
  try {
    segmentCount = readKeyMarkers(markdown).keys.length;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (segmentCount === 0) {
    return { ok: false, error: "markdown has no content" };
  }
  return { ok: true, value: markdown };
}

/**
 * A version's segment rows from the owner's Markdown: the clean source to store, and one row per
 * segment with the key it was marked with — or a new one when it had none, or one already taken
 * by an earlier segment of this version (a copied block).
 */
function versionContent(versionId: string, marked: string) {
  const { markdown, keys } = readKeyMarkers(marked);
  const used = new Set<string>();
  const rows = parseSegments(markdown).map((segment, ord) => {
    let key = keys[ord];
    if (!key || !SEGMENT_KEY_PATTERN.test(key) || used.has(key)) {
      do key = newSegmentKey(); while (used.has(key));
    }
    used.add(key);
    return {
      id: newId(),
      version_id: versionId,
      segment_key: key,
      ord,
      kind: segment.kind,
      text: segment.text,
      heading_path: segment.headingPath,
    };
  });
  return { markdown, rows };
}

/**
 * Registers a document: the document row, version 1 (released), and its segments, in one batch.
 *
 * @returns The new document's ID
 */
export async function createDocument(
  ownerId: string,
  input: NewDocument,
): Promise<string> {
  const db = getDb();
  const at = now();
  const documentId = newId();
  const versionId = newId();
  const content = versionContent(versionId, input.markdown);

  await db.transaction(async (tx) => {
    await tx.create(documents, {
      id: documentId,
      owner_id: ownerId,
      title: input.title,
      description: input.description,
      closes_at: input.closesAt,
      created_at: at,
      updated_at: at,
    });
    await tx.create(versions, {
      id: versionId,
      document_id: documentId,
      number: 1,
      status: "released",
      source_md: content.markdown,
      release_note: "",
      released_at: at,
      created_at: at,
    });
    await insertSegments(tx, content.rows);
  });

  return documentId;
}

type SegmentRow = ReturnType<typeof versionContent>["rows"][number];

/** In inserts D1 can take: one per ~14 segments, all still in the caller's one batch. */
async function insertSegments(
  tx: Pick<ReturnType<typeof getDb>, "createMany">,
  rows: SegmentRow[],
): Promise<void> {
  for (const chunk of chunksForD1(rows, Object.keys(rows[0] ?? {}).length)) {
    await tx.createMany(segments, chunk);
  }
}

type SummaryRow = {
  id: string;
  title: string;
  description: string;
  closes_at: string | null;
  created_at: string;
  owner_id: string;
  owner_nickname: string;
  opinion_count: number;
};

function toSummary(row: SummaryRow): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    owner: { id: row.owner_id, nickname: row.owner_nickname },
    closesAt: row.closes_at,
    open: isOpen(row.closes_at),
    opinionCount: Number(row.opinion_count),
    createdAt: row.created_at,
  };
}

const SUMMARY_SELECT = sql`
  SELECT d.id, d.title, d.description, d.closes_at, d.created_at,
         u.id AS owner_id, u.nickname AS owner_nickname,
         (SELECT COUNT(*) FROM opinions o
           WHERE o.document_id = d.id AND o.status != 'hidden') AS opinion_count
    FROM documents d JOIN users u ON u.id = d.owner_id
`;

/**
 * Documents, newest first.
 *
 * @param ownerId Only this user's, when given
 */
export async function listDocuments(
  ownerId?: string,
): Promise<DocumentSummary[]> {
  const { rows = [] } = await getDb().exec(
    ownerId === undefined
      ? sql`${SUMMARY_SELECT} ORDER BY d.created_at DESC LIMIT 200`
      : sql`${SUMMARY_SELECT} WHERE d.owner_id = ${ownerId}
          ORDER BY d.created_at DESC LIMIT 200`,
  );
  return (rows as SummaryRow[]).map(toSummary);
}

/** One document's summary, or `null`. */
export async function getDocumentSummary(
  id: string,
): Promise<DocumentSummary | null> {
  const { rows = [] } = await getDb().exec(
    sql`${SUMMARY_SELECT} WHERE d.id = ${id}`,
  );
  const row = (rows as SummaryRow[])[0];
  return row ? toSummary(row) : null;
}

/**
 * A document with one released version's segments — the latest unless `versionNumber` names one.
 *
 * @returns The document, or `null` when it or that version does not exist
 */
export async function getDocument(
  id: string,
  versionNumber?: number,
): Promise<DocumentDetail | null> {
  const summary = await getDocumentSummary(id);
  if (!summary) return null;

  const db = getDb();
  const released = await db.findMany(versions, {
    where: { document_id: id, status: "released" },
    orderBy: ["number", "asc"],
  });
  const version = versionNumber === undefined
    ? released.at(-1)
    : released.find((v) => v.number === versionNumber);
  if (!version) return null;

  const rows = await db.findMany(segments, {
    where: { version_id: version.id },
    orderBy: ["ord", "asc"],
  });

  return {
    ...summary,
    version: { number: version.number, releasedAt: version.released_at },
    markdown: version.source_md,
    versions: released.map((v) => ({
      number: v.number,
      releasedAt: v.released_at,
    })),
    segments: rows.map((row) => ({
      key: row.segment_key,
      kind: row.kind,
      text: row.text,
      headingPath: row.heading_path,
    })),
  };
}

/** Who owns a document, or `null` when there is no such document. */
export async function documentOwner(id: string): Promise<string | null> {
  const row = await getDb().find(documents, id);
  return row?.owner_id ?? null;
}

/** What `PATCH /api/docs/:docId` changes — only the fields it was given. */
export interface DocumentPatch {
  title?: string;
  description?: string;
  /** `null` takes the deadline away. */
  closesAt?: string | null;
}

/**
 * Checks a `PATCH /api/docs/:docId` body.
 *
 * @returns The changes, or the reason they were refused
 */
export function parseDocumentPatch(
  body: unknown,
): { ok: true; value: DocumentPatch } | { ok: false; error: string } {
  const input = (body ?? {}) as Record<string, unknown>;
  const value: DocumentPatch = {};
  if (input.title !== undefined) {
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (!title || title.length > TITLE_MAX_LENGTH) {
      return {
        ok: false,
        error: `title must be 1–${TITLE_MAX_LENGTH} characters`,
      };
    }
    value.title = title;
  }
  if (input.description !== undefined) {
    const description = typeof input.description === "string"
      ? input.description.trim()
      : null;
    if (description === null || description.length > DESCRIPTION_MAX_LENGTH) {
      return {
        ok: false,
        error:
          `description must be at most ${DESCRIPTION_MAX_LENGTH} characters`,
      };
    }
    value.description = description;
  }
  if (input.closesAt !== undefined) {
    if (input.closesAt === null || input.closesAt === "") {
      value.closesAt = null;
    } else {
      const at = typeof input.closesAt === "string"
        ? Date.parse(input.closesAt)
        : NaN;
      if (Number.isNaN(at)) {
        return { ok: false, error: "closesAt must be an ISO 8601 date-time" };
      }
      value.closesAt = new Date(at).toISOString();
    }
  }
  return { ok: true, value };
}

/** Changes a document's title, description or deadline. The caller has checked the owner. */
export async function updateDocument(
  id: string,
  patch: DocumentPatch,
): Promise<void> {
  const changes: {
    title?: string;
    description?: string;
    closes_at?: string | null;
    updated_at: string;
  } = { updated_at: now() };
  if (patch.title !== undefined) changes.title = patch.title;
  if (patch.description !== undefined) changes.description = patch.description;
  if (patch.closesAt !== undefined) changes.closes_at = patch.closesAt;
  await getDb().update(documents, id, changes);
}

/** The next version as the owner edits it. */
export interface DraftView {
  /** The number it will have once released. */
  number: number;
  /** Its Markdown, each segment preceded by its key marker. */
  markdown: string;
  /**
   * Whether it is a saved draft. When not, the Markdown is the latest release's, to start from,
   * and nothing is stored until the owner saves.
   */
  saved: boolean;
  /** The latest released version's number. */
  released: number;
}

/** A version's Markdown with its segments' keys marked. */
async function markedSource(
  version: { id: string; source_md: string },
): Promise<string> {
  const rows = await getDb().findMany(segments, {
    where: { version_id: version.id },
    orderBy: ["ord", "asc"],
  });
  return withKeyMarkers(version.source_md, rows.map((r) => r.segment_key));
}

async function documentVersions(documentId: string) {
  const all = await getDb().findMany(versions, {
    where: { document_id: documentId },
    orderBy: ["number", "asc"],
  });
  return {
    draft: all.find((v) => v.status === "draft") ?? null,
    released: all.filter((v) => v.status === "released").at(-1) ?? null,
    next: (all.at(-1)?.number ?? 0) + 1,
  };
}

/**
 * The document's draft, or the latest release to start one from.
 *
 * @returns The draft, or `null` when the document has no released version (no such document)
 */
export async function getDraft(documentId: string): Promise<DraftView | null> {
  const { draft, released, next } = await documentVersions(documentId);
  if (!released) return null;
  if (draft) {
    return {
      number: draft.number,
      markdown: await markedSource(draft),
      saved: true,
      released: released.number,
    };
  }
  return {
    number: next,
    markdown: await markedSource(released),
    saved: false,
    released: released.number,
  };
}

/**
 * Saves the owner's Markdown as the document's draft, replacing the one there is. Segments
 * without a key get one here; the returned draft shows them, so the owner sees every key.
 *
 * @param markdown Checked with {@link parseMarkdown}
 */
export async function saveDraft(
  documentId: string,
  markdown: string,
): Promise<DraftView | null> {
  const { draft, released, next } = await documentVersions(documentId);
  if (!released) return null;
  const versionId = draft?.id ?? newId();
  const content = versionContent(versionId, markdown);
  const at = now();

  await getDb().transaction(async (tx) => {
    if (draft) {
      await tx.deleteMany(segments, { where: { version_id: draft.id } });
      await tx.updateMany(versions, { source_md: content.markdown }, {
        where: { id: draft.id },
      });
    } else {
      await tx.create(versions, {
        id: versionId,
        document_id: documentId,
        number: next,
        status: "draft",
        source_md: content.markdown,
        release_note: "",
        released_at: null,
        created_at: at,
      });
    }
    await insertSegments(tx, content.rows);
    await tx.updateMany(documents, { updated_at: at }, {
      where: { id: documentId },
    });
  });

  return {
    number: draft?.number ?? next,
    markdown: withKeyMarkers(
      content.markdown,
      content.rows.map((r) => r.segment_key),
    ),
    saved: true,
    released: released.number,
  };
}

/** Throws the draft away. @returns Whether there was one */
export async function discardDraft(documentId: string): Promise<boolean> {
  const { draft } = await documentVersions(documentId);
  if (!draft) return false;
  await getDb().transaction(async (tx) => {
    await tx.deleteMany(segments, { where: { version_id: draft.id } });
    await tx.deleteMany(versions, {
      where: { id: draft.id, status: "draft" },
    });
  });
  return true;
}

/**
 * Releases the draft: from now on it is what readers see, what the chat reads and what new
 * opinions are posted against. The earlier versions stay readable.
 *
 * @returns The released version's number, or `null` when there was no draft
 */
export async function releaseDraft(
  documentId: string,
  releaseNote: string,
): Promise<number | null> {
  const { draft } = await documentVersions(documentId);
  if (!draft) return null;
  const at = now();
  const result = await getDb().exec(sql`
    UPDATE versions
       SET status = 'released', released_at = ${at}, release_note = ${releaseNote}
     WHERE id = ${draft.id} AND status = 'draft'
  `);
  if (!result.affectedRows) return null;
  await getDb().update(documents, documentId, { updated_at: at });
  return draft.number;
}
