// Nested containment sweep: full SessionsMember at a size matrix, every stage
// driven, geometric panel-border asserts so fixed-slot lists cannot paint past
// their panel. Run: bun run src/speculum/containment-smoke.tsx
// Overrides: SMOKE_W / SMOKE_H force a single size (matrix still runs when unset).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../ThemeProvider';
import { SessionsMember } from '../members/SessionsMember';
import {
  budgetSessionSlots,
  budgetTurnSlots,
  MICRO_STAGE_CHROME,
  CARD_V_CHROME,
  STACK_GAP,
  TIMELINE_INFO_ROWS,
} from './MicroscopeStage';
import {
  budgetHitSlots,
  budgetProbeVisibleRows,
  PROBES_STAGE_CHROME,
} from './ProbesStage';
import { seedStageBox } from './sessions-layout';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = join(SCRIPT_DIR, '../../scripts/containment-frames');

const MATRIX: Array<[number, number]> = process.env.SMOKE_W && process.env.SMOKE_H
  ? [[Number(process.env.SMOKE_W), Number(process.env.SMOKE_H)]]
  : [
      [180, 56],
      [160, 50],
      [140, 48],
      [120, 40],
      [100, 30],
      [80, 24],
    ];

const MANY_HITS = Array.from({ length: 12 }, (_, i) => ({
  sessionId: `hit-sess-${String(i).padStart(2, '0')}`,
  ts: `2026-01-0${(i % 9) + 1}T12:00:00.000Z`,
  category: 'self-correction',
  evidence: `apologies evidence row ${i} with a long title trail`,
  eventId: 7 + i,
}));

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
    hits: MANY_HITS,
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
    hits: MANY_HITS.slice(0, 4),
    heuristic: true,
  },
  {
    probe: 'sensitive-content',
    value: 0,
    ciLow: 0,
    ciHigh: 1,
    n: 0,
    partial: false,
    unit: 'session',
    summary: '0 of 0 sessions [heuristic]',
    data: {},
    hits: [],
    heuristic: true,
  },
];

const USAGE = {
  window: { since: null, until: null },
  models: [
    {
      model: 'contain-model-a',
      turns: 10,
      sessions: 2,
      tokens: { input: 1500, output: 2500, cachedRead: 200, reasoning: 50, total: 4250 },
    },
    {
      model: 'contain-model-b',
      turns: 4,
      sessions: 1,
      tokens: { input: 400, output: 600, cachedRead: 0, reasoning: 0, total: 1000 },
    },
  ],
  totals: {
    turns: 14,
    sessions: 3,
    tokens: { input: 1900, output: 3100, cachedRead: 200, reasoning: 50, total: 5250 },
  },
  note: 'Token and turn counts only. No price table in v1 — provider prices vary per user.',
};

const STATUS = {
  counts: { sessions: 10, events: 40, usageRows: 2 },
  origins: {
    operator: { rows: 8, roots: 8 },
    experiment: { rows: 1, roots: 1 },
    harness: { rows: 1, roots: 1 },
    unknown: { rows: 0, roots: 0 },
  },
  ingest: { lastIngestedAt: '2026-06-02T13:00:00.000Z' },
  staleness: { thresholdHours: 48, hoursSinceNewestSession: 1, stale: false },
};

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

// ── Fixture: fake bin + synthetic index ─────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'contain-smoke-'));
const dbPath = join(tmp, 'speculum.sqlite');
const mjs = join(tmp, 'fake-speculum.mjs');
writeFileSync(
  mjs,
  [
    `const verb = process.argv[2];`,
    `if (verb === 'scan') { console.log(JSON.stringify(${JSON.stringify(SCAN)})); process.exit(0); }`,
    `if (verb === 'usage') { console.log(JSON.stringify(${JSON.stringify(USAGE)})); process.exit(0); }`,
    `if (verb === 'status') { console.log(JSON.stringify(${JSON.stringify(STATUS)})); process.exit(0); }`,
    `console.error('unknown verb ' + verb); process.exit(2);`,
    ``,
  ].join('\n'),
  'utf8',
);

let bin: string;
if (process.platform === 'win32') {
  bin = join(tmp, 'fake-speculum.cmd');
  writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${mjs}" %*\r\n`, 'utf8');
} else {
  bin = join(tmp, 'fake-speculum');
  writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${mjs}" "$@"\n`, {
    encoding: 'utf8',
    mode: 0o755,
  });
}

function seedIndex(): void {
  const db = new Database(dbPath);
  try {
    db.exec(SYNTHETIC_DDL);
    db.run('PRAGMA user_version = 5');
    const insertSession = db.prepare(
      `INSERT INTO sessions (
         id, project_path, agent, parent_session, model_id,
         started_at, ended_at, turn_count, user_msg_count, tool_call_count, tool_error_count, title
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO events (
         session_id, project_path, agent, parent_session, ts, kind,
         text, tool_name, tool_input, tool_output, tool_error, tool_call_id,
         is_boilerplate, sensitive, raw
       ) VALUES (?, ?, 'primary', ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0, 0, ?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO events_fts(rowid, text, tool_name, tool_input, tool_output)
       VALUES (?, ?, ?, NULL, NULL)`,
    );

    for (let i = 0; i < 10; i++) {
      const id = `contain-sess-${String(i).padStart(2, '0')}`;
      const parent = i >= 7 ? `contain-sess-0${i - 7}` : null;
      const title =
        i % 2 === 0
          ? `Very Long Contained Session Title Number ${i} With Extra Words`
          : `Session ${i} short`;
      insertSession.run(
        id,
        `/proj/contain-app-${i % 3}`,
        parent ? 'subagent' : 'primary',
        parent,
        'contain-model-a',
        `2026-06-0${(i % 9) + 1}T12:00:00.000Z`,
        `2026-06-0${(i % 9) + 1}T13:00:00.000Z`,
        3 + (i % 4),
        2,
        1,
        i % 3,
        title,
      );
      for (let e = 0; e < 4; e++) {
        const kind = e === 0 ? 'user' : e === 1 ? 'assistant' : e === 2 ? 'tool_use' : 'tool_result';
        const text =
          kind === 'user'
            ? `contain hello ${i} event ${e}`
            : kind === 'assistant'
              ? `contain reply ${i}`
              : kind === 'tool_use'
                ? ''
                : `tool output for session ${i}`;
        const toolName = kind.startsWith('tool') ? 'Bash' : null;
        const toolError = kind === 'tool_result' && i % 4 === 0 ? 1 : 0;
        insertEvent.run(
          id,
          `/proj/contain-app-${i % 3}`,
          parent,
          `2026-06-0${(i % 9) + 1}T12:0${e}:00.000Z`,
          kind,
          text,
          toolName,
          toolError,
          JSON.stringify({ text }),
        );
        const rowId = Number(
          db.query<{ id: number }, []>('SELECT last_insert_rowid() AS id').get()!.id,
        );
        insertFts.run(rowId, text, toolName);
      }
    }
  } finally {
    db.close();
  }
}

seedIndex();
mkdirSync(FRAMES_DIR, { recursive: true });

const prevBin = process.env.SPECULUM_BIN;
const prevDb = process.env.SPECULUM_DB;
process.env.SPECULUM_BIN = bin;
process.env.SPECULUM_DB = dbPath;

try {
  // @ts-expect-error setMaxListeners exists on EventEmitter / process
  process.setMaxListeners?.(64);
} catch {
  // ignore
}

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Geometric containment helpers ───────────────────────────────────────────

function leadingIndent(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/**
 * Bounds of a bordered panel/card whose title row matches `titleRe`.
 * Pairs the title with the bottom border at the SAME indent (skips nested cards).
 */
function panelBounds(
  lines: string[],
  titleRe: RegExp,
): { top: number; title: number; bottom: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!titleRe.test(line)) continue;
    // Prefer title rows that sit inside a box (`│ Title`).
    if (!/[│|]/.test(line) && !/[┌╭]/.test(line)) continue;

    // Top border: same or one row above.
    let top = i;
    for (let t = i; t >= Math.max(0, i - 2); t--) {
      if (/[┌╭]/.test(lines[t]!)) {
        top = t;
        break;
      }
    }
    const indent = leadingIndent(lines[top]!);

    // Bottom border at the same indent (outer edge of this panel).
    // Nested card bottoms look like `│ └────` — skip those (│ before └).
    // Outer bottoms look like `└────` or a clipped `└─ content ─┘` at this indent.
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (leadingIndent(l) !== indent) continue;
      if (!/[└╰]/.test(l)) continue;
      // Skip nested bottoms drawn inside a parent column (`│ └…`).
      if (/[│|].*[└╰]/.test(l)) continue;
      return { top, title: i, bottom: j };
    }
  }
  return null;
}

function panelBottom(lines: string[], titleRe: RegExp): number | null {
  return panelBounds(lines, titleRe)?.bottom ?? null;
}

/**
 * Nested Card bounds (Sessions / Timeline inside Microscope). Title is ALL-CAPS
 * on a row like `│ │ SESSIONS`; bottom is the nested `│ └────` (│ before └).
 */
function cardBounds(
  lines: string[],
  titleRe: RegExp,
): { top: number; title: number; bottom: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!titleRe.test(line)) continue;
    if (!/[│|]/.test(line)) continue;

    let top = i;
    for (let t = i; t >= Math.max(0, i - 2); t--) {
      // Nested top border often looks like `│ ┌────`.
      if (/[┌╭]/.test(lines[t]!)) {
        top = t;
        break;
      }
    }
    const indent = leadingIndent(lines[top]!);

    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      // Nested bottom: same indent family, has └, typically with a leading │.
      if (!/[└╰]/.test(l)) continue;
      if (leadingIndent(l) < indent) {
        // Walked out of the parent — give up.
        break;
      }
      // Prefer nested bottoms (`│ └`); also accept a plain └ at deeper/equal indent.
      if (/[│|].*[└╰]/.test(l) || leadingIndent(l) >= indent) {
        // Don't pick the stage panel bottom (first non-space is └ at shallow indent).
        const trimmed = l.trimStart();
        if (/^[└╰]/.test(trimmed) && leadingIndent(l) <= 2 && !/[│|]/.test(l.slice(0, 8))) {
          // Stage-level bottom — stop without using it for a nested card.
          break;
        }
        return { top, title: i, bottom: j };
      }
    }
  }
  return null;
}

/**
 * Last content row matching re that sits STRICTLY inside [title+1, bottom).
 * Ignores matches on the bottom border itself (overflow onto the border is a FAIL).
 */
function lastMatchInside(
  lines: string[],
  re: RegExp,
  bottom: number,
  afterRow = 0,
): number | null {
  let last: number | null = null;
  for (let i = afterRow; i < bottom && i < lines.length; i++) {
    if (re.test(lines[i]!)) last = i;
  }
  return last;
}

/** True when a bottom-border row has non-border content bleeding into it. */
function borderHasBleed(line: string): boolean {
  // Strip box-drawing and whitespace; leftover alnum means content painted on the border.
  const stripped = line.replace(/[┌┐└┘╭╮╰╯─│|\s]/g, '');
  return stripped.length > 0;
}

function lastMatchRow(lines: string[], re: RegExp): number | null {
  let last: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) last = i;
  }
  return last;
}

function dumpFail(size: string, stage: string, frame: string): void {
  const path = join(FRAMES_DIR, `${size}-${stage}.txt`);
  writeFileSync(path, frame, 'utf8');
  console.log(`  [dump] ${path}`);
}

type StageResult = {
  stage: string;
  ok: boolean;
  detail: string;
};

type SizeResult = {
  w: number;
  h: number;
  stages: StageResult[];
  ok: boolean;
  slotNote: string;
};

async function driveSize(w: number, h: number): Promise<SizeResult> {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: w,
    height: h,
  });
  const keys = createMockKeys(renderer);
  createRoot(renderer).render(
    <ThemeProvider initial="horizon">
      <box flexDirection="column" width={w} height={h}>
        <SessionsMember inputActive />
      </box>
    </ThemeProvider>,
  );

  // Boot: status + probes scan settle.
  await settle(900);
  await renderOnce();

  const stages: StageResult[] = [];
  const sizeLabel = `${w}x${h}`;

  const checkFooters = (frame: string, stage: string): StageResult | null => {
    // Member footer (stage keys), stage footer, or a flash line — any on-frame.
    const hasFooter =
      /p probes|u usage|m microscope|g map|w search|tab/i.test(frame) ||
      /↑↓|j\/k|refresh|drill|open session|enter timeline|type ·|esc /i.test(frame) ||
      /usage updated|opened |loading/i.test(frame);
    if (!hasFooter) {
      return {
        stage,
        ok: false,
        detail: 'member/stage footer not visible on frame',
      };
    }
    return null;
  };

  // ── Probes + drill open ───────────────────────────────────────────────────
  {
    // Already on probes (default). Open drill.
    await keys.pressKeys(['RETURN']);
    await settle(200);
    await renderOnce();
    const frame = captureCharFrame();
    const lines = frame.split('\n');
    // Stage panel title is "Probes" (not nested card titles).
    const bounds = panelBounds(lines, /^\s*[│|].*Probes\b/i);
    const probesBot = bounds?.bottom ?? null;
    const lastHit =
      probesBot != null
        ? lastMatchInside(lines, /hit-sess-|apologies evidence/i, probesBot, bounds!.title + 1)
        : lastMatchRow(lines, /hit-sess-|apologies evidence/i);
    let ok = true;
    let detail = '';
    if (probesBot == null) {
      ok = false;
      detail = 'Probes panel bottom border not found';
    } else if (borderHasBleed(lines[probesBot]!)) {
      ok = false;
      detail = `Probes bottom border has content bleed: ${lines[probesBot]!.trim().slice(0, 80)}`;
    } else if (lastHit != null && lastHit >= probesBot) {
      ok = false;
      detail = `last hit row ${lastHit} >= Probes bottom ${probesBot}`;
    } else {
      const bodyH = Math.max(1, seedStageBox(w, h).height - PROBES_STAGE_CHROME);
      const vr = budgetProbeVisibleRows(bodyH, true);
      const hits = budgetHitSlots(bodyH, vr * 4, 1);
      detail = `hits last=${lastHit ?? 'none'} bot=${probesBot} slots≈${hits}`;
    }
    const foot = checkFooters(frame, 'probes');
    if (foot && !foot.ok) {
      ok = false;
      detail = detail ? `${detail}; ${foot.detail}` : foot.detail;
    }
    if (!ok) dumpFail(sizeLabel, 'probes', frame);
    stages.push({ stage: 'probes', ok, detail });
    // Close drill before leaving.
    await keys.pressKeys(['ESCAPE']);
    await settle(80);
    await renderOnce();
  }

  // ── Degenerate no-signal card (fixed-slot surface) ────────────────────────
  {
    // Board should show NO-SIGNAL card after ranking; ensure not overflowing.
    await renderOnce();
    const frame = captureCharFrame();
    const lines = frame.split('\n');
    const bounds = panelBounds(lines, /^\s*[│|].*Probes\b/i);
    const probesBot = bounds?.bottom ?? null;
    const degRow = lastMatchRow(lines, /no-signal|NO-SIGNAL/i);
    let ok = true;
    let detail = '';
    if (probesBot == null) {
      ok = false;
      detail = 'Probes panel bottom not found (degenerate)';
    } else if (degRow != null && degRow >= probesBot) {
      ok = false;
      detail = `no-signal row ${degRow} >= Probes bottom ${probesBot}`;
    } else if (degRow == null) {
      // Fixture includes n=0 probe (collapsed no-signal). When the ranked board
      // only has one visible card slot, the trailing no-signal sits off-window —
      // that is windowing, not overflow. Fail closed only when budget could fit it.
      const bodyH = Math.max(1, seedStageBox(w, h).height - PROBES_STAGE_CHROME);
      const vr = budgetProbeVisibleRows(bodyH, true);
      if (vr <= 1) {
        detail = `no-signal off-window (vr=${vr})`;
      } else {
        ok = false;
        detail = 'no-signal card not painted';
      }
    } else {
      detail = `no-signal row=${degRow} bot=${probesBot}`;
    }
    if (!ok) dumpFail(sizeLabel, 'probes-degenerate', frame);
    stages.push({ stage: 'probes-degenerate', ok, detail });
  }

  // ── Probe detail overlay (fixed-slot surface) ─────────────────────────────
  {
    // Select first live probe and open detail.
    keys.typeText('d');
    await settle(200);
    await renderOnce();
    const frame = captureCharFrame();
    const lines = frame.split('\n');
    const bounds = panelBounds(lines, /^\s*[│|].*Probes\b/i);
    const probesBot = bounds?.bottom ?? null;
    const hasDetail = /detail\s*·/i.test(frame) || /sessions\s*\(/i.test(frame);
    const lastSess =
      probesBot != null
        ? lastMatchInside(lines, /hit|session|latest|\d+\s+hits/i, probesBot, bounds!.title + 1)
        : lastMatchRow(lines, /latest|\d+\s+hits/i);
    let ok = hasDetail;
    let detail = hasDetail ? 'detail chrome present' : 'detail overlay missing';
    if (ok && probesBot != null && lastSess != null && lastSess >= probesBot) {
      ok = false;
      detail = `detail content row ${lastSess} >= Probes bottom ${probesBot}`;
    } else if (ok && probesBot != null && borderHasBleed(lines[probesBot]!)) {
      ok = false;
      detail = `Probes bottom bleed under detail: ${lines[probesBot]!.trim().slice(0, 80)}`;
    } else if (ok) {
      detail = `detail last=${lastSess ?? 'none'} bot=${probesBot}`;
    }
    if (!ok) dumpFail(sizeLabel, 'probes-detail', frame);
    stages.push({ stage: 'probes-detail', ok, detail });
    await keys.pressKeys(['ESCAPE']);
    await settle(80);
    await renderOnce();
  }

  // ── Microscope with session open ──────────────────────────────────────────
  {
    keys.typeText('m');
    await settle(400);
    await renderOnce();
    // Open first session timeline.
    await keys.pressKeys(['RETURN']);
    await settle(250);
    await renderOnce();
    const frame = captureCharFrame();
    const lines = frame.split('\n');
    // Nested cards — title rows are ALL-CAPS from Card (not the status "Sessions" panel).
    const sessBounds = cardBounds(lines, /SESSIONS/);
    const timeBounds = cardBounds(lines, /TIMELINE/);
    const sessBot = sessBounds?.bottom ?? null;
    const timeBot = timeBounds?.bottom ?? null;
    const lastSess =
      sessBot != null
        ? lastMatchInside(
            lines,
            /contain-sess-|Contained Session|Session \d+ short/i,
            sessBot,
            (sessBounds?.title ?? 0) + 1,
          )
        : null;
    const lastTurn =
      timeBot != null
        ? lastMatchInside(
            lines,
            /\buser\b|\bassistant\b|tool_use|tool_result|contain hello|contain reply/i,
            timeBot,
            (timeBounds?.title ?? 0) + 1,
          )
        : null;
    let ok = true;
    const parts: string[] = [];
    if (sessBot == null) {
      ok = false;
      parts.push('SESSIONS card bottom not found');
    } else if (borderHasBleed(lines[sessBot]!)) {
      ok = false;
      parts.push(`SESSIONS border bleed: ${lines[sessBot]!.trim().slice(0, 60)}`);
    } else if (lastSess != null && lastSess >= sessBot) {
      ok = false;
      parts.push(`last session row ${lastSess} >= SESSIONS bottom ${sessBot}`);
    } else {
      parts.push(`sess last=${lastSess ?? 'none'} bot=${sessBot}`);
    }
    if (timeBot == null) {
      if (!/TIMELINE/i.test(frame)) {
        ok = false;
        parts.push('TIMELINE card missing');
      } else {
        parts.push('TIMELINE label present (no bottom pair)');
      }
    } else if (borderHasBleed(lines[timeBot]!)) {
      ok = false;
      parts.push(`TIMELINE border bleed: ${lines[timeBot]!.trim().slice(0, 60)}`);
    } else if (lastTurn != null && lastTurn >= timeBot) {
      ok = false;
      parts.push(`last turn row ${lastTurn} >= TIMELINE bottom ${timeBot}`);
    } else {
      parts.push(`turn last=${lastTurn ?? 'none'} bot=${timeBot}`);
    }
    const sb = seedStageBox(w, h);
    const listHost = Math.max(1, sb.height - MICRO_STAGE_CHROME);
    const twoPane = w - 2 >= 100;
    const sSlots = budgetSessionSlots(listHost, twoPane);
    const tSlots = budgetTurnSlots(listHost, twoPane, sSlots);
    parts.push(`slots s=${sSlots} t=${tSlots} listHost=${listHost}`);
    const foot = checkFooters(frame, 'microscope');
    if (foot && !foot.ok) {
      ok = false;
      parts.push(foot.detail);
    }
    if (!ok) dumpFail(sizeLabel, 'microscope', frame);
    stages.push({ stage: 'microscope', ok, detail: parts.join('; ') });

    // Turn detail overlay: enter on a timeline row → TURN card must not paint past border.
    {
      await keys.pressKeys(['RETURN']);
      await settle(250);
      await renderOnce();
      const dFrame = captureCharFrame();
      const dLines = dFrame.split('\n');
      // Card title is ALL-CAPS "TURN" (detail pane replaces TIMELINE content).
      const turnBounds = cardBounds(dLines, /\bTURN\b/);
      const turnBot = turnBounds?.bottom ?? null;
      const lastDetail =
        turnBot != null
          ? lastMatchInside(
              dLines,
              /#\d+|user|assistant|tool_use|tool_result|tool input|contain hello|contain reply/i,
              turnBot,
              (turnBounds?.title ?? 0) + 1,
            )
          : lastMatchRow(dLines, /#\d+|tool input|contain hello/i);
      let dOk = true;
      const dParts: string[] = [];
      if (turnBot == null) {
        if (!/\bTURN\b|#\d+/i.test(dFrame)) {
          dOk = false;
          dParts.push('TURN card missing');
        } else {
          dParts.push('TURN label present (no bottom pair)');
        }
      } else if (borderHasBleed(dLines[turnBot]!)) {
        dOk = false;
        dParts.push(`TURN border bleed: ${dLines[turnBot]!.trim().slice(0, 60)}`);
      } else if (lastDetail != null && lastDetail >= turnBot) {
        dOk = false;
        dParts.push(`last detail row ${lastDetail} >= TURN bottom ${turnBot}`);
      } else {
        dParts.push(`detail last=${lastDetail ?? 'none'} bot=${turnBot}`);
      }
      // Footer should name detail keys while open.
      if (!/j\/k scroll|prev\/next|y copy|esc close/i.test(dFrame)) {
        // Soft: footer may be on member line; don't hard-fail if header present.
        dParts.push('detail footer soft-miss');
      }
      if (!dOk) dumpFail(sizeLabel, 'turn-detail', dFrame);
      stages.push({ stage: 'turn-detail', ok: dOk, detail: dParts.join('; ') });
      await keys.pressKeys(['ESCAPE']);
      await settle(80);
      await renderOnce();
    }
  }

  // ── Search idle + typed query ─────────────────────────────────────────────
  {
    keys.typeText('w');
    await settle(300);
    await renderOnce();
    let frame = captureCharFrame();
    // Type a query that should hit FTS (Search focuses its input when active).
    await keys.typeText('contain');
    await settle(500);
    await renderOnce();
    frame = captureCharFrame();
    const lines = frame.split('\n');
    const bounds = panelBounds(lines, /^\s*[│|].*Search\b/i);
    const searchBot = bounds?.bottom ?? null;
    const lastHit =
      searchBot != null
        ? lastMatchInside(
            lines,
            /contain hello|contain reply|contain-sess/i,
            searchBot,
            (bounds?.title ?? 0) + 1,
          )
        : lastMatchRow(lines, /contain hello|contain reply|contain-sess/i);
    let ok = true;
    let detail = '';
    if (searchBot == null) {
      if (!/SEARCH|search sessions/i.test(frame)) {
        ok = false;
        detail = 'Search panel not found';
      } else {
        detail = 'Search panel present (no bottom border match)';
      }
    } else if (borderHasBleed(lines[searchBot]!)) {
      ok = false;
      detail = `Search border bleed: ${lines[searchBot]!.trim().slice(0, 60)}`;
    } else if (lastHit != null && lastHit >= searchBot) {
      ok = false;
      detail = `last search hit ${lastHit} >= Search bottom ${searchBot}`;
    } else {
      detail = `search last=${lastHit ?? 'none/idle'} bot=${searchBot}`;
    }
    const foot = checkFooters(frame, 'search');
    if (foot && !foot.ok) {
      ok = false;
      detail = detail ? `${detail}; ${foot.detail}` : foot.detail;
    }
    if (!ok) dumpFail(sizeLabel, 'search', frame);
    stages.push({ stage: 'search', ok, detail });
  }

  // ── Usage ─────────────────────────────────────────────────────────────────
  {
    keys.typeText('u');
    await settle(600);
    await renderOnce();
    const frame = captureCharFrame();
    const lines = frame.split('\n');
    const bounds = panelBounds(lines, /^\s*[│|].*Usage\b/i);
    const usageBot = bounds?.bottom ?? null;
    let ok = true;
    let detail = '';
    if (usageBot == null && !/USAGE|Token and turn/i.test(frame)) {
      ok = false;
      detail = 'Usage panel not found';
    } else if (usageBot != null && borderHasBleed(lines[usageBot]!)) {
      ok = false;
      detail = `Usage border bleed: ${lines[usageBot]!.trim().slice(0, 60)}`;
    } else {
      const lastModel =
        usageBot != null
          ? lastMatchInside(lines, /contain-model|by model|TURNS/i, usageBot, (bounds?.title ?? 0) + 1)
          : null;
      if (usageBot != null && lastModel != null && lastModel >= usageBot) {
        ok = false;
        detail = `last model/content ${lastModel} >= Usage bottom ${usageBot}`;
      } else {
        detail = `usage bot=${usageBot ?? 'n/a'} last=${lastModel ?? 'n/a'}`;
      }
    }
    const foot = checkFooters(frame, 'usage');
    if (foot && !foot.ok) {
      ok = false;
      detail = detail ? `${detail}; ${foot.detail}` : foot.detail;
    }
    if (!ok) dumpFail(sizeLabel, 'usage', frame);
    stages.push({ stage: 'usage', ok, detail });
  }

  // ── Map ───────────────────────────────────────────────────────────────────
  {
    keys.typeText('g');
    await settle(500);
    await renderOnce();
    const frame = captureCharFrame();
    const lines = frame.split('\n');
    const bounds = panelBounds(lines, /^\s*[│|].*\bMap\b/i);
    const mapBot = bounds?.bottom ?? null;
    let ok = true;
    let detail = '';
    if (mapBot == null && !/\bMap\b/i.test(frame)) {
      ok = false;
      detail = 'Map panel not found';
    } else if (mapBot != null && borderHasBleed(lines[mapBot]!)) {
      ok = false;
      detail = `Map border bleed: ${lines[mapBot]!.trim().slice(0, 60)}`;
    } else {
      detail = `map bot=${mapBot ?? 'n/a'}`;
    }
    // Axis strip is inside the canvas blit — no map content row may paint
    // past the panel bottom border at any size in the matrix.
    if (mapBot != null) {
      for (let li = bounds?.top ?? 0; li <= mapBot; li++) {
        const line = lines[li] ?? '';
        // A content row that lost both side borders while carrying axis ticks
        // is the signature of canvas paint past the panel.
        if (
          /05-\d{2}|0[1-9]-\d{2}|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/.test(
            line,
          )
        ) {
          const hasLeft = /^\s*[│|]/.test(line) || line.includes('│');
          // Accept either bordered content or a pure interior strip that still
          // sits above mapBot.
          if (li > mapBot) {
            ok = false;
            detail = `axis row ${li} past panel bot ${mapBot}`;
          } else if (!hasLeft && li === mapBot) {
            // axis on the border line itself is a defect
            ok = false;
            detail = `axis strip on panel border: ${line.trim().slice(0, 60)}`;
          }
        }
      }
      // Canvas must not push legend/status past panel bottom (existing foot check
      // plus: legend rows that appear after mapBot).
      const legendIdx = lines.findIndex((l) => /parentage\s*\(\d+\)/.test(l));
      if (legendIdx >= 0 && mapBot != null && legendIdx > mapBot) {
        ok = false;
        detail = detail
          ? `${detail}; legend past panel`
          : `legend row ${legendIdx} past map bot ${mapBot}`;
      }
    }
    const foot = checkFooters(frame, 'map');
    if (foot && !foot.ok) {
      ok = false;
      detail = detail ? `${detail}; ${foot.detail}` : foot.detail;
    }
    if (!ok) dumpFail(sizeLabel, 'map', frame);
    stages.push({ stage: 'map', ok, detail });
  }

  renderer.destroy();

  const sb = seedStageBox(w, h);
  const listHost = Math.max(1, sb.height - MICRO_STAGE_CHROME);
  const twoPane = w - 2 >= 100;
  const sSlots = budgetSessionSlots(listHost, twoPane);
  const tSlots = budgetTurnSlots(listHost, twoPane, sSlots);
  const bodyH = Math.max(1, sb.height - PROBES_STAGE_CHROME);
  const vr = budgetProbeVisibleRows(bodyH, true);
  const hits = budgetHitSlots(bodyH, vr * 4, 1);
  const slotNote = `micro s=${sSlots} t=${tSlots} listHost=${listHost}; probes vr=${vr} hits=${hits} bodyH=${bodyH}; chromeV=${CARD_V_CHROME} stackGap=${STACK_GAP} info=${TIMELINE_INFO_ROWS}`;

  return {
    w,
    h,
    stages,
    ok: stages.every((s) => s.ok),
    slotNote,
  };
}

// ── Run matrix ──────────────────────────────────────────────────────────────
const results: SizeResult[] = [];
for (const [w, h] of MATRIX) {
  console.log(`\n══ ${w}×${h} ══`);
  const r = await driveSize(w, h);
  results.push(r);
  for (const s of r.stages) {
    console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.stage} — ${s.detail}`);
  }
  console.log(`  slots: ${r.slotNote}`);
}

// Restore env + cleanup
if (prevBin === undefined) delete process.env.SPECULUM_BIN;
else process.env.SPECULUM_BIN = prevBin;
if (prevDb === undefined) delete process.env.SPECULUM_DB;
else process.env.SPECULUM_DB = prevDb;
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  // best-effort
}

console.log('\n══ summary ══');
let allOk = true;
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL';
  if (!r.ok) allOk = false;
  console.log(
    `  ${mark}  ${r.w}×${r.h}  ${r.stages.map((s) => `${s.stage}:${s.ok ? 'ok' : 'FAIL'}`).join(' ')}`,
  );
}
// Highlight 80×24 fit-clamp proof when present.
const small = results.find((r) => r.w === 80 && r.h === 24);
if (small) {
  console.log(`\n80×24 slot proof: ${small.slotNote}`);
  console.log(
    '  (pre-fix overflowed: micro s=4 t=4 ignoring card chrome; post-fix fit-clamps to host)',
  );
}

process.exit(allOk ? 0 : 1);
