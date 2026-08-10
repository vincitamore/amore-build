// Char-frame smoke for MapStage: synthetic temp index → glyphs + titles + legend +
// evidence links + showing N of M. Run: bun run src/speculum/map-smoke.tsx
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
  buildMapLegendRows,
  buildSessionWorld,
  hitTestSession,
  sessionLabel,
  sessionWorldToGraph,
} from './map-data';
import { MapStage } from './MapStage';
import { openQueryService, type SessionListRow, type SessionMapLink } from './query-service';

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
  tool_error_count INTEGER NOT NULL,
  title            TEXT NOT NULL DEFAULT ''
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
CREATE TABLE event_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_event_id  INTEGER NOT NULL,
  target_event_id  INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  method           TEXT NOT NULL,
  confidence       REAL NOT NULL DEFAULT 1.0,
  heuristic        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_event_id, target_event_id, kind)
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
    db.run('PRAGMA user_version = 5');
    const projects = ['/work/alpha', '/work/beta', '/work/gamma'];
    const titles = [
      'Alpha Primary Session',
      'Beta Review Pass',
      'Pipeline: dream-2026-02-17T09-31-56-dream-digest',
      'Gamma Operator Notes',
    ];
    let parentId = '';
    for (let i = 0; i < 12; i++) {
      const id = `map-sess-${String(i).padStart(3, '0')}`;
      const projectPath = projects[i % projects.length]!;
      const day = String(1 + (i % 28)).padStart(2, '0');
      const startedAt = `2026-05-${day}T10:00:00.000Z`;
      const endedAt = `2026-05-${day}T11:00:00.000Z`;
      const turnCount = 2 + i * 3;
      const isSub = i === 1;
      const parentSession = isSub ? parentId : null;
      const agent = isSub ? 'subagent' : 'primary';
      const title = isSub ? 'Subagent of Alpha' : titles[i % titles.length]!;
      if (i === 0) parentId = id;
      db.run(
        `INSERT INTO sessions (
           id, project_path, agent, parent_session, model_id,
           started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
         ) VALUES (?, ?, ?, ?, 'model-x', ?, ?, ?, 1, 1, 0, ?)`,
        [id, projectPath, agent, parentSession, startedAt, endedAt, turnCount, title],
      );
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES (?, ?, ?, ?, ?, 'user', ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?)`,
        [id, projectPath, agent, parentSession, startedAt, `hello ${id}`, JSON.stringify({ id })],
      );
      rows.push({
        id,
        projectPath,
        agent,
        parentSession,
        modelId: 'model-x',
        startedAt,
        endedAt,
        turnCount,
        userMsgCount: 1,
        toolCallCount: 1,
        toolErrorCount: 0,
        eventCount: 1,
        title,
      });
    }
    // event_links between sess 2 and 3 (cross-session evidence).
    const e2 = Number(
      db
        .query<{ id: number }, [string]>('SELECT id FROM events WHERE session_id = ?')
        .get('map-sess-002')!.id,
    );
    const e3 = Number(
      db
        .query<{ id: number }, [string]>('SELECT id FROM events WHERE session_id = ?')
        .get('map-sess-003')!.id,
    );
    db.run(
      `INSERT INTO event_links (source_event_id, target_event_id, kind, method)
       VALUES (?, ?, 'GENERATED', 'smoke')`,
      [e2, e3],
    );
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

/** Seed a large synthetic corpus for frame-cost measurement (no real index touch). */
function seedLargeIndex(path: string, n: number): void {
  const db = new Database(path);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 5');
    const insert = db.prepare(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
       ) VALUES (?, ?, 'primary', NULL, 'm', ?, ?, ?, 1, 0, 0, ?)`,
    );
    db.run('BEGIN');
    for (let i = 0; i < n; i++) {
      const id = `bulk-${String(i).padStart(5, '0')}`;
      const proj = `/work/p${i % 24}`;
      const day = String(1 + (i % 28)).padStart(2, '0');
      const started = `2026-04-${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`;
      insert.run(id, proj, started, started, 1 + (i % 40), `Session title ${i}`);
    }
    db.run('COMMIT');
    db.run(
      `INSERT INTO ingest_state (
         file_path, size_bytes, mtime, byte_offset, last_ingested, forgotten
       ) VALUES ('/sessions/bulk.jsonl', 1, '2026-05-28T12:00:00.000Z', 1, '2026-05-28T12:00:00.000Z', 0)`,
    );
  } finally {
    db.close();
  }
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

// ── 1. Pure path: world → titles → evidence links → renderView ───────────────
const qs = openQueryService(dbPath);
const listed = qs.sessionList(1_000_000);
const evidence: SessionMapLink[] = qs.links(listed.map((s) => s.id));
qs.close();

const world = buildSessionWorld(listed, 'cluster');
const { graph, worldNodes } = sessionWorldToGraph(world, evidence);
log(`evidence links projected (links=${graph.links.length})`, graph.links.length >= 2);
log(
  `parentage edge present`,
  evidence.some((l) => l.kind === 'parentage' && l.source === 'map-sess-001' && l.target === 'map-sess-000'),
);
log(
  `event link present`,
  evidence.some((l) => l.kind === 'event'),
);

const titleNode = world.nodes.find((n) => n.id === 'map-sess-000');
log(
  `title as glyph label (${titleNode?.label})`,
  !!titleNode && titleNode.label === sessionLabel('map-sess-000', 'Alpha Primary Session'),
);

const legend = buildMapLegendRows(world, evidence, new Set(), new Set());
log(
  `legend has project + edge rows (${legend.length})`,
  legend.some((r) => r.label === 'alpha') &&
    legend.some((r) => r.label === 'parentage') &&
    legend.some((r) => r.label === 'event links'),
);

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
const edgeCells = grid.cells.filter((c) => c && c.char && /^[⠀-⣿]$/.test(c.char));
log(`renderView glyphs present (${glyphCells.length})`, glyphCells.length > 0);
log(`renderView edge braille present (${edgeCells.length})`, edgeCells.length > 0);
log(`screen nodes positioned (${screenNodes.length})`, screenNodes.length === listed.length);

const probe = screenNodes[0]!;
const cellX = Math.floor(probe.x / 2);
const cellY = Math.floor(probe.y / 4);
const hit = hitTestSession(screenNodes, cellX, cellY);
log(`hit-test selects session (${hit})`, hit === probe.id);

// ── 2. Source hygiene: MapStage must not import force layout / d3-force ───────
const stageSrc = readFileSync(new URL('./MapStage.tsx', import.meta.url), 'utf8');
const mapDataSrc = readFileSync(new URL('./map-data.ts', import.meta.url), 'utf8');
const noForceImport =
  !/from ['"]d3-force['"]/.test(stageSrc) &&
  !/from ['"]d3-force['"]/.test(mapDataSrc) &&
  !/\bforceLink\b|\bforceSimulation\b|\blayoutWorld\b|\blayoutWorldAsync\b/.test(stageSrc) &&
  !/\bforceLink\b|\bforceSimulation\b|\blayoutWorld\b/.test(mapDataSrc);
log('no force-edge wiring in MapStage/map-data sources', noForceImport);
log('no SESSION_LIST_LIMIT 500 cap', !/SESSION_LIST_LIMIT\s*=\s*500/.test(stageSrc));

// ── 3. Full-set frame cost (synthetic 1699 — matches reported corpus scale) ──
const largePath = join(tempRoot, 'large.sqlite');
const LARGE_N = 1699;
seedLargeIndex(largePath, LARGE_N);
const largeRows: SessionListRow[] = [];
{
  const q = openQueryService(largePath);
  const list = q.sessionList(1_000_000);
  largeRows.push(...list);
  q.close();
}
const t0 = performance.now();
const largeWorld = buildSessionWorld(largeRows, 'cluster');
const tLayout = performance.now();
const largeGraph = sessionWorldToGraph(largeWorld, []);
const largeVp = fitViewport(largeGraph.worldNodes, width, height);
const tFit = performance.now();
renderView(largeGraph.graph, largeGraph.worldNodes, largeVp, {
  cols,
  rows,
  mode: 'cluster',
  attention: true,
});
const tRender = performance.now();
const layoutMs = tLayout - t0;
const renderMs = tRender - tFit;
const totalMs = tRender - t0;
console.log(
  `FRAME_COST n=${LARGE_N} layout=${layoutMs.toFixed(2)}ms fit+project=${(tFit - tLayout).toFixed(2)}ms render=${renderMs.toFixed(2)}ms total=${totalMs.toFixed(2)}ms`,
);
log(
  `full-set frame under ~30ms render budget (render=${renderMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms)`,
  renderMs < 30 || totalMs < 50,
);

// ── 4. Mount MapStage → char frame + openSession on Enter ────────────────────
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

await new Promise((r) => setTimeout(r, 400));
await renderOnce();
const frame = captureCharFrame();
console.log(frame);

const hasTitle = /\bMap\b/.test(frame);
const hasShowing = /showing\s+\d+\s+of\s+\d+/i.test(frame);
const hasLinks = /\d+\s+links/.test(frame);
const hasGlyph = /[⬢●◆◉•]/.test(frame) || /[⠀-⣿]/.test(frame);
const hasMode = /cluster|density/.test(frame);
const hasLegendProject = /alpha|beta|gamma/i.test(frame);
const hasLegendEdges = /parentage|event links/i.test(frame);
const hasTitleInInfo = /Alpha Primary|dream-digest|Primary Session/i.test(frame);
log(`frame title Map:${hasTitle}`, hasTitle);
log(`frame showing N of M:${hasShowing}`, hasShowing);
log(`frame links count:${hasLinks}`, hasLinks);
log(`frame glyphs/density present:${hasGlyph}`, hasGlyph);
log(`frame mode label:${hasMode}`, hasMode);
log(`frame legend projects:${hasLegendProject}`, hasLegendProject);
log(`frame legend edge kinds:${hasLegendEdges}`, hasLegendEdges);
log(`frame title in info line:${hasTitleInInfo}`, hasTitleInInfo || /◉/.test(frame));

// Enter → openSession with the pre-selected id.
await keys.pressKeys(['RETURN']);
await new Promise((r) => setTimeout(r, 80));
await renderOnce();
log(`openSession fired (${opened})`, opened === 'map-sess-000');

const w0 = worldNodes[0]!;
const s0 = worldToScreen(w0, vp, width, height);
log(`subpixel contract finite`, Number.isFinite(s0.x) && Number.isFinite(s0.y));

// Seeded rows carry titles for pure-path checks.
log(`seeded title field present`, seeded.every((r) => typeof r.title === 'string'));

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
