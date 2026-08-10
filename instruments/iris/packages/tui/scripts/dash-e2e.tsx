/**
 * H1 — headless E2E driver over the REAL dash Shell (Sessions surface).
 *
 * Renders `src/shell/Shell.tsx` via createTestRenderer + createRoot + ThemeProvider,
 * with the operator's real org (IRIS_ORG_ROOT), real speculum on PATH, real ~/.amore
 * index, and the live daemon if up (demo graph fallback is fine).
 *
 * Run from packages/tui:
 *   bun run scripts/dash-e2e.tsx
 *
 * Writes:
 *   scripts/e2e-frames/<step>.txt   — char frames per step
 *   scripts/e2e-sessions-topology.txt — one-level walk of ~/.amore/sessions
 *
 * Exit 0 only if ALL PASS; assertion failures are FINDINGS (honest gate), not harness bugs.
 */
import { mkdirSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createTestRenderer, createMockKeys } from '@opentui/core/testing';
import { createRoot } from '@opentui/react';
import { ThemeProvider } from '../src/ThemeProvider';
import { Shell } from '../src/shell/Shell';

// ── Paths ───────────────────────────────────────────────────────────────────
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMES_DIR = join(SCRIPT_DIR, 'e2e-frames');
const TOPOLOGY_PATH = join(SCRIPT_DIR, 'e2e-sessions-topology.txt');
const ORG_ROOT = process.env.IRIS_ORG_ROOT ?? 'C:\\Users\\AlexMoyer\\Documents\\amore';
const SESSIONS_ROOT = join(homedir(), '.amore', 'sessions');

process.env.IRIS_ORG_ROOT = ORG_ROOT;

mkdirSync(FRAMES_DIR, { recursive: true });

// Eager-mount registers many useKeyboard listeners — silence the Node warning.
try {
  // @ts-expect-error setMaxListeners exists on EventEmitter / process
  process.setMaxListeners?.(64);
} catch {
  // ignore
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Assertion = { name: string; ok: boolean; detail?: string };
const assertions: Assertion[] = [];

function assert(name: string, ok: boolean, detail?: string): void {
  assertions.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function dumpFrame(step: string, frame: string): void {
  const path = join(FRAMES_DIR, `${step}.txt`);
  writeFileSync(path, frame, 'utf8');
  console.log(`  [frame] ${path} (${frame.split('\n').length} lines)`);
}

/** First N non-empty lines that match a pattern (for failure evidence). */
function matchingRows(frame: string, re: RegExp, limit = 6): string[] {
  return frame
    .split('\n')
    .filter((l) => re.test(l))
    .slice(0, limit);
}

/**
 * Poll renderOnce+capture until `pred` holds or timeout.
 * Real `speculum scan` against ~1.7k sessions can take many seconds — settle-then-assert
 * with a fixed short wait races the scan (probes stuck on "loading scan…").
 */
async function settleUntil(
  renderOnce: () => Promise<void> | void,
  captureCharFrame: () => string,
  pred: (frame: string) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const intervalMs = opts.intervalMs ?? 750;
  const t0 = Date.now();
  let frame = '';
  while (Date.now() - t0 < timeoutMs) {
    await settle(intervalMs);
    await renderOnce();
    frame = captureCharFrame();
    if (pred(frame)) return frame;
  }
  if (opts.label) {
    console.log(`  [settleUntil] timeout ${timeoutMs}ms waiting for ${opts.label}`);
  }
  return frame;
}

// ── Topology (1699 question) ────────────────────────────────────────────────
function writeTopology(): { grandTotal: number; topDirs: number; summaryLines: string[] } {
  const lines: string[] = [];
  lines.push(`# Sessions topology — one level under ${SESSIONS_ROOT}`);
  lines.push(`# generated: ${new Date().toISOString()}`);
  lines.push('');

  if (!existsSync(SESSIONS_ROOT)) {
    lines.push(`MISSING: ${SESSIONS_ROOT}`);
    writeFileSync(TOPOLOGY_PATH, lines.join('\n') + '\n', 'utf8');
    return { grandTotal: 0, topDirs: 0, summaryLines: lines };
  }

  let grandTotal = 0;
  const top = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  lines.push(`top-level cwd dirs: ${top.length}`);
  lines.push('');

  for (const name of top) {
    const dir = join(SESSIONS_ROOT, name);
    let children: string[] = [];
    try {
      children = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isFile())
        .map((d) => d.name);
    } catch (e) {
      lines.push(`${name}/  ERROR: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    // Prefer UUID-like session dirs; fall back to all names.
    const uuidish = children.filter((c) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c),
    );
    const samplePool = uuidish.length > 0 ? uuidish : children;

    // Newest by mtime of the entry.
    const withMtime = samplePool.map((c) => {
      try {
        return { name: c, mtime: statSync(join(dir, c)).mtimeMs };
      } catch {
        return { name: c, mtime: 0 };
      }
    });
    withMtime.sort((a, b) => b.mtime - a.mtime);
    const newest3 = withMtime.slice(0, 3).map((x) => x.name);

    // Count: prefer session-dir count when UUID-shaped; else total child count.
    const count = uuidish.length > 0 ? uuidish.length : children.length;
    grandTotal += count;

    lines.push(`${name}/`);
    lines.push(`  count: ${count}${uuidish.length > 0 ? ' (uuid dirs)' : ' (entries)'}`);
    lines.push(`  newest3: ${newest3.length ? newest3.join(', ') : '(none)'}`);
    lines.push('');
  }

  lines.push(`grand total (sum of per-dir counts): ${grandTotal}`);
  lines.push(`top-level dirs: ${top.length}`);
  writeFileSync(TOPOLOGY_PATH, lines.join('\n') + '\n', 'utf8');
  console.log(`\n[topology] wrote ${TOPOLOGY_PATH}`);
  console.log(`[topology] top-level=${top.length}  grandTotal=${grandTotal}`);
  return { grandTotal, topDirs: top.length, summaryLines: lines };
}

// ── Multi-size Sessions-only dump ───────────────────────────────────────────
async function dumpSessionsAtSize(
  width: number,
  height: number,
  stepName: string,
): Promise<string> {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width,
    height,
  });
  const keys = createMockKeys(renderer);
  createRoot(renderer).render(
    <ThemeProvider initial="horizon">
      <Shell />
    </ThemeProvider>,
  );
  await settle(1500);
  keys.typeText('s');
  // Status strip + chip row land quickly. Stages may flash ("scan updated" / "usage updated")
  // into the member footer for ~2.5s (useFlash default) — wait past that so the stage-key
  // footer grammar is visible for the integrity assert.
  await settle(3200);
  await renderOnce();
  const frame = captureCharFrame();
  dumpFrame(stepName, frame);
  renderer.destroy();
  return frame;
}

// ── Main drive at 120×40 ────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== iris dash E2E (Sessions) ===');
  console.log(`IRIS_ORG_ROOT=${ORG_ROOT}`);
  console.log(`frames → ${FRAMES_DIR}`);
  console.log('');

  // Topology first (independent of UI; operator evidence for count dispute).
  const topo = writeTopology();

  const W = 120;
  const H = 40;
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: W,
    height: H,
  });
  const keys = createMockKeys(renderer);
  createRoot(renderer).render(
    <ThemeProvider initial="horizon">
      <Shell />
    </ThemeProvider>,
  );

  // 1. Boot + S → Sessions
  console.log('\n── 1. Boot + S → Sessions ──');
  await settle(1500);
  await renderOnce();
  const bootFrame = captureCharFrame();
  dumpFrame('01-boot', bootFrame);

  keys.typeText('s');
  await settle(1200); // status + eager mounts; probes scan continues async
  await renderOnce();

  // Status strip lands from `speculum status` (fast). Probes need real scan — poll.
  let sessionsFrame = captureCharFrame();
  dumpFrame('02-sessions-probes-early', sessionsFrame);

  // Product copy (status.ts): "installed · N operator" (origin-classified strip) or
  // the legacy "session dirs" copy when the CLI predates origin counts. Accept both + soft states.
  assert(
    'status_strip',
    /installed · (\d[\d,]* operator|\d[\d,]* session(s| dirs))|no ingested sessions|speculum not installed/i.test(
      sessionsFrame,
    ),
    matchingRows(sessionsFrame, /installed|operator|session|speculum|ingest/i, 3).join(' | ') || undefined,
  );
  // True-count bar: once origins land, the strip's headline is the operator count.
  if (/installed · \d[\d,]* operator/.test(sessionsFrame)) {
    assert(
      'strip_true_operator_count',
      true,
      matchingRows(sessionsFrame, /installed · \d[\d,]* operator/i, 1).join(' | '),
    );
  }

  // Wait for probe board to leave "loading scan…" and show a real registry name.
  const PROBE_NAME_RE =
    /session-phase|contradiction|session-overlap|apology-rate|stuck-loop/i;
  sessionsFrame = await settleUntil(
    renderOnce,
    captureCharFrame,
    (f) => PROBE_NAME_RE.test(f) && !/loading scan/i.test(f),
    { timeoutMs: 60_000, intervalMs: 1000, label: 'probes scan complete' },
  );
  dumpFrame('02-sessions-probes', sessionsFrame);

  assert('chips_Microscope', /Microscope/.test(sessionsFrame));
  assert('chips_Map', /Map/.test(sessionsFrame));
  assert('chips_Search', /Search/.test(sessionsFrame));
  // All five stage chips present.
  assert(
    'chips_five_stage_set',
    /Probes/.test(sessionsFrame) &&
      /Usage/.test(sessionsFrame) &&
      /Microscope/.test(sessionsFrame) &&
      /Map/.test(sessionsFrame) &&
      /Search/.test(sessionsFrame),
  );
  assert(
    'probes_board_real_name',
    PROBE_NAME_RE.test(sessionsFrame),
    matchingRows(sessionsFrame, PROBE_NAME_RE, 3).join(' | ') ||
      matchingRows(sessionsFrame, /Probes|loading|scan|error/i, 4).join(' | ') ||
      undefined,
  );

  // 2. Probe drill: Enter/h → hits; u → Usage
  console.log('\n── 2. Probe hits + Usage ──');
  // First probe already selected; open hits.
  await keys.pressKeys(['RETURN'], 40);
  await settle(500);
  await renderOnce();
  let hitsFrame = captureCharFrame();
  // If still no hits chrome, try `h` (documented synonym).
  if (!/hits\s*\(/.test(hitsFrame)) {
    keys.typeText('h');
    await settle(400);
    await renderOnce();
    hitsFrame = captureCharFrame();
  }
  dumpFrame('03-probe-hits', hitsFrame);
  assert(
    'probe_hits_block',
    /hits\s*\(/.test(hitsFrame),
    matchingRows(hitsFrame, /hits/i, 3).join(' | ') || undefined,
  );
  // Drill-flex bar: the hits panel + stage footer are visible at 120×40, and the
  // global ingestion/lens/audit grammar appears AT MOST ONCE (the member footer
  // owns it; the Actions strip is silent when idle — the single-band rule).
  assert(
    'drill_no_overflow_120x40',
    /hits \(none\) · h\/esc close|↑↓ hit · enter open session|hits \(\d+\) for/.test(
      hitsFrame,
    ) &&
      (/p probes\s*·\s*u usage/.test(hitsFrame) ||
        /i ingest\s*·\s*L lens\s*·\s*A audit/.test(hitsFrame)) &&
      (hitsFrame.match(/i ingest\s*·\s*L lens\s*·\s*A audit/g) ?? []).length <= 1,
    matchingRows(hitsFrame, /hits|↑↓ hit|i ingest|p probes/i, 6).join(' | ') || undefined,
  );

  // Close hits (escape or h again) then switch to Usage.
  await keys.pressKeys(['ESCAPE'], 40);
  await settle(200);
  keys.typeText('u');
  await settle(900);
  await renderOnce();
  const usageFrame = captureCharFrame();
  dumpFrame('04-usage', usageFrame);
  assert(
    'usage_totals',
    /tokens|turns|No price table/i.test(usageFrame),
    matchingRows(usageFrame, /token|turn|price|model/i, 4).join(' | ') || undefined,
  );

  // 3. Microscope: m → picker → Enter → timeline
  console.log('\n── 3. Microscope ──');
  keys.typeText('m');
  await settle(1000);
  await renderOnce();
  const microPicker = captureCharFrame();
  dumpFrame('05-microscope-picker', microPicker);

  const pickerChrome =
    /Microscope/.test(microPicker) &&
    (/↑↓|up\/dn|select|enter timeline|j\/k/i.test(microPicker) ||
      /session|speculum|loading microscope|no sessions|corpus/i.test(microPicker));
  const frameChangedFromProbes = microPicker !== sessionsFrame && microPicker !== usageFrame;
  assert(
    'microscope_picker',
    pickerChrome && frameChangedFromProbes,
    matchingRows(microPicker, /Microscope|↑|session|select|loading|corpus/i, 4).join(' | ') ||
      undefined,
  );
  // Two-pane chrome: titled SESSIONS/TIMELINE panes (titleColor), not a flat text row.
  assert(
    'microscope_title_chrome',
    /SESSIONS/.test(microPicker) && /TIMELINE/.test(microPicker),
    matchingRows(microPicker, /SESSIONS|TIMELINE|Microscope/i, 4).join(' | ') || undefined,
  );

  await keys.pressKeys(['RETURN'], 40);
  await settle(900);
  await renderOnce();
  const microTimeline = captureCharFrame();
  dumpFrame('06-microscope-timeline', microTimeline);
  assert(
    'microscope_timeline_row',
    /#\d+|tool_use|user|assistant|tool_error|no events|enter a session/i.test(microTimeline),
    matchingRows(
      microTimeline,
      /#\d+|tool_use|user|assistant|tool_error|no events|enter a session/i,
      4,
    ).join(' | ') || undefined,
  );

  // 4. Map: g
  console.log('\n── 4. Map ──');
  // Escape timeline if open, then map (microscope esc → picker still fine; g switches stage).
  await keys.pressKeys(['ESCAPE'], 40);
  await settle(150);
  keys.typeText('g');
  await settle(1200);
  await renderOnce();
  const mapFrame = captureCharFrame();
  dumpFrame('07-map', mapFrame);
  // Glyphs (braille block) OR chrome hints from GraphView reuse.
  const hasBraille = /[\u2800-\u28FF]/.test(mapFrame);
  const hasMapChrome = /fit|center|cluster|density/i.test(mapFrame);
  assert(
    'map_renders',
    hasBraille || hasMapChrome,
    hasBraille
      ? 'braille glyphs present'
      : matchingRows(mapFrame, /fit|center|cluster|density|Map|session/i, 4).join(' | ') ||
        undefined,
  );
  // One-house map bars: honest coverage, closed legend with pinned edge kinds,
  // and NEVER session-folder labels (the wall-of-(1) regression).
  assert(
    'map_showing_n_of_m',
    /showing \d+ of \d+/.test(mapFrame),
    matchingRows(mapFrame, /showing \d+ of \d+/i, 2).join(' | ') || undefined,
  );
  assert(
    'map_legend_closed',
    /parentage/.test(mapFrame) && /event links/.test(mapFrame) && /operator/.test(mapFrame),
    matchingRows(mapFrame, /parentage|event links|operator|●|═|─/i, 4).join(' | ') || undefined,
  );
  {
    // Zero drawn edges is the HONEST default (population filters on); the real
    // record's structure is surfaced by the legend edge-kind totals.
    const linksMatch = mapFrame.match(/(\d+) links/);
    assert(
      'map_links_honest',
      !!linksMatch && /parentage/.test(mapFrame) && /event links/.test(mapFrame),
      linksMatch
        ? `${linksMatch[1]} links (0 is the honest default) · legend carries the edge kinds`
        : 'no "N links" token in frame',
    );
  }
  assert(
    'map_no_session_folder_labels',
    !/A-sen-|chat-mode-/.test(mapFrame),
    matchingRows(mapFrame, /A-sen-|chat-mode-|op·prim/i, 3).join(' | ') || 'no folder labels',
  );

  // 5. Search: w → type 'the' → assert hits or no matches → Escape
  console.log('\n── 5. Search ──');
  keys.typeText('w');
  await settle(500);
  await renderOnce();
  // Idle-copy bar: the hint renders exactly once (not twice on stacked rows).
  {
    const searchIdle = captureCharFrame();
    const occurrences = (searchIdle.match(/type to search sessions/g) ?? []).length;
    assert(
      'search_idle_hint_once',
      occurrences === 1,
      `idle hint occurrences=${occurrences} (want exactly 1)`,
    );
  }
  await keys.typeText('the', 30);
  await settle(600); // debounce 200 + query
  await renderOnce();
  const searchFrame = captureCharFrame();
  dumpFrame('08-search', searchFrame);
  assert(
    'search_results_or_honest_empty',
    /no matches|\d+\s*hits?|hit\b/i.test(searchFrame) ||
      /search sessions|type ·|MISSING|schema|busy|run 'speculum/i.test(searchFrame),
    matchingRows(searchFrame, /match|hit|search|schema|busy|ingest/i, 4).join(' | ') || undefined,
  );
  await keys.pressKeys(['ESCAPE'], 40);
  await settle(200);

  // 6. Lens E2E: L → picker → Enter (session-postmortem --last-n 5 dry-run)
  console.log('\n── 6. Lens dry-run (REAL index; appends ONE dry-run audit line) ──');
  // Leave search stage so capture does not eat keys if stage switch is blocked.
  // SpeculumActions still receives L while Sessions is active.
  keys.pressKey('l', { shift: true });
  await settle(500);
  await renderOnce();
  const lensPicker = captureCharFrame();
  dumpFrame('09-lens-picker', lensPicker);
  assert(
    'lens_picker',
    /Lens picker|session-postmortem|pattern-extraction|usage-story|--last-n/i.test(lensPicker),
    matchingRows(lensPicker, /Lens|session-postmortem|pattern|usage|--last-n/i, 4).join(' | ') ||
      undefined,
  );

  await keys.pressKeys(['RETURN'], 40);
  // Real lens dry-run against full corpus can take several seconds.
  await settle(8000);
  await renderOnce();
  const lensDry = captureCharFrame();
  dumpFrame('10-lens-dry-run', lensDry);
  assert(
    'lens_composition_panel',
    /bytes|payload|refused|narrow|dry-run|scrub|size n\/a|not sendable|sendable/i.test(lensDry),
    matchingRows(
      lensDry,
      /bytes|payload|refused|narrow|dry-run|scrub|sendable|reason|Lens/i,
      6,
    ).join(' | ') || undefined,
  );
  assert(
    'lens_scrub_or_secret_or_home',
    /scrub|secret|home-path|home.path|email|password-assignment|counts n\/a/i.test(lensDry),
    matchingRows(lensDry, /scrub|secret|home|email|password|counts/i, 4).join(' | ') || undefined,
  );

  // Narrow-to-fit bar: toggle --no-subagents and the dry-run must stop being
  // refused-when-it-shouldn't-be (the subagent chain is what pushes a selection
  // past the payload cap; without it this corpus produces a 79 KB slice).
  // NEVER press y — a live send stays a human decision; the modal is dismissed.
  console.log('\n── 6b. Lens narrowing (last-n 1 + --no-subagents) ──');
  let lensNarrow: string;
  await keys.pressKey('1'); // digit → last-n 1 → debounced re-dry-run (still over cap: chain included)
  lensNarrow = await settleUntil(
    renderOnce,
    captureCharFrame,
    (f) => !/running dry-run/.test(f) && /over cap|sendable/.test(f),
    { timeoutMs: 45_000, intervalMs: 1500, label: 'last-n 1 dry-run settled' },
  );
  await keys.pressKey('n'); // toggle --no-subagents
  await settle(300);
  await keys.pressKeys(['RETURN'], 40); // re-run dry-run now, not debounced
  lensNarrow = await settleUntil(
    renderOnce,
    captureCharFrame,
    (f) => /sendable\s*[-—]\s*confirm to invoke model|over cap\s*[-—]\s*narrow|still over cap/.test(f),
    { timeoutMs: 45_000, intervalMs: 1500, label: 'narrowed dry-run verdict' },
  );
  dumpFrame('10b-lens-narrow', lensNarrow);
  assert(
    'lens_fits_after_narrow',
    /sendable\s*[-—]\s*confirm to invoke model/.test(lensNarrow),
    matchingRows(lensNarrow, /sendable|over cap|payload|bytes|dry-run/i, 8).join(' | ') ||
      matchingRows(lensNarrow, /payload|Lens|scrub|selection/i, 6).join(' | ') ||
      undefined,
  );

  // Close lens panel so multi-size dumps are clean Sessions.
  await keys.pressKeys(['ESCAPE'], 40);
  await settle(300);
  // Dismiss confirm modal if it appeared (y-path only when sendable; n/esc cancel).
  await keys.pressKeys(['ESCAPE'], 40);
  await settle(200);
  await renderOnce();
  const afterLens = captureCharFrame();
  dumpFrame('11-after-lens', afterLens);

  renderer.destroy();

  // 7. Multi-size audit
  console.log('\n── 7. Multi-size audit (80×24, 100×30) ──');
  const frame80 = await dumpSessionsAtSize(80, 24, '12-sessions-80x24');
  const frame100 = await dumpSessionsAtSize(100, 30, '13-sessions-100x30');

  // Five chips one row: look for a single line that contains Probes…Search without mid-word garble.
  const chipLine = frame80
    .split('\n')
    .find((l) => /Probes/.test(l) && /Search/.test(l) && /Microscope|Map|Usage/.test(l));
  const chipsOneRow = !!chipLine && !/Prob\s*$|escopes|Sear\s*$/i.test(chipLine);
  assert(
    'chips_one_row_80x24',
    chipsOneRow,
    chipLine ? `chip line: ${chipLine.trim()}` : 'no single line with Probes…Search',
  );

  // Footer hint intact: Sessions stage-key grammar on ONE row (truncate, never wrap).
  // Must be the real footer — not the chip row (which also contains "Microscope").
  const footerCandidates = frame80
    .split('\n')
    .filter((l) => /p probes/i.test(l) && /u usage/i.test(l));
  const footerLine = footerCandidates.find((l) => /p probes\s*·\s*u usage/i.test(l)) ?? footerCandidates[0];
  const actionsFooter = frame80
    .split('\n')
    .find((l) => /i ingest\s*·\s*L lens/i.test(l));
  // Intact = present on one frame row, truncated (not wrapped to a second key-grammar row).
  // formatLucernaDisplayLine truncates to width — visible length ≤ 80 is the contract.
  const footerTrim = footerLine?.replace(/\s+$/, '') ?? '';
  const footerWrappedTwice = footerCandidates.length > 1;
  const footerIntact =
    !!footerLine &&
    footerTrim.length > 0 &&
    footerTrim.length <= 82 &&
    !footerWrappedTwice &&
    /p probes/i.test(footerTrim);
  assert(
    'footer_hint_intact_80x24',
    footerIntact,
    footerLine
      ? `footer (${footerTrim.length} chars): ${footerTrim.slice(0, 100)}${footerWrappedTwice ? ' [MULTI-LINE WRAP]' : ''}`
      : actionsFooter
        ? `stage-key footer MISSING; only actions footer: ${actionsFooter.trim().slice(0, 80)}`
        : 'footer line not found (stage-key grammar absent at 80×24)',
  );

  // Layout defect scan on 80×24 (report only — does not invent pass/fail beyond above).
  const layoutNotes: string[] = [];
  for (const line of frame80.split('\n')) {
    // Classic interleave signatures: two words smashed without separator mid-token.
    if (/[a-z]{3,}[A-Z][a-z]{2,}/.test(line) && !/Microscope|OpenTUI/.test(line)) {
      layoutNotes.push(`possible interleave: ${line.trim().slice(0, 100)}`);
    }
  }
  if (layoutNotes.length) {
    console.log('\n[layout notes @ 80×24]');
    for (const n of layoutNotes.slice(0, 12)) console.log(`  ${n}`);
  } else {
    console.log('\n[layout notes @ 80×24] none flagged by crude interleave scan');
  }
  // Ensure 100×30 dump landed (presence assertion).
  assert('frame_100x30_dumped', frame100.length > 0, `${frame100.split('\n').length} lines`);

  // Topology presence
  assert('topology_written', existsSync(TOPOLOGY_PATH));
  assert(
    'topology_has_total',
    topo.grandTotal >= 0 && topo.topDirs >= 0,
    `topDirs=${topo.topDirs} grandTotal=${topo.grandTotal}`,
  );

  // ── Assertion sheet ───────────────────────────────────────────────────────
  console.log('\n========== ASSERTION SHEET ==========');
  for (const a of assertions) {
    console.log(`${a.name}: ${a.ok}`);
  }
  const failed = assertions.filter((a) => !a.ok);
  const ok = failed.length === 0;
  if (ok) {
    console.log('ALL PASS');
  } else {
    console.log(`FAILURES: ${failed.length}`);
    console.log('\n--- failing detail ---');
    for (const f of failed) {
      console.log(`* ${f.name}${f.detail ? `\n    ${f.detail}` : ''}`);
    }
  }
  console.log('=====================================\n');

  // Lens dry-run note for the operator report.
  console.log(
    'NOTE: step 6 invoked real `speculum lens session-postmortem --last-n 5 --dry-run`',
  );
  console.log('      (designed surface — appends ONE dry-run line to the lens audit).');

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('E2E harness crashed:', err);
  process.exit(2);
});
