-- Speculum event store (derived index over ~/.amore/sessions).
-- Source of truth remains the session files; this DB is rebuildable via ingest.

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  project_path    TEXT NOT NULL,
  agent           TEXT NOT NULL,         -- 'primary' | 'subagent'
  parent_session  TEXT,
  ts              TEXT NOT NULL,
  kind            TEXT NOT NULL,         -- 'user'|'assistant'|'tool_use'|'tool_result'|'system'|'usage'|'plan'|'task'
  text            TEXT,
  tool_name       TEXT,
  tool_input      TEXT,
  tool_output     TEXT,
  tool_error      INTEGER,
  tool_call_id    TEXT,
  is_boilerplate  INTEGER NOT NULL DEFAULT 0,
  sensitive       INTEGER NOT NULL DEFAULT 0,
  raw             TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_path, ts);
CREATE INDEX IF NOT EXISTS idx_events_kind    ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_tool    ON events(tool_name);

CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  project_path     TEXT NOT NULL,
  agent            TEXT NOT NULL,
  parent_session   TEXT,
  model_id         TEXT,
  started_at       TEXT NOT NULL,
  ended_at         TEXT NOT NULL,
  turn_count       INTEGER NOT NULL,
  user_msg_count   INTEGER NOT NULL,
  tool_call_count  INTEGER NOT NULL,
  tool_error_count INTEGER NOT NULL,
  title            TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path, started_at);

-- Per-session title side store (derived from summary.json session_summary at ingest).
-- sessions.title is joined from this table during rebuildSessions; never hand-maintained.
CREATE TABLE IF NOT EXISTS session_titles (
  session_id  TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT ''
);

-- Per-turn usage from turn_completed.usage (counts/tokens only; no prices).
CREATE TABLE IF NOT EXISTS usage (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  project_path        TEXT NOT NULL,
  ts                  TEXT NOT NULL,
  model_id            TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_read_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  num_turns           INTEGER NOT NULL DEFAULT 0,
  model_calls         INTEGER NOT NULL DEFAULT 0,
  raw                 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_model   ON usage(model_id);
CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage(ts);

CREATE TABLE IF NOT EXISTS ingest_state (
  file_path     TEXT PRIMARY KEY,
  size_bytes    INTEGER NOT NULL,
  mtime         TEXT NOT NULL,
  byte_offset   INTEGER NOT NULL,
  last_ingested TEXT NOT NULL,
  forgotten     INTEGER NOT NULL DEFAULT 0
);

-- Sparse FTS5 index over event text/tool fields (rowid = events.id).
-- Standalone (not external-content): kept in sync by ingest/forget; rebuildable.
-- Re-derived on ingest; cleared on forget / ingest --full. Not source of truth.
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  text,
  tool_name,
  tool_input,
  tool_output
);

-- Typed event links (derived; rebuilt on every ingest post-pass, never hand-maintained).
-- kind: GENERATED | USED | PRECEDENT_FOR (| CAUSED | INFLUENCED when clear)
-- method: tool_call_id | artifact_path | plan_text_match | ...
-- heuristic=1 means method is non-deterministic; always surface the method banner.
CREATE TABLE IF NOT EXISTS event_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_id  INTEGER NOT NULL,
  target_event_id  INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  method           TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 1.0,
  heuristic        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_event_id, target_event_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_event_links_source ON event_links(source_event_id);
CREATE INDEX IF NOT EXISTS idx_event_links_target ON event_links(target_event_id);
CREATE INDEX IF NOT EXISTS idx_event_links_kind ON event_links(kind);

-- Heuristic decisions distilled from events (derived; rebuilt on ingest post-pass).
-- Not a compliance product. method is a required heuristic banner.
CREATE TABLE IF NOT EXISTS decisions (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  project_path     TEXT NOT NULL,
  ts               TEXT NOT NULL,
  category         TEXT NOT NULL,
  scenario         TEXT,
  reasoning        TEXT,
  outcome          TEXT,
  confidence       REAL,
  decision_maker   TEXT,
  source_event_id  INTEGER,
  method           TEXT NOT NULL,
  metadata         TEXT
);

CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);
CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source_event_id);
