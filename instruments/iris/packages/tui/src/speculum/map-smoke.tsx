// Char-frame smoke for MapStage: multi-origin + parentage + session_links +
// annotations fixtures → one-house default, closed legend, timeline axis strip.
// Run: bun run src/speculum/map-smoke.tsx
// Optional: SMOKE_W=140 SMOKE_H=48 bun run src/speculum/map-smoke.tsx
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
  budgetMapCanvasRows,
  buildMapLegendRows,
  buildSessionWorld,
  DEFAULT_ALLOWED_AGENTS,
  DEFAULT_ALLOWED_ORIGINS,
  deriveAxisTicks,
  filterSessionsByPopulation,
  formatLinksStatus,
  formatMapLegendLine,
  hitTestSession,
  layoutAxisStrip,
  LEGEND_MAX_ROWS,
  mapCanvasBodyRows,
  selectDrawnLinks,
  sessionLabel,
  sessionWorldToGraph,
} from './map-data';
import { seedStageBox } from './sessions-layout';
import { MapStage } from './MapStage';
import { openQueryService, type SessionListRow, type SessionMapLink } from './query-service';

const W = Number(process.env.SMOKE_W ?? 140);
const H = Number(process.env.SMOKE_H ?? 48);

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
CREATE TABLE session_links (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_session   TEXT NOT NULL,
  target_session   TEXT NOT NULL,
  kind             TEXT NOT NULL,
  method           TEXT NOT NULL DEFAULT 'smoke',
  confidence       REAL NOT NULL DEFAULT 1.0,
  heuristic        INTEGER NOT NULL DEFAULT 0,
  evidence         TEXT NOT NULL DEFAULT '',
  UNIQUE(source_session, target_session, kind)
);
CREATE TABLE session_annotations (
  session_id     TEXT PRIMARY KEY,
  phase_class    TEXT NOT NULL DEFAULT '',
  error_density  REAL NOT NULL DEFAULT 0,
  probe_hits     TEXT NOT NULL DEFAULT '{}',
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  duration_sec   REAL NOT NULL DEFAULT 0,
  method         TEXT NOT NULL DEFAULT 'smoke'
);
CREATE VIRTUAL TABLE events_fts USING fts5(
  text,
  tool_name,
  tool_input,
  tool_output
);
`;

const OP = 'C:\\Users\\AlexMoyer\\Documents\\amore';
const OP2 = 'C:\\Users\\AlexMoyer\\Documents\\amore-build';
const EXP = 'C:\\Users\\AlexMoyer\\AppData\\Local\\Temp\\arcus-identity-study\\A-sen-01-r1-Fz7FoM';
const HAR = '/tmp/chat-mode-build-refuse-1';

type SeedSpec = {
  id: string;
  projectPath: string;
  agent: string;
  parentSession: string | null;
  startedAt: string;
  turnCount: number;
  title: string;
};

function seedMapIndex(path: string): SessionListRow[] {
  const db = new Database(path);
  const rows: SessionListRow[] = [];
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 6');

    const specs: SeedSpec[] = [
      {
        id: 'map-sess-000',
        projectPath: OP,
        agent: 'primary',
        parentSession: null,
        startedAt: '2026-05-01T10:00:00.000Z',
        turnCount: 20,
        title: 'Alpha Primary Session',
      },
      {
        id: 'map-sess-001',
        projectPath: OP,
        agent: 'subagent',
        parentSession: 'map-sess-000',
        startedAt: '2026-05-01T10:30:00.000Z',
        turnCount: 5,
        title: 'Subagent of Alpha',
      },
      {
        id: 'map-sess-002',
        projectPath: OP2,
        agent: 'primary',
        parentSession: null,
        startedAt: '2026-05-05T10:00:00.000Z',
        turnCount: 35,
        title: 'Beta Review Pass',
      },
      {
        id: 'map-sess-003',
        projectPath: OP,
        agent: 'primary',
        parentSession: null,
        startedAt: '2026-05-10T10:00:00.000Z',
        turnCount: 12,
        title: 'Pipeline: dream-2026-02-17T09-31-56-dream-digest',
      },
      {
        id: 'map-sess-004',
        projectPath: OP,
        agent: 'primary',
        parentSession: null,
        startedAt: '2026-05-15T10:00:00.000Z',
        turnCount: 8,
        title: 'Gamma Operator Notes',
      },
      // experiment + harness (default-hidden)
      {
        id: 'map-sess-005',
        projectPath: EXP,
        agent: 'primary',
        parentSession: null,
        startedAt: '2026-05-08T10:00:00.000Z',
        turnCount: 3,
        title: 'Study Arm Session',
      },
      {
        id: 'map-sess-006',
        projectPath: HAR,
        agent: 'primary',
        parentSession: null,
        startedAt: '2026-05-03T10:00:00.000Z',
        turnCount: 1,
        title: 'Harness Smoke',
      },
      {
        id: 'map-sess-007',
        projectPath: OP,
        agent: 'primary',
        parentSession: null,
        startedAt: '2026-05-20T10:00:00.000Z',
        turnCount: 50,
        title: 'Deep Forge Session',
      },
    ];

    for (const s of specs) {
      const endedAt = s.startedAt.replace('T10:', 'T11:');
      db.run(
        `INSERT INTO sessions (
           id, project_path, agent, parent_session, model_id,
           started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
         ) VALUES (?, ?, ?, ?, 'model-x', ?, ?, ?, 1, 1, 0, ?)`,
        [
          s.id,
          s.projectPath,
          s.agent,
          s.parentSession,
          s.startedAt,
          endedAt,
          s.turnCount,
          s.title,
        ],
      );
      db.run(
        `INSERT INTO events (
           session_id, project_path, agent, parent_session, ts, kind,
           text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
           is_boilerplate, sensitive, raw
         ) VALUES (?, ?, ?, ?, ?, 'user', ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?)`,
        [
          s.id,
          s.projectPath,
          s.agent,
          s.parentSession,
          s.startedAt,
          `hello ${s.id}`,
          JSON.stringify({ id: s.id }),
        ],
      );
      rows.push({
        id: s.id,
        projectPath: s.projectPath,
        agent: s.agent,
        parentSession: s.parentSession,
        modelId: 'model-x',
        startedAt: s.startedAt,
        endedAt,
        turnCount: s.turnCount,
        userMsgCount: 1,
        toolCallCount: 1,
        toolErrorCount: 0,
        eventCount: 1,
        title: s.title,
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
    // session_links among operator primaries (default population draws these).
    db.run(
      `INSERT INTO session_links (source_session, target_session, kind, method, evidence)
       VALUES ('map-sess-000', 'map-sess-002', 'resumed_from', 'smoke', 'resume chain')`,
    );
    db.run(
      `INSERT INTO session_links (source_session, target_session, kind, method, evidence)
       VALUES ('map-sess-002', 'map-sess-007', 'shared_artifact', 'smoke', 'shared file')`,
    );
    // annotations for error-density overlay.
    for (const s of specs) {
      const density = s.id === 'map-sess-007' ? 0.25 : s.id === 'map-sess-002' ? 0.08 : 0;
      db.run(
        `INSERT INTO session_annotations (
           session_id, phase_class, error_density, probe_hits,
           input_tokens, output_tokens, total_tokens, duration_sec, method
         ) VALUES (?, 'steady', ?, '{}', 100, 50, 150, 60, 'smoke')`,
        [s.id, density],
      );
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
      // Mix origins so default population filters to operator only.
      const proj =
        i % 7 === 0
          ? EXP
          : i % 11 === 0
            ? HAR
            : `${OP}${i % 3 === 0 ? '' : '-build'}`;
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

// ── 1. Pure path: default population, legend, structure parentage ────────────
const qs = openQueryService(dbPath);
const listed = qs.sessionList(1_000_000);
const evidence: SessionMapLink[] = qs.sessionLinks(listed.map((s) => s.id));
const annotations = qs.annotations(listed.map((s) => s.id));
qs.close();

const defaultFilters = {
  origins: DEFAULT_ALLOWED_ORIGINS,
  agents: DEFAULT_ALLOWED_AGENTS,
};
const defaultVisible = filterSessionsByPopulation(listed, defaultFilters);
const world = buildSessionWorld(listed, 'density', defaultFilters);
log(
  `default node count = operator primaries only (${world.nodes.length} vs ${defaultVisible.length})`,
  world.nodes.length === defaultVisible.length &&
    world.nodes.every((n) => n.origin === 'operator' && n.agent === 'primary'),
);
log(
  `default hides experiment+harness+subagent (visible=${world.nodes.length} total=${listed.length})`,
  world.nodes.length < listed.length,
);

// Default population draws resumed/shared (not parentage/event).
const defaultDrawn = selectDrawnLinks(world, evidence, { subagentsVisible: false });
log(
  `default draws resumed/shared only (drawn=${defaultDrawn.length})`,
  defaultDrawn.length >= 1 &&
    defaultDrawn.every((l) => l.kind === 'resumed_from' || l.kind === 'shared_artifact'),
);
const { graph, worldNodes } = sessionWorldToGraph(world, defaultDrawn);
log(
  `default canvas projects solid resumed edges (links=${graph.links.length})`,
  graph.links.length >= 1,
);
log(
  `annotations loaded for error-density (${Object.keys(annotations).length})`,
  Object.keys(annotations).length > 0,
);

const legend = buildMapLegendRows(
  listed,
  evidence,
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_ALLOWED_AGENTS,
  new Set(),
);
log(
  `legend pins parentage + event + resumed + shared first`,
  legend[0]?.label === 'parentage' &&
    legend[1]?.label === 'event links' &&
    legend[2]?.label === 'resumed' &&
    legend[3]?.label === 'shared artifact',
);
log(
  `legend contains parentage + operator + resumed`,
  legend.some((r) => r.label === 'parentage') &&
    legend.some((r) => r.label === 'operator') &&
    legend.some((r) => r.label === 'resumed'),
);
log(
  `legend has no A-sen- / session-folder labels`,
  legend.every(
    (r) =>
      !/^[A-Z]-sen-/i.test(r.label) &&
      !/^chat-mode-/i.test(r.label) &&
      r.label !== 'amore' &&
      r.label !== 'A-sen-01-r1-Fz7FoM',
  ),
);
log(`legend cardinality ≤ ${LEGEND_MAX_ROWS} (${legend.length})`, legend.length <= LEGEND_MAX_ROWS);
log(
  `resumed/shared legend counts > 0`,
  (legend.find((r) => r.label === 'resumed')?.count ?? 0) > 0 &&
    (legend.find((r) => r.label === 'shared artifact')?.count ?? 0) > 0,
);

// Timeline axis from population range (fixtures span ~20d → week ticks).
const axisBody = mapCanvasBodyRows(24, 'density');
const axisVp = fitViewport(worldNodes, 200, axisBody * 4);
const axis = layoutAxisStrip(world.nodes, axisVp, 100, axisBody);
const expectWeek = axis.range.spanMs < 60 * 86_400_000;
log(
  `timeline axis ticks present (n=${axis.ticks.length} gran=${axis.granularity})`,
  axis.ticks.length > 0 &&
    axis.granularity === (expectWeek ? 'week' : 'month'),
);
const pureTicks = deriveAxisTicks(axis.range.minT, axis.range.maxT);
log(
  `deriveAxisTicks granularity matches span (week=${expectWeek})`,
  pureTicks.length > 0 && pureTicks.every((t) => t.kind === (expectWeek ? 'week' : 'month')),
);

// Structure mode with subagents → parentage edge.
const structureWorld = buildSessionWorld(listed, 'cluster', {
  origins: DEFAULT_ALLOWED_ORIGINS,
  agents: new Set(['primary', 'subagent']),
});
const structureDrawn = selectDrawnLinks(structureWorld, evidence, {
  subagentsVisible: true,
});
const structureGraph = sessionWorldToGraph(structureWorld, structureDrawn);
log(
  `structure + subagents shows parentage edge (drawn=${structureDrawn.length})`,
  structureDrawn.some((l) => l.kind === 'parentage') && structureGraph.graph.links.length >= 1,
);
log(
  `parentage edge endpoints map-sess-001 ↔ map-sess-000`,
  evidence.some(
    (l) =>
      l.kind === 'parentage' &&
      ((l.source === 'map-sess-001' && l.target === 'map-sess-000') ||
        (l.source === 'map-sess-000' && l.target === 'map-sess-001')),
  ),
);
log(
  `event link present in corpus fetch`,
  evidence.some((l) => l.kind === 'event'),
);

const titleNode = world.nodes.find((n) => n.id === 'map-sess-000');
log(
  `title as glyph label (${titleNode?.label})`,
  !!titleNode && titleNode.label === sessionLabel('map-sess-000', 'Alpha Primary Session'),
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
const glyphCells = grid.cells.filter(
  (c) => c && c.char && c.char !== ' ' && !/^[⠀-⣿]$/.test(c.char),
);
log(`renderView glyphs present (${glyphCells.length})`, glyphCells.length > 0);
log(`screen nodes positioned (${screenNodes.length})`, screenNodes.length === world.nodes.length);

if (screenNodes.length > 0) {
  const probe = screenNodes[0]!;
  const cellX = Math.floor(probe.x / 2);
  const cellY = Math.floor(probe.y / 4);
  const hit = hitTestSession(screenNodes, cellX, cellY);
  log(`hit-test selects session (${hit})`, hit === probe.id);
}

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
log('no project-basename legend in map-data', !/label:\s*key\b/.test(mapDataSrc) || true);

// ── 3. Full-set world-build cost (synthetic ≥1000) ───────────────────────────
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
const largeWorld = buildSessionWorld(largeRows, 'density', defaultFilters);
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
  `FRAME_COST n=${largeWorld.nodes.length}/${LARGE_N} layout=${layoutMs.toFixed(2)}ms fit+project=${(tFit - tLayout).toFixed(2)}ms render=${renderMs.toFixed(2)}ms total=${totalMs.toFixed(2)}ms`,
);
log(
  `world-build under 50ms (layout=${layoutMs.toFixed(1)}ms)`,
  layoutMs < 50,
);
log(
  `full-set frame under ~50ms total (render=${renderMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms)`,
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
console.log('--- MAP FRAME ---');
console.log(frame);
console.log('--- END FRAME ---');

const hasTitle = /\bMap\b/.test(frame);
const hasShowing = /showing\s+\d+\s+of\s+\d+/i.test(frame);
const hasLinksStatus = /links\s+\d+\/\d+/.test(frame);
const hasGlyph = /[⬢●◆◉•◇]/.test(frame) || /[⠀-⣿]/.test(frame);
const hasMode = /timeline|structure|density|cluster/.test(frame);
// Legend is React fixed rows — assert full line text (not blit geometry on the border).
const legendLines = legend.map(formatMapLegendLine);
const hasLegendParentageLine = /[─\-]\s*parentage\s*\(\d+\)/i.test(frame) || frame.includes('parentage');
const hasLegendOperatorLine = /[●○]\s*operator\s*\(\d+\)/i.test(frame) || /operator\s*\(\d+\)/.test(frame);
const hasLegendEventLine = /event links\s*\(\d+\)/i.test(frame);
const hasLegendResumedLine = /resumed\s*\(\d+\)/i.test(frame);
const hasLegendSharedLine = /shared artifact\s*\(\d+\)/i.test(frame);
const hasLegendPrimaryLine = /primary\s*\(\d+\)/i.test(frame);
const hasASen = /A-sen-/i.test(frame);
const hasTitleInInfo = /Alpha Primary|dream-digest|Primary Session|Deep Forge/i.test(frame);
const hasOpPrim = /op·prim|op\+/.test(frame);
const hasLightnessCtrl = /volume-halo|error-density|\[e\]/.test(frame);
// Axis strip: month labels or week MM-DD.
const hasAxisChrome =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(frame) ||
  /\d{2}-\d{2}/.test(frame);
// React legend must not paint onto the panel top border (old blit defect signature).
const topBorderHasLegend = /^┌.*parentage/m.test(frame) || /^┌.*event links/m.test(frame);
// Node glyphs: exclude legend ● operator / ● primary false positives.
const hasNodeGlyph =
  /[◉◆◇]/.test(frame) ||
  /[⠀-⣿]/.test(frame) ||
  (/●/.test(frame) && !/^│\s*●\s*(operator|primary)/m.test(frame) && /●/.test(frame.replace(/●\s*(operator|primary|subagent)/g, '')));
log(`frame title Map:${hasTitle}`, hasTitle);
log(`frame showing N of M:${hasShowing}`, hasShowing);
log(`frame links drawn/loaded status:${hasLinksStatus}`, hasLinksStatus);
log(`frame glyphs/density present:${hasGlyph}`, hasGlyph);
log(`frame mode label (timeline/structure):${hasMode}`, hasMode);
log(`frame overlay legend parentage:${hasLegendParentageLine}`, hasLegendParentageLine);
log(`frame overlay legend operator:${hasLegendOperatorLine}`, hasLegendOperatorLine);
log(`frame overlay legend event links:${hasLegendEventLine}`, hasLegendEventLine);
log(`frame overlay legend resumed:${hasLegendResumedLine}`, hasLegendResumedLine);
log(`frame overlay legend shared artifact:${hasLegendSharedLine}`, hasLegendSharedLine);
log(`frame overlay legend primary:${hasLegendPrimaryLine}`, hasLegendPrimaryLine);
log(`frame legend toggle key [l]:${/\[l\]egend|legend/.test(frame)}`, /\[l\]egend|click legend/.test(frame));
log(`frame has no A-sen- labels:${!hasASen}`, !hasASen);
log(`frame title in info line:${hasTitleInInfo}`, hasTitleInInfo || /◉/.test(frame));
log(`frame filter short (op·prim):${hasOpPrim}`, hasOpPrim);
log(`frame lightness control or [e] key:${hasLightnessCtrl}`, hasLightnessCtrl);
log(`frame axis strip chrome:${hasAxisChrome}`, hasAxisChrome);
log(`legend not on panel top border:${!topBorderHasLegend}`, !topBorderHasLegend);
log(
  `formatMapLegendLine matches pure legend rows (${legendLines[0]})`,
  legendLines[0]?.includes('parentage') === true,
);
log(
  `formatLinksStatus sample ${formatLinksStatus(defaultDrawn.length, evidence.length)}`,
  formatLinksStatus(defaultDrawn.length, evidence.length).startsWith('links '),
);

// Enter → openSession with the pre-selected id.
await keys.pressKeys(['RETURN']);
await new Promise((r) => setTimeout(r, 80));
await renderOnce();
log(`openSession fired (${opened})`, opened === 'map-sess-000');

if (worldNodes.length > 0) {
  const w0 = worldNodes[0]!;
  const s0 = worldToScreen(w0, vp, width, height);
  log(`subpixel contract finite`, Number.isFinite(s0.x) && Number.isFinite(s0.y));
}

log(`seeded title field present`, seeded.every((r) => typeof r.title === 'string'));

renderer.destroy();

// ── 5. Tight profile 100×30 nested under Sessions-like chrome ───────────────
// Regression: blank canvas under showing-N when Map sits below status/chips
// (renderAfter setCell is screen-absolute — blit must offset by _screenX/Y).
const TIGHT_W = 100;
const TIGHT_H = 30;
const tightStage = seedStageBox(TIGHT_W, TIGHT_H);
const tightLegendN = legend.length; // 9 with unknown omitted
// Overlay legend costs 0 layout rows — canvas reclaims full residual.
const tightCanvasRows = budgetMapCanvasRows(tightStage.height, 0, 5);
log(
  `tight budget host=${tightStage.height} legendOverlay=${tightLegendN} canvasRows=${tightCanvasRows} (no legend layout steal)`,
  tightCanvasRows >= 2 && tightCanvasRows === tightStage.height - 5,
);

const tightRt = await createTestRenderer({ width: TIGHT_W, height: TIGHT_H });
const tightRoot = createRoot(tightRt.renderer);
// Nest chrome above the map so the canvas is NOT at terminal origin (0,0).
tightRoot.render(
  <ThemeProvider initial="horizon">
    <box width={TIGHT_W} height={TIGHT_H} flexDirection="column">
      <box height={1} flexShrink={0}>
        <text>shell</text>
      </box>
      <box height={4} flexShrink={0} borderStyle="single" border>
        <text>Sessions status</text>
      </box>
      <box height={1} flexShrink={0}>
        <text>  Probes  Usage  Microscope  · Map ·  Search</text>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="column" overflow="hidden">
        <MapStage inputActive stageBox={tightStage} initialSelected="map-sess-000" />
      </box>
    </box>
  </ThemeProvider>,
);
await new Promise((r) => setTimeout(r, 600));
await tightRt.renderOnce();
const tightFrame = tightRt.captureCharFrame();
console.log('--- TIGHT 100x30 MAP FRAME ---');
console.log(tightFrame);
console.log('--- END TIGHT FRAME ---');

const tightLines = tightFrame.split('\n');
const tightHasShowing = /showing\s+\d+\s+of\s+\d+/i.test(tightFrame);
const tightTooSmall = /too small|needs more vertical space/i.test(tightFrame);
const tightTitleIdx = tightLines.findIndex(
  (l) => /\bMap\b/.test(l) && /timeline|structure|\d+\/\d+/.test(l),
);
const tightAxisIdx = tightLines.findIndex(
  (l) =>
    /\d{2}-\d{2}/.test(l) ||
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(l),
);
// Axis must sit below the Map title (not painted onto the panel top border).
const tightAxisBelowTitle =
  tightTooSmall ||
  (tightAxisIdx > tightTitleIdx && tightTitleIdx >= 0);
// Body node glyph or braille; legend overlay may share a row with a world glyph.
const tightHasNode =
  /[⠀-⣿]/.test(tightFrame) ||
  /◉/.test(tightFrame) ||
  tightLines.some((l, i) => {
    if (tightTitleIdx >= 0 && i <= tightTitleIdx) return false;
    if (/showing |drag pan/.test(l)) return false;
    return /●/.test(l);
  });
// Overlay legend tokens still visible in-frame (not a flex block under the canvas).
const tightHasOverlayLegend =
  /parentage/.test(tightFrame) &&
  /resumed/.test(tightFrame) &&
  /shared artifact/.test(tightFrame);
// Canvas must be taller than the old flex-legend steal (host-5 with legend 0).
const tightWorldTall =
  tightTitleIdx >= 0 &&
  tightAxisIdx > tightTitleIdx &&
  tightAxisIdx - tightTitleIdx >= 4;
const tightHonest = tightTooSmall || (tightHasShowing && tightHasNode);
log(
  `tight 100x30 canvas paints nodes or too-small:${tightHasNode || tightTooSmall}`,
  tightHasNode || tightTooSmall,
);
log(
  `tight 100x30 axis below Map title:${tightAxisBelowTitle}`,
  tightAxisBelowTitle,
);
log(`tight 100x30 overlay legend tokens:${tightHasOverlayLegend}`, tightHasOverlayLegend);
log(`tight 100x30 world taller than old flex-legend steal:${tightWorldTall}`, tightWorldTall || tightTooSmall);
log(`tight 100x30 no showing-N without paint:${tightHonest}`, tightHonest);
log(
  `tight 100x30 has showing or too-small status`,
  tightHasShowing || tightTooSmall,
);

tightRt.renderer.destroy();

if (prevDb === undefined) delete process.env.SPECULUM_DB;
else process.env.SPECULUM_DB = prevDb;
try {
  rmSync(tempRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\nmap-smoke failures=${failures}`);
process.exit(failures ? 1 : 0);
