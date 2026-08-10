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
  tool_error_count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path, started_at);

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
