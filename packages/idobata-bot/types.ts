/**
 * The opinion service's API types — the contract between the opinion module (this package) and
 * the service that stores opinions (docs/design.md §2, "3 つの部品"). The service imports these
 * too, so the two cannot drift.
 */

/** 懸念・提案・支持・質問・反対 — what an opinion says about one of its targets. */
export type Stance =
  | "concern"
  | "proposal"
  | "support"
  | "question"
  | "objection";

export const STANCES: readonly Stance[] = [
  "concern",
  "proposal",
  "support",
  "question",
  "objection",
];

/** The Japanese word for a stance, as the UI shows it. */
export const STANCE_LABELS: Readonly<Record<Stance, string>> = {
  concern: "懸念",
  proposal: "提案",
  support: "支持",
  question: "質問",
  objection: "反対",
};

/** What an opinion is about: a segment, the whole document, or another opinion. */
export type TargetRef =
  | { kind: "segment"; segmentKey: string }
  | { kind: "document" }
  | { kind: "opinion"; opinionId: string };

/** One thing an opinion says about one target — "段落 3 への懸念". */
export type Target = TargetRef & { stance: Stance };

/** What a user writes: the body of an opinion and what it is about. */
export interface OpinionInput {
  /** One line, the gist. */
  title: string;
  claim: string;
  reason: string;
  /** A concrete change to the text, if the opinion proposes one. */
  suggestion?: string;
  /** At least one. */
  targets: Target[];
}

/** `hidden` only ever reaches the owner's view and the author's own list. */
export type OpinionStatus = "published" | "adopted" | "hidden";

/** An opinion as the service hands it out. */
export interface Opinion {
  id: string;
  documentId: string;
  /** The version number it was written against. */
  version: number;
  author: { id: string; nickname: string };
  title: string;
  claim: string;
  reason: string;
  suggestion: string;
  targets: Target[];
  status: OpinionStatus;
  supportCount: number;
  /** How many other opinions name this one as a target. */
  incomingCount: number;
  /**
   * No longer one person's opinion — supported, named by another opinion, or adopted — so it can
   * be neither edited nor deleted (docs/design.md §5). Worked out at the moment it is read.
   */
  frozen: boolean;
  /** Whether the signed-in caller supports it; `false` when signed out. */
  supportedByMe: boolean;
  /** Whether the signed-in caller wrote it. */
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

/** An opinion with the opinions that name it as a target. */
export interface OpinionDetail extends Opinion {
  incoming: Opinion[];
}

/** `GET` of a document's opinions. */
export interface OpinionList {
  opinions: Opinion[];
  /** Opinions the owner hid: counted, so they are not silently gone (docs/design.md §5). */
  hiddenCount: number;
}

/** What a document's owner can do to an opinion. Always with a reason, which is public. */
export type ModerationAction = "hide" | "unhide";

/** `POST` of a moderation. */
export interface ModerationInput {
  action: ModerationAction;
  reason: string;
}

/** One moderation, as the record keeps it. */
export interface ModerationLog {
  id: string;
  opinionId: string;
  action: ModerationAction;
  reason: string;
  createdAt: string;
}

/** Messages the chat's pre-filter turned away, per day (UTC) and kind. Counted, never kept. */
export interface FilterStat {
  day: string;
  kind: string;
  count: number;
}

/** `GET` of a document's opinions for its owner: hidden ones too, and the record. */
export interface OwnerView {
  opinions: Opinion[];
  moderation: ModerationLog[];
  filterStats: FilterStat[];
}
