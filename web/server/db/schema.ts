/**
 * The D1 tables, as `@remix-run/data-table` sees them.
 *
 * The SQL that creates them is `db/migrations/*\/up.sql` at the repository root; this file has to
 * agree with it column for column. `schema.test.ts` applies the migrations to a local D1 and
 * round-trips a row through every table here, so a column added to one and not the other fails
 * there rather than in production.
 *
 * Times are UTC ISO 8601 strings, and IDs are strings the app generates — see `now()` / `newId()`.
 */

import { column as c, table } from "@remix-run/data-table";

export const STANCES = [
  "concern",
  "proposal",
  "support",
  "question",
  "objection",
] as const;
/** 懸念・提案・支持・質問・反対 — the one vocabulary for what an opinion says about its target. */
export type Stance = (typeof STANCES)[number];

export const SEGMENT_KINDS = [
  "heading",
  "paragraph",
  "list",
  "table",
  "code",
  "quote",
] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

export const users = table({
  name: "users",
  columns: {
    /** The IdP's userId (the `sub` of its token). */
    id: c.text(),
    nickname: c.text(),
    role: c.enum(["sysad"] as const).nullable(),
    created_at: c.text(),
    updated_at: c.text(),
  },
});

export const documents = table({
  name: "documents",
  columns: {
    id: c.text(),
    owner_id: c.text(),
    title: c.text(),
    description: c.text(),
    /** The deadline; `null` for none. */
    closes_at: c.text().nullable(),
    created_at: c.text(),
    updated_at: c.text(),
  },
});

export const versions = table({
  name: "versions",
  columns: {
    id: c.text(),
    document_id: c.text(),
    number: c.integer(),
    status: c.enum(["draft", "released"] as const),
    source_md: c.text(),
    release_note: c.text(),
    released_at: c.text().nullable(),
    created_at: c.text(),
  },
});

export const segments = table({
  name: "segments",
  columns: {
    id: c.text(),
    version_id: c.text(),
    /** Stable across versions, so opinions carry over to the next one. */
    segment_key: c.text(),
    ord: c.integer(),
    kind: c.enum(SEGMENT_KINDS),
    text: c.text(),
    heading_path: c.text(),
  },
});

export const changes = table({
  name: "changes",
  columns: {
    id: c.text(),
    from_version_id: c.text(),
    to_version_id: c.text(),
    ord: c.integer(),
    kind: c.enum(["added", "removed", "modified"] as const),
    from_segment_key: c.text().nullable(),
    to_segment_key: c.text().nullable(),
    diff_json: c.text(),
  },
});

export const opinions = table({
  name: "opinions",
  columns: {
    id: c.text(),
    document_id: c.text(),
    /** The version it was posted against. */
    version_id: c.text(),
    author_id: c.text(),
    title: c.text(),
    /** May be empty. */
    body: c.text(),
    status: c.enum(["published", "adopted", "hidden"] as const),
    created_at: c.text(),
    updated_at: c.text(),
  },
});

/** What an opinion is about, and what it says about it — one row per target. */
export const opinionTargets = table({
  name: "opinion_targets",
  columns: {
    id: c.text(),
    opinion_id: c.text(),
    kind: c.enum(["segment", "document", "opinion"] as const),
    segment_key: c.text().nullable(),
    target_opinion_id: c.text().nullable(),
    stance: c.enum(STANCES),
  },
});

export const supports = table({
  name: "supports",
  primaryKey: ["opinion_id", "user_id"],
  columns: {
    opinion_id: c.text(),
    user_id: c.text(),
    created_at: c.text(),
  },
});

export const adoptions = table({
  name: "adoptions",
  primaryKey: ["change_id", "opinion_id"],
  columns: {
    change_id: c.text(),
    opinion_id: c.text(),
    note: c.text(),
  },
});

export const moderationLogs = table({
  name: "moderation_logs",
  columns: {
    id: c.text(),
    opinion_id: c.text(),
    actor_id: c.text(),
    action: c.enum(["hide", "unhide", "mark_duplicate"] as const),
    reason: c.text(),
    duplicate_of: c.text().nullable(),
    created_at: c.text(),
  },
});

export const filterStats = table({
  name: "filter_stats",
  primaryKey: ["document_id", "day", "kind"],
  columns: {
    document_id: c.text(),
    /** `YYYY-MM-DD`, UTC. */
    day: c.text(),
    kind: c.text(),
    count: c.integer(),
  },
});

/** The current time, in the form every `*_at` column stores. */
export function now(): string {
  return new Date().toISOString();
}

/** A fresh row ID. */
export function newId(): string {
  return crypto.randomUUID();
}
