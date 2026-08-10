// Char-frame smoke for MapStage: synthetic temp index → glyphs + hit-test + openSession on Enter.
// Asserts explicitly that no force-edge wiring is present.
// Run: bun run src/speculum/map-smoke.tsx
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { fitViewport, worldToScreen } from '../render/viewport';
import { renderView } from '../render/graph';
import {
  buildSessionWorld,
  hasNoForceEdges,
  hitTestSession,
  sessionWorldToGraph,
} from './map-data';
import { MapStage } from './MapStage';
import type { SessionListRow } from './query-service';

const W = Number(process.env.SMOKE_W ?? 120);
const H = Number(process.env.SMOKE_H ?? 34);

const SYNTHETIC_DDL = `
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  project_path    TEXT NOT NULL,
  agent           TEXT NOT NULL,
  parent_session  TEXT,
  ts              TEXT NOT NULL,
  kind            TEXT NOT NULL,
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
CREATE TABLE sessions (
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
CREATE TABLE usage (
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
CREATE TABLE ingest_state (
  file_path     TEXT PRIMARY KEY,
  size_bytes    INTEGER NOT NULL,
  mtime         TEXT NOT NULL,
  byte_offset   INTEGER NOT NULL,
  last_ingested TEXT NOT NULL,
  forgotten     INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE events_fts USING fts5(
  text,
  tool_name,
  tool_input,
  tool_output
);
`;

function seedMapIndex(path: string): SessionListRow[] {
  const db = new Database(path);
  const rows: SessionListRow[] = [];
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 4');
    const projects = ['/work/alpha', '/work/beta', '/work/gamma'];
    for (let i = 0; i < 12; i++) {
      const id = `map-sess-${String(i).padStart(3, '0')}`;
      const projectPath = projects[i % projects.length];
      const day = String(1 + (i % 28)).padStart(2, '0');
      const startedAt = `2026-05-${day}T10:00:00.000Z`;
      const endedAt = `2026-05-${day}T11:00:00.000Z`;
      const turnCount = 2 + i * 3;
      db.run(
        `INSERT INTO sessions (
           id, project_path, agent, parent_session, model_id,
           started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count
         ) VALUES (?, ?, 'primary', NULL, 'model-x', ?, ?, ?, 1, 1, 0)`,
        [id, projectPath, startedAt, endedAt, turnCount],
      );
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES (?, ?, 'primary', NULL, ?, 'user', ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?)`,
        [id, projectPath, startedAt, `hello ${id}`, JSON.stringify({ id })],
      );
      rows.push({
        id,
        projectPath,
        agent: 'primary',
        parentSession: null,
        modelId: 'model-x',
        startedAt,
        endedAt,
        turnCount,
        userMsgCount: 1,
        toolCallCount: 1,
        toolErrorCount: 0,
        eventCount: 1,
      });
    }
    db.run(
      `INSERT INTO ingest_state (
         file_path, size_bytes, mtime, byte_offset, last_ingested, forgotten
       ) VALUES ('/sessions/map.jsonl', 100, '2026-05-28T12:00:00.000Z', 100, '2026-05-28T12:00:00.000Z', 0)`,
    );
  } finally {
    db.close();
  }
  return rows;
}

const tempRoot = mkdtempSync(join(tmpdir(), 'map-smoke-'));
const dbPath = join(tempRoot, 'speculum.sqlite');
mkdirSync(tempRoot, { recursive: true });
const seeded = seedMapIndex(dbPath);

// SPECULUM_DB before any render (MapStage resolveIndexPath reads env).
const prevDb = process.env.SPECULUM_DB;
process.env.SPECULUM_DB = dbPath;

let failures = 0;
const log = (msg: string, ok: boolean) => {
  console.log(`${ok ? 'OK' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

// ── 1. Pure path: world → renderView → hit-test (no force edges) ─────────────
const world = buildSessionWorld(seeded, 'cluster');
const { graph, worldNodes } = sessionWorldToGraph(world);
log(`no force edges (links=${graph.links.length})`, hasNoForceEdges(graph) && graph.links.length === 0);

const cols = 100;
const rows = 24;
const width = cols * 2;
const height = rows * 4;
const vp = fitViewport(worldNodes, width, height);
const { grid, nodes: screenNodes } = renderView(graph, worldNodes, vp, {
  cols,
  rows,
  mode: 'cluster',
  attention: true,
});
const glyphCells = grid.cells.filter((c) => c && c.char && c.char !== ' ' && !/^[⠀-⣿]$/.test(c.char));
log(`renderView glyphs present (${glyphCells.length})`, glyphCells.length > 0);
log(`screen nodes positioned (${screenNodes.length})`, screenNodes.length === seeded.length);

// Hit-test: pick first on-screen node via its cell.
const probe = screenNodes[0];
const cellX = Math.floor(probe.x / 2);
const cellY = Math.floor(probe.y / 4);
const hit = hitTestSession(screenNodes, cellX, cellY);
log(`hit-test selects session (${hit})`, hit === probe.id);

// Density mode also places without links.
const dens = sessionWorldToGraph(buildSessionWorld(seeded, 'density'));
log(`density mode no links`, hasNoForceEdges(dens.graph));

// ── 2. Source hygiene: MapStage must not import force layout / d3-force ───────
const stageSrc = readFileSync(new URL('./MapStage.tsx', import.meta.url), 'utf8');
const mapDataSrc = readFileSync(new URL('./map-data.ts', import.meta.url), 'utf8');
const noForceImport =
  !/from ['"]d3-force['"]/.test(stageSrc) &&
  !/from ['"]d3-force['"]/.test(mapDataSrc) &&
  !/\bforceLink\b|\bforceSimulation\b|\blayoutWorld\b|\blayoutWorldAsync\b/.test(stageSrc) &&
  !/\bforceLink\b|\bforceSimulation\b|\blayoutWorld\b/.test(mapDataSrc);
log('no force-edge wiring in MapStage/map-data sources', noForceImport);

// ── 3. Mount MapStage → char frame + openSession on Enter ────────────────────
let opened: string | null = null;
const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: W, height: H });
const keys = createMockKeys(renderer);
const root = createRoot(renderer);
root.render(
  <ThemeProvider initial="horizon">
    <MapStage
      inputActive
      initialSelected="map-sess-000"
      onOpenSession={(id) => {
        opened = id;
      }}
    />
  </ThemeProvider>,
);

await new Promise((r) => setTimeout(r, 350));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);

const hasTitle = /\bMap\b/.test(frame);
const hasSessionsStatus = /sessions/.test(frame);
const hasGlyph = /[⬢●◆◉•]/.test(frame) || /[⠀-⣿]/.test(frame);
const hasMode = /cluster|density/.test(frame);
log(`frame title Map:${hasTitle}`, hasTitle);
log(`frame sessions status:${hasSessionsStatus}`, hasSessionsStatus);
log(`frame glyphs/density present:${hasGlyph}`, hasGlyph);
log(`frame mode label:${hasMode}`, hasMode);

// Enter → openSession with the pre-selected id.
await keys.pressKeys(['RETURN']);
await new Promise((r) => setTimeout(r, 80));
await renderOnce();
log(`openSession fired (${opened})`, opened === 'map-sess-000');

// Sanity: worldToScreen used consistently (subpixel contract 2×4).
const w0 = worldNodes[0];
const s0 = worldToScreen(w0, vp, width, height);
log(`subpixel contract finite`, Number.isFinite(s0.x) && Number.isFinite(s0.y));

renderer.destroy();
if (prevDb === undefined) delete process.env.SPECULUM_DB;
else process.env.SPECULUM_DB = prevDb;
try {
  rmSync(tempRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\nmap-smoke failures=${failures}`);
process.exit(failures ? 1 : 0);
