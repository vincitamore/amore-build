// Headless char-frame smoke for SessionsMember against a multi-verb fake SPECULUM_BIN.
// Run: bun run src/members/sessions-smoke.tsx
// Renders the member DIRECTLY (not through Shell) — self-contained from any cwd.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { SessionsMember } from './SessionsMember';

const W = Number(process.env.SMOKE_W ?? 120);
const H = Number(process.env.SMOKE_H ?? 32);

const STATUS_READY = {
  counts: { sessions: 3, events: 40, usageRows: 12 },
  ingest: { lastIngestedAt: '2026-05-01T10:00:00.000Z' },
  staleness: { stale: false, thresholdHours: 72, hoursSinceNewestSession: 1 },
};

const SCAN = [
  {
    probe: 'apology-rate',
    value: 0.08,
    ciLow: 0.03,
    ciHigh: 0.18,
    n: 50,
    partial: false,
    unit: 'msg',
    summary: '4 self-corrections / 50 assistant messages [heuristic]',
    data: {},
    hits: [
      {
        sessionId: 'smoke-sess',
        ts: '2026-01-02T12:00:00.000Z',
        category: 'self-correction',
        evidence: 'apologies for the confusion on that step',
      },
    ],
    heuristic: true,
  },
  {
    probe: 'stuck-loop',
    value: 2,
    ciLow: 0.1,
    ciHigh: 0.4,
    n: 10,
    partial: false,
    unit: 'session',
    summary: '2 loops across 2 of 10 sessions [heuristic]',
    data: {},
    hits: [],
    heuristic: true,
  },
];

const USAGE = {
  window: { since: null, until: null },
  models: [
    {
      model: 'smoke-model',
      turns: 10,
      sessions: 2,
      tokens: {
        input: 1500,
        output: 2500,
        cachedRead: 200,
        reasoning: 50,
        total: 4250,
      },
    },
  ],
  totals: {
    turns: 10,
    sessions: 2,
    tokens: {
      input: 1500,
      output: 2500,
      cachedRead: 200,
      reasoning: 50,
      total: 4250,
    },
  },
  note: 'Token and turn counts only. No price table in v1 — provider prices vary per user.',
};

const AUDIT = {
  path: '/tmp/audit.jsonl',
  n: 0,
  records: [],
};

const tmp = mkdtempSync(join(tmpdir(), 'sessions-smoke-'));
const prevBin = process.env.SPECULUM_BIN;
const prevDb = process.env.SPECULUM_DB;

/**
 * Synthetic index for the query-service stages (Microscope/Map/Search open it
 * read-only at mount, even while hidden). v4 shape, stamped user_version 4 —
 * the version the query-service's SUPPORTED_SCHEMA_VERSIONS gate accepts.
 */
function seedIndex(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project_path TEXT NOT NULL,
      agent TEXT NOT NULL, parent_session TEXT, ts TEXT NOT NULL, kind TEXT NOT NULL, text TEXT,
      tool_name TEXT, tool_input TEXT, tool_output TEXT, tool_error INTEGER,
      tool_call_id TEXT, is_boilerplate INTEGER NOT NULL DEFAULT 0,
      sensitive INTEGER NOT NULL DEFAULT 0, raw TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_path TEXT NOT NULL, agent TEXT NOT NULL, parent_session TEXT,
      model_id TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
      turn_count INTEGER NOT NULL, user_msg_count INTEGER NOT NULL,
      tool_call_count INTEGER NOT NULL, tool_error_count INTEGER NOT NULL
    );
    CREATE TABLE usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project_path TEXT NOT NULL,
      ts TEXT NOT NULL, model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_read_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, num_turns INTEGER NOT NULL DEFAULT 0,
      model_calls INTEGER NOT NULL DEFAULT 0, raw TEXT NOT NULL
    );
    CREATE TABLE ingest_state (
      file_path TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, mtime TEXT NOT NULL,
      byte_offset INTEGER NOT NULL, last_ingested TEXT NOT NULL, forgotten INTEGER NOT NULL DEFAULT 0
    );
    CREATE VIRTUAL TABLE events_fts USING fts5(text, tool_name, tool_input, tool_output);
    PRAGMA user_version = 4;
  `);
  db.run(
    `INSERT INTO sessions (id, project_path, agent, started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count)
     VALUES ('smoke-sess', '/house/proj', 'primary', '2026-01-02T11:00:00.000Z', '2026-01-02T13:00:00.000Z', 3, 2, 2, 1)`,
  );
  db.run(
    `INSERT INTO events (session_id, project_path, agent, ts, kind, text, tool_name, tool_error, is_boilerplate, sensitive, raw)
     VALUES ('smoke-sess', '/house/proj', 'primary', '2026-01-02T11:00:00.000Z', 'user', 'debug the loop', NULL, NULL, 0, 0, '{}')`,
  );
  db.run(
    `INSERT INTO events (session_id, project_path, agent, ts, kind, text, tool_name, tool_error, is_boilerplate, sensitive, raw)
     VALUES ('smoke-sess', '/house/proj', 'primary', '2026-01-02T12:00:00.000Z', 'tool_error', NULL, 'run-scan', 'boom', 0, 0, '{}')`,
  );
  db.run(`INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
         SELECT id, text, tool_name, tool_input, tool_output FROM events`);
  db.close();
}

function writeReadyBin(): string {
  const mjs = join(tmp, 'fake-ready.mjs');
  writeFileSync(
    mjs,
    [
      `const verb = process.argv[2];`,
      `if (verb === 'status') { console.log(JSON.stringify(${JSON.stringify(STATUS_READY)})); process.exit(0); }`,
      `if (verb === 'scan') { console.log(JSON.stringify(${JSON.stringify(SCAN)})); process.exit(0); }`,
      `if (verb === 'usage') { console.log(JSON.stringify(${JSON.stringify(USAGE)})); process.exit(0); }`,
      `if (verb === 'audit') { console.log(JSON.stringify(${JSON.stringify(AUDIT)})); process.exit(0); }`,
      `console.error('unknown verb ' + verb); process.exit(2);`,
      ``,
    ].join('\n'),
    'utf8',
  );
  if (process.platform === 'win32') {
    const bin = join(tmp, 'fake-ready.cmd');
    writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`, 'utf8');
    return bin;
  }
  const bin = join(tmp, 'fake-ready');
  writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${mjs}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
  return bin;
}

function cleanup() {
  if (prevBin === undefined) delete process.env.SPECULUM_BIN;
  else process.env.SPECULUM_BIN = prevBin;
  if (prevDb === undefined) delete process.env.SPECULUM_DB;
  else process.env.SPECULUM_DB = prevDb;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// The query-service stages read a synthetic index (never the live one).
const indexPath = join(tmp, 'speculum.sqlite');
seedIndex(indexPath);
process.env.SPECULUM_DB = indexPath;

// ── Run 1: ready corpus ──
process.env.SPECULUM_BIN = writeReadyBin();

const {
  renderer,
  renderOnce,
  captureCharFrame,
} = await createTestRenderer({ width: W, height: H });
const keys = createMockKeys(renderer);
const root = createRoot(renderer);
root.render(
  <ThemeProvider initial="horizon">
    <SessionsMember inputActive />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 900));
await renderOnce();
const frameReady = captureCharFrame();
console.log('--- ready frame ---');
console.log(frameReady);

const hasReadyStrip = /installed · 3 sessions|3 sessions/.test(frameReady);
const hasProbes = /apology-rate/.test(frameReady);
const hasHeuristic = /\[heuristic\]/.test(frameReady);
const hasChips = /Probes/.test(frameReady) && /Usage/.test(frameReady);
const hasExplorationChips = /Microscope/.test(frameReady) && /Map/.test(frameReady) && /Search/.test(frameReady);
const hasBorders = /[┌┐└┘─│]/.test(frameReady);

// Stage switch: u → Usage
await keys.pressKey('u');
await new Promise((r) => setTimeout(r, 700));
await renderOnce();
const frameUsage = captureCharFrame();
console.log('--- usage frame ---');
console.log(frameUsage);

const hasUsageNote = /Token and turn counts only|No price table/.test(frameUsage);
const hasModel = /smoke-model/.test(frameUsage);
const hasTokens = /1\.5K|2\.5K|4\.3K|4\.2K/.test(frameUsage);

renderer.destroy();

// ── Run 2: not-installed ──
process.env.SPECULUM_BIN = join(tmp, 'no-such-speculum-binary');

const {
  renderer: r2,
  renderOnce: render2,
  captureCharFrame: capture2,
} = await createTestRenderer({ width: W, height: H });
createRoot(r2).render(
  <ThemeProvider initial="horizon">
    <SessionsMember inputActive />
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 600));
await render2();
const frameNi = capture2();
console.log('--- not-installed frame ---');
console.log(frameNi);

const hasInstallRecipe = /amore init --with-speculum/.test(frameNi);
const hasNotInstalled = /not installed/i.test(frameNi);

r2.destroy();
cleanup();

const checks = {
  readyStrip: hasReadyStrip,
  probes: hasProbes,
  heuristic: hasHeuristic,
  chips: hasChips,
  explorationChips: hasExplorationChips,
  borders: hasBorders,
  usageNote: hasUsageNote,
  model: hasModel,
  tokens: hasTokens,
  installRecipe: hasInstallRecipe,
  notInstalled: hasNotInstalled,
};

console.log('\n' + Object.entries(checks).map(([k, v]) => `${k}:${v}`).join('  '));

const ok = Object.values(checks).every(Boolean);
process.exit(ok ? 0 : 1);
