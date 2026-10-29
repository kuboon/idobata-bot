/**
 * Opinions, their targets, and supports — the opinion service's data (③ in docs/design.md §2).
 *
 * The service knows a document only by its ID, its versions and its segment keys; nothing here
 * reads how a document is rendered. Rules (docs/design.md §5):
 *
 * - An opinion says something about one or more targets: a segment, the whole document, or another
 *   opinion — each with a stance.
 * - It can be edited or deleted only while it is still one person's: no supports, no other opinion
 *   naming it, not adopted. Worked out at the moment of the request, so a withdrawn support makes
 *   it editable again.
 * - Nothing is posted, supported or changed after the document's deadline.
 * - The document's owner can hide an opinion and show it again, always with a reason, which is
 *   kept and public (docs/design.md §5).
 */

import type {
  FilterStat,
  ModerationAction,
  ModerationInput,
  ModerationLog,
  Opinion,
  OpinionDetail,
  OpinionInput,
  OpinionList,
  OwnerView,
  Target,
} from "@kuboon/idobata-bot";
import { inList, sql } from "@remix-run/data-table";

import { chunksForD1, getDb } from "../db/mod.ts";
import {
  moderationLogs,
  newId,
  now,
  opinions,
  opinionTargets,
  STANCES,
  supports,
} from "../db/schema.ts";
import { documentOwner, isOpen } from "./documents.ts";

export const TITLE_MAX_LENGTH = 120;
export const BODY_MAX_LENGTH = 4000;
export const TARGETS_MAX = 20;

/** Why a request was refused, as the HTTP status the API answers with. */
export class OpinionError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

/**
 * Checks and normalises an opinion body.
 *
 * @throws {OpinionError} 400 with the reason
 */
export function parseOpinionInput(body: unknown): OpinionInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const text = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string).trim() : "";
  const title = text("title");
  const claim = text("claim");
  const reason = text("reason");
  const suggestion = text("suggestion");
  const bad = (message: string) => new OpinionError(400, message);

  if (!title || title.length > TITLE_MAX_LENGTH) {
    throw bad(`title must be 1–${TITLE_MAX_LENGTH} characters`);
  }
  for (const [name, value] of [["claim", claim], ["reason", reason]]) {
    if (!value || value.length > BODY_MAX_LENGTH) {
      throw bad(`${name} must be 1–${BODY_MAX_LENGTH} characters`);
    }
  }
  if (suggestion.length > BODY_MAX_LENGTH) {
    throw bad(`suggestion must be at most ${BODY_MAX_LENGTH} characters`);
  }

  const raw = Array.isArray(input.targets) ? input.targets : [];
  if (raw.length === 0 || raw.length > TARGETS_MAX) {
    throw bad(`targets must have 1–${TARGETS_MAX} entries`);
  }
  const seen = new Set<string>();
  const targets: Target[] = raw.map((entry) => {
    const t = (entry ?? {}) as Record<string, unknown>;
    const stance = t.stance;
    if (!STANCES.includes(stance as never)) throw bad("unknown stance");
    let target: Target;
    if (
      t.kind === "segment" && typeof t.segmentKey === "string" && t.segmentKey
    ) {
      target = { kind: "segment", segmentKey: t.segmentKey, stance } as Target;
    } else if (t.kind === "document") {
      target = { kind: "document", stance } as Target;
    } else if (
      t.kind === "opinion" && typeof t.opinionId === "string" && t.opinionId
    ) {
      target = { kind: "opinion", opinionId: t.opinionId, stance } as Target;
    } else {
      throw bad("each target needs a kind and what it names");
    }
    const key = targetKey(target);
    if (seen.has(key)) throw bad("the same target is named twice");
    seen.add(key);
    return target;
  });

  return { title, claim, reason, suggestion, targets };
}

function targetKey(target: Target): string {
  switch (target.kind) {
    case "segment":
      return `s:${target.segmentKey}`;
    case "document":
      return "d";
    case "opinion":
      return `o:${target.opinionId}`;
  }
}

/** The document's state as far as opinions care, or 404. */
async function documentFor(documentId: string) {
  const { rows = [] } = await getDb().exec(sql`
    SELECT d.id, d.closes_at,
           (SELECT v.id FROM versions v WHERE v.document_id = d.id AND v.status = 'released'
             ORDER BY v.number DESC LIMIT 1) AS version_id
      FROM documents d WHERE d.id = ${documentId}
  `);
  const row = rows[0] as
    | { id: string; closes_at: string | null; version_id: string | null }
    | undefined;
  if (!row || !row.version_id) {
    throw new OpinionError(404, "document not found");
  }
  return row as { id: string; closes_at: string | null; version_id: string };
}

function assertOpen(closesAt: string | null) {
  if (!isOpen(closesAt)) {
    throw new OpinionError(403, "the document is closed to opinions");
  }
}

/**
 * Checks that every target exists in this document: segment keys in any of its versions (an
 * opinion on an earlier version's segment stays valid), opinions in it and not hidden.
 */
async function assertTargetsExist(
  documentId: string,
  targets: Target[],
  self?: string,
) {
  const db = getDb();
  for (const target of targets) {
    if (target.kind === "segment") {
      const { rows = [] } = await db.exec(sql`
        SELECT 1 FROM segments s JOIN versions v ON v.id = s.version_id
         WHERE v.document_id = ${documentId} AND s.segment_key = ${target.segmentKey}
         LIMIT 1
      `);
      if (rows.length === 0) {
        throw new OpinionError(400, `no segment ${target.segmentKey}`);
      }
    } else if (target.kind === "opinion") {
      if (target.opinionId === self) {
        throw new OpinionError(400, "an opinion cannot name itself");
      }
      const row = await db.find(opinions, target.opinionId);
      if (!row || row.document_id !== documentId || row.status === "hidden") {
        throw new OpinionError(400, `no opinion ${target.opinionId}`);
      }
    }
  }
}

/** An opinion's target rows, in groups that each fit one D1 insert. */
function targetRows(opinionId: string, targets: Target[]) {
  const rows = targets.map((target) => ({
    id: newId(),
    opinion_id: opinionId,
    kind: target.kind,
    segment_key: target.kind === "segment" ? target.segmentKey : null,
    target_opinion_id: target.kind === "opinion" ? target.opinionId : null,
    stance: target.stance,
  }));
  return chunksForD1(rows, Object.keys(rows[0] ?? {}).length);
}

type OpinionRow = {
  id: string;
  document_id: string;
  version_number: number;
  author_id: string;
  author_nickname: string;
  title: string;
  claim: string;
  reason: string;
  suggestion: string;
  status: "published" | "adopted" | "hidden";
  support_count: number;
  incoming_count: number;
  supported_by_me: number;
  created_at: string;
  updated_at: string;
};

const SELECT_OPINIONS = (viewerId: string | null) =>
  sql`
  SELECT o.id, o.document_id, v.number AS version_number,
         o.author_id, u.nickname AS author_nickname,
         o.title, o.claim, o.reason, o.suggestion, o.status,
         o.created_at, o.updated_at,
         (SELECT COUNT(*) FROM supports s WHERE s.opinion_id = o.id) AS support_count,
         (SELECT COUNT(*) FROM opinion_targets t JOIN opinions o2 ON o2.id = t.opinion_id
           WHERE t.target_opinion_id = o.id AND o2.status != 'hidden') AS incoming_count,
         EXISTS (SELECT 1 FROM supports s
                  WHERE s.opinion_id = o.id AND s.user_id = ${
    viewerId ?? ""
  }) AS supported_by_me
    FROM opinions o
    JOIN users u ON u.id = o.author_id
    JOIN versions v ON v.id = o.version_id
`;

/** Rows to API objects, with their targets loaded in one query. */
async function toOpinions(
  rows: OpinionRow[],
  viewerId: string | null,
): Promise<Opinion[]> {
  if (rows.length === 0) return [];
  // One IN (…) per 100 opinions: each ID is a parameter.
  const targets = (await Promise.all(
    chunksForD1(rows.map((r) => r.id), 1).map((ids) =>
      getDb().findMany(opinionTargets, { where: inList("opinion_id", ids) })
    ),
  )).flat();
  const byOpinion = new Map<string, Target[]>();
  for (const t of targets) {
    const list = byOpinion.get(t.opinion_id) ?? [];
    list.push(
      t.kind === "segment"
        ? { kind: "segment", segmentKey: t.segment_key ?? "", stance: t.stance }
        : t.kind === "opinion"
        ? {
          kind: "opinion",
          opinionId: t.target_opinion_id ?? "",
          stance: t.stance,
        }
        : { kind: "document", stance: t.stance },
    );
    byOpinion.set(t.opinion_id, list);
  }
  return rows.map((r) => {
    const supportCount = Number(r.support_count);
    const incomingCount = Number(r.incoming_count);
    return {
      id: r.id,
      documentId: r.document_id,
      version: Number(r.version_number),
      author: { id: r.author_id, nickname: r.author_nickname },
      title: r.title,
      claim: r.claim,
      reason: r.reason,
      suggestion: r.suggestion,
      targets: byOpinion.get(r.id) ?? [],
      status: r.status,
      supportCount,
      incomingCount,
      frozen: supportCount > 0 || incomingCount > 0 || r.status === "adopted",
      supportedByMe: Boolean(Number(r.supported_by_me)),
      mine: viewerId !== null && r.author_id === viewerId,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

/** A document's published opinions, oldest first, and how many were hidden. */
export async function listOpinions(
  documentId: string,
  viewerId: string | null,
): Promise<OpinionList> {
  await documentFor(documentId);
  const db = getDb();
  const { rows = [] } = await db.exec(sql`${SELECT_OPINIONS(viewerId)}
    WHERE o.document_id = ${documentId} AND o.status != 'hidden'
    ORDER BY o.created_at ASC`);
  const hiddenCount = await db.count(opinions, {
    where: { document_id: documentId, status: "hidden" },
  });
  return {
    opinions: await toOpinions(rows as OpinionRow[], viewerId),
    hiddenCount,
  };
}

/** One opinion, or null when there is none (or it is hidden). */
export async function getOpinion(
  opinionId: string,
  viewerId: string | null,
): Promise<Opinion | null> {
  const { rows = [] } = await getDb().exec(sql`${SELECT_OPINIONS(viewerId)}
    WHERE o.id = ${opinionId} AND o.status != 'hidden'`);
  const [opinion] = await toOpinions(rows as OpinionRow[], viewerId);
  return opinion ?? null;
}

/** One opinion with the opinions that name it. */
export async function getOpinionDetail(
  opinionId: string,
  viewerId: string | null,
): Promise<OpinionDetail | null> {
  const opinion = await getOpinion(opinionId, viewerId);
  if (!opinion) return null;
  const { rows = [] } = await getDb().exec(sql`${SELECT_OPINIONS(viewerId)}
    WHERE o.status != 'hidden' AND o.id IN (
      SELECT t.opinion_id FROM opinion_targets t WHERE t.target_opinion_id = ${opinionId})
    ORDER BY o.created_at ASC`);
  return {
    ...opinion,
    incoming: await toOpinions(rows as OpinionRow[], viewerId),
  };
}

/** The user's own opinions, newest first. */
export async function listMyOpinions(userId: string): Promise<Opinion[]> {
  const { rows = [] } = await getDb().exec(sql`${SELECT_OPINIONS(userId)}
    WHERE o.author_id = ${userId}
    ORDER BY o.created_at DESC LIMIT 500`);
  return toOpinions(rows as OpinionRow[], userId);
}

/** Posts an opinion against the document's latest released version. */
export async function createOpinion(
  documentId: string,
  authorId: string,
  input: OpinionInput,
): Promise<Opinion> {
  const document = await documentFor(documentId);
  assertOpen(document.closes_at);
  await assertTargetsExist(documentId, input.targets);

  const id = newId();
  const at = now();
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.create(opinions, {
      id,
      document_id: documentId,
      version_id: document.version_id,
      author_id: authorId,
      title: input.title,
      claim: input.claim,
      reason: input.reason,
      suggestion: input.suggestion ?? "",
      status: "published",
      created_at: at,
      updated_at: at,
    });
    for (const chunk of targetRows(id, input.targets)) {
      await tx.createMany(opinionTargets, chunk);
    }
  });
  return (await getOpinion(id, authorId))!;
}

/** The opinion if the user may still change it: theirs, open, and not frozen. */
async function editable(opinionId: string, userId: string) {
  const opinion = await getOpinion(opinionId, userId);
  if (!opinion) throw new OpinionError(404, "opinion not found");
  if (!opinion.mine) throw new OpinionError(403, "not your opinion");
  const document = await documentFor(opinion.documentId);
  assertOpen(document.closes_at);
  if (opinion.frozen) {
    throw new OpinionError(
      409,
      "supported or named by another opinion: no longer one person's to change",
    );
  }
  return opinion;
}

/**
 * The guard every change carries in its own `WHERE`, so a support or an incoming target that lands
 * between the check and the write still stops it.
 */
const STILL_UNFROZEN = sql`
  status = 'published'
  AND NOT EXISTS (SELECT 1 FROM supports s WHERE s.opinion_id = opinions.id)
  AND NOT EXISTS (SELECT 1 FROM opinion_targets t JOIN opinions o2 ON o2.id = t.opinion_id
                   WHERE t.target_opinion_id = opinions.id AND o2.status != 'hidden')
`;

/** Rewrites an opinion's body and targets. */
export async function updateOpinion(
  opinionId: string,
  userId: string,
  input: OpinionInput,
): Promise<Opinion> {
  const opinion = await editable(opinionId, userId);
  await assertTargetsExist(opinion.documentId, input.targets, opinionId);

  const db = getDb();
  const updated = await db.exec(sql`
    UPDATE opinions
       SET title = ${input.title}, claim = ${input.claim}, reason = ${input.reason},
           suggestion = ${input.suggestion ?? ""}, updated_at = ${now()}
     WHERE id = ${opinionId} AND author_id = ${userId} AND ${STILL_UNFROZEN}
  `);
  if (!updated.affectedRows) {
    throw new OpinionError(409, "no longer one person's to change");
  }
  await db.transaction(async (tx) => {
    await tx.deleteMany(opinionTargets, { where: { opinion_id: opinionId } });
    for (const chunk of targetRows(opinionId, input.targets)) {
      await tx.createMany(opinionTargets, chunk);
    }
  });
  return (await getOpinion(opinionId, userId))!;
}

/** Deletes an opinion outright — only one nobody else has built on. */
export async function deleteOpinion(
  opinionId: string,
  userId: string,
): Promise<void> {
  await editable(opinionId, userId);
  const deleted = await getDb().exec(sql`
    DELETE FROM opinions
     WHERE id = ${opinionId} AND author_id = ${userId} AND ${STILL_UNFROZEN}
  `);
  if (!deleted.affectedRows) {
    throw new OpinionError(409, "no longer one person's to change");
  }
}

/** Adds or withdraws the user's support. Either way is idempotent. */
export async function setSupport(
  opinionId: string,
  userId: string,
  on: boolean,
): Promise<Opinion> {
  const opinion = await getOpinion(opinionId, userId);
  if (!opinion) throw new OpinionError(404, "opinion not found");
  const document = await documentFor(opinion.documentId);
  assertOpen(document.closes_at);

  const db = getDb();
  if (on) {
    if (opinion.mine) {
      throw new OpinionError(400, "you cannot support your own opinion");
    }
    await db.exec(sql`
      INSERT INTO supports (opinion_id, user_id, created_at)
      VALUES (${opinionId}, ${userId}, ${now()})
      ON CONFLICT (opinion_id, user_id) DO NOTHING
    `);
  } else {
    await db.deleteMany(supports, {
      where: { opinion_id: opinionId, user_id: userId },
    });
  }
  return (await getOpinion(opinionId, userId))!;
}

export const MODERATION_REASON_MAX_LENGTH = 500;
/** How far back the owner sees the pre-filter's counts. */
export const FILTER_STATS_DAYS = 30;

/**
 * Throws unless the user owns the document.
 *
 * @throws {OpinionError} 404 when there is no such document, 403 when it is someone else's
 */
export async function assertOwner(
  documentId: string,
  userId: string,
): Promise<void> {
  const owner = await documentOwner(documentId);
  if (owner === null) throw new OpinionError(404, "document not found");
  if (owner !== userId) {
    throw new OpinionError(403, "only the document's owner may do this");
  }
}

/** Checks a moderation body. */
export function parseModerationInput(body: unknown): ModerationInput {
  const input = (body ?? {}) as Record<string, unknown>;
  const action = input.action;
  if (action !== "hide" && action !== "unhide") {
    throw new OpinionError(400, "action must be hide or unhide");
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason || reason.length > MODERATION_REASON_MAX_LENGTH) {
    throw new OpinionError(
      400,
      `reason must be 1–${MODERATION_REASON_MAX_LENGTH} characters`,
    );
  }
  return { action, reason };
}

/** Every opinion on a document, hidden ones too, with the moderation record and the filter counts. */
export async function ownerView(
  documentId: string,
  userId: string,
): Promise<OwnerView> {
  await assertOwner(documentId, userId);
  const db = getDb();
  const { rows = [] } = await db.exec(sql`${SELECT_OPINIONS(userId)}
    WHERE o.document_id = ${documentId}
    ORDER BY o.created_at ASC`);
  const { rows: logs = [] } = await db.exec(sql`
    SELECT l.id, l.opinion_id, l.action, l.reason, l.created_at
      FROM moderation_logs l JOIN opinions o ON o.id = l.opinion_id
     WHERE o.document_id = ${documentId}
     ORDER BY l.created_at DESC`);
  const since = new Date(Date.now() - FILTER_STATS_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const { rows: stats = [] } = await db.exec(sql`
    SELECT day, kind, count FROM filter_stats
     WHERE document_id = ${documentId} AND day >= ${since}
     ORDER BY day DESC, kind`);
  return {
    opinions: await toOpinions(rows as OpinionRow[], userId),
    moderation: (logs as {
      id: string;
      opinion_id: string;
      action: ModerationAction | "mark_duplicate";
      reason: string;
      created_at: string;
    }[]).filter((l) => l.action !== "mark_duplicate").map((l) =>
      ({
        id: l.id,
        opinionId: l.opinion_id,
        action: l.action as ModerationAction,
        reason: l.reason,
        createdAt: l.created_at,
      }) satisfies ModerationLog
    ),
    filterStats: (stats as unknown as FilterStat[]).map((s) => ({
      day: s.day,
      kind: s.kind,
      count: Number(s.count),
    })),
  };
}

/**
 * Hides an opinion, or shows a hidden one again, and records why. The document's owner only, and
 * allowed after the deadline too — the record stays the owner's to keep in order.
 *
 * @returns The opinion as it now is
 */
export async function moderateOpinion(
  opinionId: string,
  userId: string,
  input: ModerationInput,
): Promise<Opinion> {
  const db = getDb();
  const row = await db.find(opinions, opinionId);
  if (!row) throw new OpinionError(404, "opinion not found");
  await assertOwner(row.document_id, userId);

  const [from, to] = input.action === "hide"
    ? ["published", "hidden"] as const
    : ["hidden", "published"] as const;
  // Conditional, so two owners' tabs cannot both act on the same state.
  const updated = await db.exec(sql`
    UPDATE opinions SET status = ${to}, updated_at = ${now()}
     WHERE id = ${opinionId} AND status = ${from}`);
  if (!updated.affectedRows) {
    throw new OpinionError(
      409,
      input.action === "hide"
        ? "the opinion is not shown"
        : "the opinion is not hidden",
    );
  }
  await db.create(moderationLogs, {
    id: newId(),
    opinion_id: opinionId,
    actor_id: userId,
    action: input.action,
    reason: input.reason,
    duplicate_of: null,
    created_at: now(),
  });

  const { rows = [] } = await db.exec(sql`${SELECT_OPINIONS(userId)}
    WHERE o.id = ${opinionId}`);
  return (await toOpinions(rows as OpinionRow[], userId))[0];
}
