/**
 * Documents and their versions, as the API hands them out.
 *
 * A document is registered as Markdown and stored as version 1, already released, split into
 * segments (docs/architecture.md §3). Later versions — drafts, release, diffs — build on the same
 * tables.
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
import { newSegmentKey, parseSegments } from "./segments.ts";

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;
/** Roughly a long policy paper; the whole document goes into every chat turn's context. */
export const MARKDOWN_MAX_LENGTH = 200_000;

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
  // Line endings normalised here, once, so the stored source and the segments sliced from it
  // agree byte for byte — the viewer finds each segment in the source by its text.
  const markdown = typeof input.markdown === "string"
    ? input.markdown.replace(/\r\n?/g, "\n")
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
  if (markdown.length > MARKDOWN_MAX_LENGTH) {
    return {
      ok: false,
      error: `markdown must be at most ${MARKDOWN_MAX_LENGTH} characters`,
    };
  }
  if (parseSegments(markdown).length === 0) {
    return { ok: false, error: "markdown has no content" };
  }

  let closesAt: string | null = null;
  if (closesAtRaw !== undefined && closesAtRaw !== null && closesAtRaw !== "") {
    const at = typeof closesAtRaw === "string" ? Date.parse(closesAtRaw) : NaN;
    if (Number.isNaN(at)) {
      return { ok: false, error: "closesAt must be an ISO 8601 date-time" };
    }
    closesAt = new Date(at).toISOString();
  }

  return { ok: true, value: { title, description, closesAt, markdown } };
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
  const parsed = parseSegments(input.markdown);

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
      source_md: input.markdown,
      release_note: "",
      released_at: at,
      created_at: at,
    });
    const rows = parsed.map((segment, ord) => ({
      id: newId(),
      version_id: versionId,
      segment_key: newSegmentKey(),
      ord,
      kind: segment.kind,
      text: segment.text,
      heading_path: segment.headingPath,
    }));
    // In inserts D1 can take: one per ~14 segments, all still in the one batch.
    for (const chunk of chunksForD1(rows, Object.keys(rows[0] ?? {}).length)) {
      await tx.createMany(segments, chunk);
    }
  });

  return documentId;
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
