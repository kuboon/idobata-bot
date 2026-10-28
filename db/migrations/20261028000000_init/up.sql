-- idobata-bot の初期スキーマ。設計は docs/design.md §9。
-- 時刻はすべて UTC の ISO 8601 文字列（TEXT）。ID は TEXT（アプリが生成）。

CREATE TABLE users (
  id TEXT PRIMARY KEY, -- id.kbn.one の userId（jws の sub）
  nickname TEXT NOT NULL,
  role TEXT, -- NULL | 'sysad'（後で）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  closes_at TEXT, -- 募集期日。NULL は無期限
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'released')),
  source_md TEXT NOT NULL,
  release_note TEXT NOT NULL DEFAULT '',
  released_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, number)
);

CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  segment_key TEXT NOT NULL, -- 版をまたいで安定
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('heading', 'paragraph', 'list', 'table', 'code', 'quote')
  ),
  text TEXT NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '',
  UNIQUE (version_id, segment_key),
  UNIQUE (version_id, ord)
);

CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  from_version_id TEXT NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  to_version_id TEXT NOT NULL REFERENCES versions (id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'removed', 'modified')),
  from_segment_key TEXT,
  to_segment_key TEXT,
  diff_json TEXT NOT NULL
);
CREATE INDEX changes_to_version_idx ON changes (to_version_id, ord);

CREATE TABLE opinions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions (id), -- 投稿時の版
  author_id TEXT NOT NULL REFERENCES users (id),
  title TEXT NOT NULL,
  claim TEXT NOT NULL,
  reason TEXT NOT NULL,
  suggestion TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (
    status IN ('published', 'adopted', 'hidden')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX opinions_document_idx ON opinions (document_id, created_at);
CREATE INDEX opinions_author_idx ON opinions (author_id, created_at);

-- 意見の表明: 何に対する、どういう表明か（§5）。
CREATE TABLE opinion_targets (
  id TEXT PRIMARY KEY,
  opinion_id TEXT NOT NULL REFERENCES opinions (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('segment', 'document', 'opinion')),
  segment_key TEXT,
  target_opinion_id TEXT REFERENCES opinions (id),
  stance TEXT NOT NULL CHECK (
    stance IN ('concern', 'proposal', 'support', 'question', 'objection')
  ),
  CHECK (
    (kind = 'segment' AND segment_key IS NOT NULL AND target_opinion_id IS NULL)
    OR (kind = 'document' AND segment_key IS NULL AND target_opinion_id IS NULL)
    OR (kind = 'opinion' AND segment_key IS NULL AND target_opinion_id IS NOT NULL)
  )
);
CREATE INDEX opinion_targets_opinion_idx ON opinion_targets (opinion_id);
CREATE INDEX opinion_targets_target_idx ON opinion_targets (target_opinion_id);

CREATE TABLE supports (
  opinion_id TEXT NOT NULL REFERENCES opinions (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (opinion_id, user_id)
);

CREATE TABLE adoptions (
  change_id TEXT NOT NULL REFERENCES changes (id) ON DELETE CASCADE,
  opinion_id TEXT NOT NULL REFERENCES opinions (id),
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (change_id, opinion_id)
);

-- モデレーションの記録。公開する。
CREATE TABLE moderation_logs (
  id TEXT PRIMARY KEY,
  opinion_id TEXT NOT NULL REFERENCES opinions (id),
  actor_id TEXT NOT NULL REFERENCES users (id),
  action TEXT NOT NULL CHECK (action IN ('hide', 'unhide', 'mark_duplicate')),
  reason TEXT NOT NULL,
  duplicate_of TEXT REFERENCES opinions (id),
  created_at TEXT NOT NULL
);
CREATE INDEX moderation_logs_opinion_idx ON moderation_logs (opinion_id);

-- 前段フィルタで弾いた件数（発言の本文は残さない）。
CREATE TABLE filter_stats (
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  day TEXT NOT NULL, -- YYYY-MM-DD (UTC)
  kind TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, day, kind)
);
