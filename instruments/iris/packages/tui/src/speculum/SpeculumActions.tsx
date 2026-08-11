/**
 * Governed side-effect surface for the Sessions member.
 * All side-effects shell the speculum CLI via runSpeculum — never local writers.
 * Lens + summarize are the only egress verbs; both fail-closed through scrub
 * and the two-step dry-run → confirm chain.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { ConfirmModal, Modal } from '../components/Modal';
import { MarkdownView } from '../components/MarkdownView';
import { useStableDimensions } from '../use-stable-dimensions';
import {
  emptyDisplayRow,
  formatLucernaDisplayLine,
} from '../members/lucerna-display';
import { runSpeculum, type SpeculumResult } from './speculum-spawn';
import { openQueryService, type SessionListRow } from './query-service';

// ── Built-in lenses (names only; registry lives in the speculum instrument) ──

export const BUILTIN_LENSES = [
  'session-postmortem',
  'pattern-extraction',
  'usage-story',
] as const;

export type BuiltinLens = (typeof BUILTIN_LENSES)[number];

/** Steppable last-n values for lens selection (default 5). */
export const LAST_N_OPTIONS = [1, 2, 3, 5, 10] as const;
export type LastNOption = (typeof LAST_N_OPTIONS)[number];

export const DEFAULT_LAST_N: LastNOption = 5;
const LAST_N_DEBOUNCE_MS = 200;
/** Lens payload cap shown in composition (matches CLI fail-closed cap). */
export const LENS_CAP_BYTES = 102_400;
const AUDIT_FETCH_N = 20;
const AUDIT_SHOW_SLOTS = 6;
const RECENT_SESSION_LIMIT = 16;
const INSTALL_HINT = 'amore init --with-speculum';

// ── Envelope shapes (mirror CLI --json; defensive field access) ──

export type ScrubCounts = {
  secret?: number;
  email?: number;
  'home-path'?: number;
  'password-assignment'?: number;
  [k: string]: number | undefined;
};

export type IngestEnvelope = {
  sessionDirsIngested?: number;
  sessionDirsScanned?: number;
  eventsAppended?: number;
  [k: string]: unknown;
};

export type LensSlice = {
  sessionId?: string | null;
  project?: string | null;
  turnsRendered?: number;
  subagentCount?: number;
  selectionSessionIds?: string[];
  [k: string]: unknown;
};

export type LensEnvelope = {
  lens?: string;
  refused?: boolean;
  refusedReason?: string | null;
  dryRun?: boolean;
  modelId?: string | null;
  /** Dated markdown report written by a live lens run (null on dry-run/refuse). */
  reportPath?: string | null;
  scrub?: {
    ok?: boolean;
    counts?: ScrubCounts;
    bytes?: number;
    refuseReason?: string | null;
  };
  slice?: LensSlice;
  audit?: {
    decision?: string;
    reason?: string | null;
    payloadBytes?: number;
    scrubCounts?: ScrubCounts;
    modelId?: string | null;
  };
  [k: string]: unknown;
};

export type AuditRecord = {
  ts?: string;
  lens?: string;
  decision?: string;
  reason?: string | null;
  payloadBytes?: number;
  modelId?: string | null;
  /** Present when a live lens/summarize run wrote a report file. */
  reportPath?: string | null;
  [k: string]: unknown;
};

/** Machine-readable summarize --json shape (subset the CLI prints). */
export type SummarizeEnvelope = {
  attempted?: number;
  generated?: number;
  refused_scrub?: number;
  failed_parse?: number;
  failed_spawn?: number;
  empty_digest?: number;
  dry_run?: boolean;
  results?: Array<{
    sessionId?: string;
    outcome?: string;
    title?: string;
    estimatedTokens?: number;
    modelId?: string | null;
  }>;
  [k: string]: unknown;
};

export type AuditEnvelope = {
  path?: string;
  n?: number;
  records?: AuditRecord[];
  [k: string]: unknown;
};

/** Operator selection for lens argv (last-n default, optional session target). */
export type LensSelection = {
  lastN: number;
  noSubagents: boolean;
  /** When set, replaces --last-n with --session <id>. */
  sessionId: string | null;
};

// ── Pure helpers (exported for unit tests) ──

/**
 * Whether a dry-run result is safe to offer for live send.
 * decision "refused" → no. decision "dry-run" with a non-dry-run reason → scrub
 * fail-closed → no. decision "dry-run" with scrub-ok reason (or null) → yes.
 */
export function canSend(
  decision: string | null | undefined,
  refuseReason?: string | null,
): boolean {
  if (decision == null || decision === '') return false;
  if (decision === 'refused') return false;
  if (decision === 'accepted') return true;
  if (decision === 'dry-run') {
    if (refuseReason == null || refuseReason === '') return true;
    // Live dry-run success reason from the runner starts with "dry-run:".
    if (refuseReason.startsWith('dry-run:')) return true;
    // Any other reason is a scrub / selection refuse under the dry-run path.
    return false;
  }
  return false;
}

/** Format ingest flash from the CLI JSON envelope. */
export function formatIngestFlash(json: IngestEnvelope | null | undefined): string {
  if (!json || typeof json !== 'object') return 'ingest complete';
  const n = json.sessionDirsIngested;
  if (typeof n === 'number' && Number.isFinite(n)) {
    return `ingested ${n} sessions`;
  }
  const scanned = json.sessionDirsScanned;
  if (typeof scanned === 'number' && Number.isFinite(scanned)) {
    return `ingested ${scanned} sessions`;
  }
  return 'ingest complete';
}

/** Decision string from a lens envelope (audit.decision preferred). */
export function lensDecision(env: LensEnvelope | null | undefined): string | null {
  if (!env) return null;
  const d = env.audit?.decision;
  if (typeof d === 'string' && d.length > 0) return d;
  if (env.dryRun) return 'dry-run';
  if (env.refused) return 'refused';
  return 'accepted';
}

export function lensRefuseReason(env: LensEnvelope | null | undefined): string | null {
  if (!env) return null;
  if (typeof env.refusedReason === 'string') return env.refusedReason;
  if (typeof env.audit?.reason === 'string') return env.audit.reason;
  if (typeof env.scrub?.refuseReason === 'string') return env.scrub.refuseReason;
  return null;
}

export function formatScrubSummary(env: LensEnvelope | null | undefined): string {
  if (!env) return 'no scrub report';
  const counts = env.scrub?.counts ?? env.audit?.scrubCounts;
  const bytes = env.scrub?.bytes ?? env.audit?.payloadBytes;
  const parts: string[] = [];
  if (counts && typeof counts === 'object') {
    for (const key of ['secret', 'email', 'home-path', 'password-assignment'] as const) {
      const v = counts[key];
      if (typeof v === 'number') parts.push(`${key}=${v}`);
    }
    // Any extra classes the envelope may carry.
    for (const [k, v] of Object.entries(counts)) {
      if (
        k === 'secret' ||
        k === 'email' ||
        k === 'home-path' ||
        k === 'password-assignment'
      ) {
        continue;
      }
      if (typeof v === 'number') parts.push(`${k}=${v}`);
    }
  }
  const countStr = parts.length > 0 ? parts.join(' ') : 'counts n/a';
  const byteStr = typeof bytes === 'number' ? `${bytes} B` : 'size n/a';
  const decision = lensDecision(env) ?? '?';
  return `${decision} · ${byteStr} · ${countStr}`;
}

export function formatLensFlash(env: LensEnvelope | null | undefined, live: boolean): string {
  if (!env) return live ? 'lens failed' : 'lens dry-run failed';
  const decision = lensDecision(env) ?? (live ? 'accepted' : 'dry-run');
  const counts = env.scrub?.counts ?? env.audit?.scrubCounts;
  let scrubBit = '';
  if (counts && typeof counts === 'object') {
    const n =
      (counts.secret ?? 0) +
      (counts.email ?? 0) +
      (counts['home-path'] ?? 0) +
      (counts['password-assignment'] ?? 0);
    scrubBit = ` · scrub ${n}`;
  }
  return live ? `lens ${decision}${scrubBit}` : `dry-run ${decision}${scrubBit}`;
}

/** Human size for operator copy (MB uses 1e6 so 1450141 → "1.45 MB"). */
export function formatHumanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'n/a';
  if (bytes >= 1_000_000) {
    const mb = bytes / 1_000_000;
    const s = mb >= 10 ? mb.toFixed(1) : mb.toFixed(2);
    return `${s.replace(/\.?0+$/, '')} MB`;
  }
  if (bytes >= 1000) {
    const kb = bytes / 1024;
    const rounded = Math.round(kb);
    return `${rounded} KB`;
  }
  return `${Math.round(bytes)} B`;
}

/** Short id for operator-facing labels. */
export function shortSessionId(id: string): string {
  if (!id) return '?';
  return id.length > 12 ? `${id.slice(0, 11)}\u2026` : id;
}

export function defaultLensSelection(
  lastN: number = DEFAULT_LAST_N,
  noSubagents = false,
  sessionId: string | null = null,
): LensSelection {
  return {
    lastN: Number.isFinite(lastN) && lastN > 0 ? Math.floor(lastN) : DEFAULT_LAST_N,
    noSubagents: !!noSubagents,
    sessionId: sessionId && sessionId.length > 0 ? sessionId : null,
  };
}

/**
 * Plain selection label for footers / composition:
 * `--last-n 5 · 5 most recent primary sessions` or `--session abc… · --no-subagents`.
 */
export function formatSelectionLabel(sel: LensSelection | number): string {
  const s: LensSelection =
    typeof sel === 'number' ? defaultLensSelection(sel) : sel;
  const parts: string[] = [];
  if (s.sessionId) {
    parts.push(`--session ${shortSessionId(s.sessionId)}`);
  } else {
    const n =
      Number.isFinite(s.lastN) && s.lastN > 0 ? Math.floor(s.lastN) : DEFAULT_LAST_N;
    parts.push(`--last-n ${n} · ${n} most recent primary sessions`);
  }
  if (s.noSubagents) parts.push('--no-subagents');
  return parts.join(' · ');
}

/** Build CLI argv for `speculum lens` (name first; includes --json). */
export function buildLensArgv(
  name: string,
  sel: LensSelection,
  opts?: { dryRun?: boolean },
): string[] {
  const args: string[] = [name];
  if (sel.sessionId) {
    args.push('--session', sel.sessionId);
  } else {
    const n =
      Number.isFinite(sel.lastN) && sel.lastN > 0 ? Math.floor(sel.lastN) : DEFAULT_LAST_N;
    args.push('--last-n', String(n));
  }
  if (sel.noSubagents) args.push('--no-subagents');
  if (opts?.dryRun) args.push('--dry-run');
  args.push('--json');
  return args;
}

/** Step last-n within LAST_N_OPTIONS (wraps). dir -1 = previous, +1 = next. */
export function stepLastN(current: number, dir: -1 | 1): LastNOption {
  const opts = LAST_N_OPTIONS as readonly number[];
  let idx = opts.indexOf(current);
  if (idx < 0) {
    // Snap to nearest option.
    idx = opts.reduce(
      (best, n, i) => (Math.abs(n - current) < Math.abs(opts[best]! - current) ? i : best),
      0,
    );
  }
  const next = (idx + dir + opts.length) % opts.length;
  return LAST_N_OPTIONS[next]!;
}

/** Map a digit key to a last-n option; `0` → 10. */
export function lastNFromDigit(digit: string): LastNOption | null {
  if (digit === '0') return 10;
  const n = Number.parseInt(digit, 10);
  if (!Number.isFinite(n)) return null;
  if ((LAST_N_OPTIONS as readonly number[]).includes(n)) return n as LastNOption;
  return null;
}

/** True when the refuse reason is the oversize / payload-cap path. */
export function isOversizeRefuse(reason: string | null | undefined): boolean {
  if (reason == null || reason === '') return false;
  return /exceeds\s+(?:the\s+)?(?:lens\s+)?cap|payload\s+\d[\d_]*\s*bytes\s+exceeds/i.test(
    reason,
  );
}

function scrubCountsBit(counts: ScrubCounts | null | undefined): string {
  if (!counts || typeof counts !== 'object') return 'scrub: n/a';
  const parts: string[] = [];
  for (const key of ['secret', 'email', 'home-path', 'password-assignment'] as const) {
    const v = counts[key];
    if (typeof v === 'number') parts.push(`${key}=${v}`);
  }
  for (const [k, v] of Object.entries(counts)) {
    if (
      k === 'secret' ||
      k === 'email' ||
      k === 'home-path' ||
      k === 'password-assignment'
    ) {
      continue;
    }
    if (typeof v === 'number') parts.push(`${k}=${v}`);
  }
  return parts.length > 0 ? `scrub: ${parts.join(' ')}` : 'scrub: n/a';
}

/**
 * Live composition read after dry-run:
 * `payload N bytes · cap 100 KB · M turns · S subagents · <selection> · scrub: …`
 */
export function formatComposition(
  env: LensEnvelope | null | undefined,
  sel?: LensSelection | null,
): string {
  if (!env) return 'composition n/a';
  const bytes = env.scrub?.bytes ?? env.audit?.payloadBytes;
  const turns = env.slice?.turnsRendered;
  const subs = env.slice?.subagentCount;
  const counts = env.scrub?.counts ?? env.audit?.scrubCounts;
  const payloadBit =
    typeof bytes === 'number' && Number.isFinite(bytes)
      ? `payload ${bytes} bytes`
      : 'payload n/a';
  const capBit = `cap ${Math.round(LENS_CAP_BYTES / 1024)} KB`;
  const turnsBit =
    typeof turns === 'number' && Number.isFinite(turns) ? `${turns} turns` : 'turns n/a';
  const subBit =
    typeof subs === 'number' && Number.isFinite(subs) ? `${subs} subagents` : 'subagents n/a';
  const bits = [payloadBit, capBit, turnsBit, subBit];
  if (sel) bits.push(formatSelectionLabel(sel));
  bits.push(scrubCountsBit(counts));
  return bits.join(' · ');
}

/** Operator-facing oversize line: `payload 1.45 MB exceeds the 100 KB cap`. */
export function formatOversizeMessage(env: LensEnvelope | null | undefined): string {
  const bytes = env?.scrub?.bytes ?? env?.audit?.payloadBytes;
  if (typeof bytes === 'number' && Number.isFinite(bytes)) {
    return `payload ${formatHumanBytes(bytes)} exceeds the 100 KB cap`;
  }
  return 'payload exceeds the 100 KB cap';
}

/**
 * Narrowing hint when over-cap — always an actionable next step.
 * Progression: lower last-n → toggle no-subagents → pick a session → different lens.
 */
export function formatNarrowHint(
  lastNOrSel: number | LensSelection,
  noSubagents?: boolean,
  sessionId?: string | null,
): string {
  const sel: LensSelection =
    typeof lastNOrSel === 'number'
      ? defaultLensSelection(lastNOrSel, noSubagents ?? false, sessionId ?? null)
      : lastNOrSel;
  if (!sel.noSubagents) {
    if (!sel.sessionId && sel.lastN > 1) {
      return '‹1› or no-subagents (n) — try them';
    }
    return 'toggle no-subagents (n) — often fits';
  }
  if (!sel.sessionId && sel.lastN > 1) {
    return '‹1› likely fits — try it';
  }
  if (!sel.sessionId) {
    return 'pick a session (t) to target one id';
  }
  return 'still over cap — try a different lens';
}

/** Fits verdict line for the dry-run panel (does not replace canSend). */
export function formatFitsVerdict(
  env: LensEnvelope | null | undefined,
  decision: string | null | undefined,
  reason: string | null | undefined,
): string {
  if (canSend(decision, reason)) return 'sendable — confirm to invoke model';
  if (isOversizeRefuse(reason)) return 'over cap — narrow';
  return 'not sendable — confirm disabled';
}

/** One-line recent-session row for the in-panel picker. */
export function formatRecentSessionLine(
  s: SessionListRow,
  selected: boolean,
): string {
  const prefix = selected ? '>' : ' ';
  const id = shortSessionId(s.id);
  const turns = Number.isFinite(s.turnCount) ? s.turnCount : 0;
  const proj = (() => {
    const p = s.projectPath || '';
    if (!p) return '?';
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || p;
  })();
  return `${prefix}${id}  t:${turns}  ${proj}`;
}

/** Load recent primary sessions from the derived index (readonly; best-effort). */
export function loadRecentSessions(limit = RECENT_SESSION_LIMIT): SessionListRow[] {
  try {
    const qs = openQueryService();
    try {
      const list = qs.sessionList(Math.max(limit * 2, limit), 0);
      return list.filter((r) => r.agent !== 'subagent').slice(0, limit);
    } finally {
      qs.close();
    }
  } catch {
    return [];
  }
}

function formatAuditRow(r: AuditRecord, selected = false): string {
  const mark = selected ? '>' : ' ';
  const ts = typeof r.ts === 'string' ? r.ts.slice(11, 19) : '??:??:??';
  const lens = typeof r.lens === 'string' ? r.lens : '?';
  const decision = typeof r.decision === 'string' ? r.decision : '?';
  const hasReport =
    typeof r.reportPath === 'string' && r.reportPath.length > 0 ? ' · md' : '';
  const reason =
    typeof r.reason === 'string' && r.reason.length > 0
      ? r.reason.length > 36
        ? `${r.reason.slice(0, 35)}\u2026`
        : r.reason
      : '';
  return `${mark}${ts} ${decision} ${lens}${hasReport}${reason ? ` (${reason})` : ''}`;
}

/** True when path exists and is a regular file (stat before open). */
export function reportFileExists(path: string | null | undefined): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  try {
    if (!existsSync(path)) return false;
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Read a report file for the markdown overlay; null when gone. */
export function readReportBody(path: string): string | null {
  try {
    if (!reportFileExists(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Build CLI argv for `speculum summarize` (includes --json). */
export function buildSummarizeArgv(opts?: {
  dryRun?: boolean;
  limit?: number;
  sessionId?: string | null;
  all?: boolean;
  force?: boolean;
}): string[] {
  const args: string[] = [];
  if (opts?.sessionId) {
    args.push('--session', opts.sessionId);
  } else if (opts?.all) {
    args.push('--all');
  } else if (opts?.limit != null && Number.isFinite(opts.limit) && opts.limit > 0) {
    args.push('--limit', String(Math.floor(opts.limit)));
  }
  if (opts?.force) args.push('--force');
  if (opts?.dryRun) args.push('--dry-run');
  args.push('--json');
  return args;
}

/** Confirm copy for summarize plan — names egress plainly. */
export function formatSummarizePlan(env: SummarizeEnvelope | null | undefined): string {
  const n =
    typeof env?.attempted === 'number' && Number.isFinite(env.attempted)
      ? env.attempted
      : Array.isArray(env?.results)
        ? env!.results!.length
        : 0;
  const refused =
    typeof env?.refused_scrub === 'number' ? env.refused_scrub : 0;
  const bits = [`Generate titles for ${n} session(s)`];
  if (refused > 0) bits.push(`${refused} scrub-refused in plan`);
  // Cost shape: count only — CLI --json subset does not emit token estimates.
  bits.push('model routes via local config');
  return `${bits.join(' · ')}. Content leaves this machine scrubbed and audited.`;
}

export function formatSummarizeFlash(
  env: SummarizeEnvelope | null | undefined,
  live: boolean,
): string {
  if (!env) return live ? 'summarize failed' : 'summarize dry-run failed';
  const attempted =
    typeof env.attempted === 'number' ? env.attempted : env.results?.length ?? 0;
  if (!live) return `summarize plan · ${attempted} session(s)`;
  const gen = typeof env.generated === 'number' ? env.generated : 0;
  return `summarize · ${gen} titled · ${attempted} attempted`;
}

/** Whether a summarize dry-run plan is worth offering for live confirm. */
export function canSummarizeSend(env: SummarizeEnvelope | null | undefined): boolean {
  if (!env) return false;
  const n =
    typeof env.attempted === 'number'
      ? env.attempted
      : Array.isArray(env.results)
        ? env.results.length
        : 0;
  return n > 0;
}

function errorFlash(r: SpeculumResult<unknown>, verb: string): string {
  if (r.ok) return `${verb} ok`;
  const k = r.error.kind;
  if (k === 'not-installed') return `speculum not installed — ${INSTALL_HINT}`;
  if (k === 'timeout') return `${verb} timed out`;
  if (k === 'nonzero') {
    const tail = r.error.stderrTail?.trim();
    return tail ? `${verb} failed: ${tail.slice(0, 60)}` : `${verb} failed`;
  }
  if (k === 'parse-failed') return `${verb}: bad JSON`;
  return `${verb} failed`;
}

// ── Fixed-slot row (opaque bg — OpenTUI spaces do not clear cells) ──

function FixedClearRow({
  text,
  width,
  color,
}: {
  text: string;
  width: number;
  color: string;
}) {
  const t = usePalette();
  const cell = text.length === width ? text : formatLucernaDisplayLine(text, width);
  return (
    <box
      height={1}
      width={width}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={t.background}
    >
      <text fg={color} wrapMode="none">
        {cell}
      </text>
    </box>
  );
}

/** last-n stepper: chips + ‹ ›, keyboard ←/→ / digits and click. */
function LastNStepper({
  lastN,
  onChange,
  width,
  disabled,
}: {
  lastN: number;
  onChange: (n: LastNOption) => void;
  width: number;
  disabled?: boolean;
}) {
  const t = usePalette();
  const chip = (n: LastNOption) => {
    const on = n === lastN;
    return (
      <box
        key={n}
        flexShrink={0}
        marginRight={1}
        backgroundColor={on ? t.selection : t.background}
        onMouseDown={disabled ? undefined : () => onChange(n)}
      >
        <text fg={on ? t.primary : t.muted} wrapMode="none">
          {on ? `[${n}]` : `${n}`}
        </text>
      </box>
    );
  };
  return (
    <box flexDirection="column" flexShrink={0} width={width}>
      <box flexDirection="row" flexShrink={0} height={1} overflow="hidden">
        <box
          flexShrink={0}
          marginRight={1}
          backgroundColor={t.background}
          onMouseDown={disabled ? undefined : () => onChange(stepLastN(lastN, -1))}
        >
          <text fg={t.muted} wrapMode="none">
            ‹
          </text>
        </box>
        {LAST_N_OPTIONS.map((n) => chip(n))}
        <box
          flexShrink={0}
          backgroundColor={t.background}
          onMouseDown={disabled ? undefined : () => onChange(stepLastN(lastN, 1))}
        >
          <text fg={t.muted} wrapMode="none">
            ›
          </text>
        </box>
      </box>
    </box>
  );
}

/** no-subagents chip + selection summary row. */
function SelectionChrome({
  sel,
  width,
  onToggleNoSub,
  disabled,
}: {
  sel: LensSelection;
  width: number;
  onToggleNoSub: () => void;
  disabled?: boolean;
}) {
  const t = usePalette();
  const on = sel.noSubagents;
  return (
    <box flexDirection="column" flexShrink={0} width={width}>
      <box flexDirection="row" flexShrink={0} height={1} overflow="hidden">
        <box
          flexShrink={0}
          marginRight={1}
          backgroundColor={on ? t.selection : t.background}
          onMouseDown={disabled ? undefined : onToggleNoSub}
        >
          <text fg={on ? t.primary : t.muted} wrapMode="none">
            {on ? '[no-subagents]' : 'no-subagents'}
          </text>
        </box>
      </box>
      <FixedClearRow
        width={width}
        color={t.muted}
        text={formatLucernaDisplayLine(formatSelectionLabel(sel), width)}
      />
    </box>
  );
}

// ── Component ──

type PanelMode = 'none' | 'picker' | 'dry-run' | 'audit' | 'summarize';

export function SpeculumActions({
  inputActive,
  onFlash,
  onCapture,
  lensPrefill,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  onCapture?: (b: boolean) => void;
  /**
   * Session handed off from a stage (probe hit rows): opens the lens picker
   * with this session preselected. `key` bumps per handoff so repeats fire.
   */
  lensPrefill?: { sessionId: string; key: number } | null;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const rowW = Math.max(24, dims.width - 4);

  const [installed, setInstalled] = useState<boolean | null>(null); // null = probing
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelMode>('none');
  const [pickerIdx, setPickerIdx] = useState(0);
  const [lastN, setLastN] = useState<LastNOption>(DEFAULT_LAST_N);
  const [noSubagents, setNoSubagents] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionPickOpen, setSessionPickOpen] = useState(false);
  const [sessionPickIdx, setSessionPickIdx] = useState(0);
  const [recentSessions, setRecentSessions] = useState<SessionListRow[]>([]);
  const [dryRunEnv, setDryRunEnv] = useState<LensEnvelope | null>(null);
  const [selectedLens, setSelectedLens] = useState<BuiltinLens | null>(null);
  const [confirm, setConfirm] = useState<{ msg: string; run: () => void } | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRecord[]>([]);
  const [auditCursor, setAuditCursor] = useState(0);
  const [localFlash, setLocalFlash] = useState<string | null>(null);
  const [reportView, setReportView] = useState<{ path: string; body: string } | null>(
    null,
  );
  const [summarizeEnv, setSummarizeEnv] = useState<SummarizeEnvelope | null>(null);
  const prefillKeyRef = useRef<number | null>(null);

  const dryGenRef = useRef(0);
  const dryRerunTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNRef = useRef(lastN);
  lastNRef.current = lastN;
  const noSubRef = useRef(noSubagents);
  noSubRef.current = noSubagents;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const selectedLensRef = useRef(selectedLens);
  selectedLensRef.current = selectedLens;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const installedRef = useRef(installed);
  installedRef.current = installed;

  const currentSel = useCallback(
    (): LensSelection =>
      defaultLensSelection(lastNRef.current, noSubRef.current, sessionIdRef.current),
    [],
  );

  const flash = useCallback(
    (msg: string) => {
      setLocalFlash(msg);
      onFlash?.(msg);
    },
    [onFlash],
  );

  const capturing =
    !!busy ||
    panel === 'picker' ||
    panel === 'dry-run' ||
    panel === 'audit' ||
    panel === 'summarize' ||
    !!confirm ||
    !!reportView;

  useEffect(() => {
    onCapture?.(capturing);
  }, [capturing, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  // Drop modal/panel claim when the member loses input focus.
  useEffect(() => {
    if (!inputActive) {
      setConfirm(null);
      setSessionPickOpen(false);
      if (panel === 'picker' || panel === 'dry-run' || panel === 'summarize') {
        setPanel('none');
      }
    }
  }, [inputActive, panel]);

  /** Open a report path in the shared markdown overlay (stat first; soft flash if gone). */
  const openReportPath = useCallback(
    (path: string | null | undefined) => {
      if (typeof path !== 'string' || path.length === 0) {
        flash('no report path');
        return;
      }
      const body = readReportBody(path);
      if (body == null) {
        flash('report gone');
        return;
      }
      setReportView({ path, body });
    },
    [flash],
  );

  // Lens prefill seam: on key bump, open picker with that session preselected.
  // Repeat bumps re-fire even for the same sessionId.
  useEffect(() => {
    if (!lensPrefill) return;
    if (prefillKeyRef.current === lensPrefill.key) return;
    prefillKeyRef.current = lensPrefill.key;
    const id = lensPrefill.sessionId?.trim();
    if (!id) return;
    setSessionId(id);
    sessionIdRef.current = id;
    setLastN(DEFAULT_LAST_N);
    lastNRef.current = DEFAULT_LAST_N;
    setNoSubagents(false);
    noSubRef.current = false;
    setSessionPickOpen(false);
    setDryRunEnv(null);
    setSelectedLens(null);
    setConfirm(null);
    setPickerIdx(0);
    setReportView(null);
    setPanel('picker');
  }, [lensPrefill]);

  // Probe install once on mount (audit is read-only JSON).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await runSpeculum<AuditEnvelope>('audit', ['-n', '1', '--json']);
      if (!alive) return;
      if (!r.ok && r.error.kind === 'not-installed') {
        setInstalled(false);
        return;
      }
      setInstalled(true);
      // Seed audit rows if the probe returned them.
      if (r.ok && Array.isArray(r.json.records)) {
        setAuditRows(r.json.records.slice(-AUDIT_SHOW_SLOTS));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Clear pending re-dry-run timer on unmount.
  useEffect(
    () => () => {
      if (dryRerunTimer.current) clearTimeout(dryRerunTimer.current);
    },
    [],
  );

  const closePanels = useCallback(() => {
    if (dryRerunTimer.current) {
      clearTimeout(dryRerunTimer.current);
      dryRerunTimer.current = null;
    }
    dryGenRef.current += 1; // invalidate in-flight dry-run
    setPanel('none');
    setDryRunEnv(null);
    setSelectedLens(null);
    setConfirm(null);
    setSessionPickOpen(false);
    setSummarizeEnv(null);
  }, []);

  const runIngest = useCallback(async () => {
    if (busy || installed === false) return;
    setBusy('ingesting…');
    try {
      const r = await runSpeculum<IngestEnvelope>('ingest', ['--json']);
      if (!r.ok) {
        if (r.error.kind === 'not-installed') setInstalled(false);
        flash(errorFlash(r, 'ingest'));
        return;
      }
      setInstalled(true);
      flash(formatIngestFlash(r.json));
    } finally {
      setBusy(null);
    }
  }, [busy, installed, flash]);

  const runLensLive = useCallback(
    async (name: BuiltinLens, sel?: LensSelection) => {
      if (busyRef.current || installedRef.current === false) return;
      const useSel = sel ?? currentSel();
      setBusy(`lens ${name}…`);
      try {
        const r = await runSpeculum<LensEnvelope>(
          'lens',
          buildLensArgv(name, useSel, { dryRun: false }),
        );
        if (!r.ok) {
          if (r.error.kind === 'not-installed') setInstalled(false);
          flash(errorFlash(r, 'lens'));
          return;
        }
        setInstalled(true);
        setDryRunEnv(r.json);
        flash(formatLensFlash(r.json, true));
        // Live lens writes a dated report — open it in the shared markdown view.
        const path =
          typeof r.json.reportPath === 'string' && r.json.reportPath.length > 0
            ? r.json.reportPath
            : null;
        if (path) {
          const body = readReportBody(path);
          if (body != null) setReportView({ path, body });
          else flash('lens accepted · report gone');
        }
      } finally {
        setBusy(null);
        setConfirm(null);
        setPanel('none');
        setSelectedLens(null);
        setSessionPickOpen(false);
      }
    },
    [flash, currentSel],
  );

  const runSummarizeLive = useCallback(async () => {
    if (busyRef.current || installedRef.current === false) return;
    setBusy('summarize…');
    try {
      const r = await runSpeculum<SummarizeEnvelope>(
        'summarize',
        buildSummarizeArgv({ dryRun: false }),
      );
      if (!r.ok) {
        if (r.error.kind === 'not-installed') setInstalled(false);
        flash(errorFlash(r, 'summarize'));
        return;
      }
      setInstalled(true);
      setSummarizeEnv(r.json);
      flash(formatSummarizeFlash(r.json, true));
    } finally {
      setBusy(null);
      setConfirm(null);
      setPanel('none');
    }
  }, [flash]);

  const runSummarizeDry = useCallback(async () => {
    if (installedRef.current === false || busyRef.current) return;
    const gen = ++dryGenRef.current;
    setBusy('summarize dry-run…');
    setPanel('summarize');
    setSummarizeEnv(null);
    setConfirm(null);
    setSessionPickOpen(false);
    try {
      const r = await runSpeculum<SummarizeEnvelope>(
        'summarize',
        buildSummarizeArgv({ dryRun: true }),
      );
      if (gen !== dryGenRef.current) return;
      if (!r.ok) {
        if (r.error.kind === 'not-installed') setInstalled(false);
        flash(errorFlash(r, 'summarize dry-run'));
        setPanel('none');
        return;
      }
      setInstalled(true);
      setSummarizeEnv(r.json);
      flash(formatSummarizeFlash(r.json, false));
      if (canSummarizeSend(r.json)) {
        setConfirm({
          msg: formatSummarizePlan(r.json),
          run: () => {
            void runSummarizeLive();
          },
        });
      } else {
        flash('summarize plan · no sessions matched');
      }
    } finally {
      if (gen === dryGenRef.current) setBusy(null);
    }
  }, [flash, runSummarizeLive]);

  const runLensDry = useCallback(
    async (name: BuiltinLens, sel?: LensSelection) => {
      if (installedRef.current === false) return;
      const useSel = sel ?? currentSel();
      const gen = ++dryGenRef.current;
      setSelectedLens(name);
      setBusy(`lens dry-run ${name}…`);
      setPanel('dry-run');
      setDryRunEnv(null);
      setConfirm(null);
      setSessionPickOpen(false);
      try {
        const r = await runSpeculum<LensEnvelope>(
          'lens',
          buildLensArgv(name, useSel, { dryRun: true }),
        );
        if (gen !== dryGenRef.current) return; // stale — a newer selection won
        if (!r.ok) {
          if (r.error.kind === 'not-installed') setInstalled(false);
          flash(errorFlash(r, 'lens dry-run'));
          setPanel('none');
          return;
        }
        setInstalled(true);
        setDryRunEnv(r.json);
        const decision = lensDecision(r.json);
        const reason = lensRefuseReason(r.json);
        if (canSend(decision, reason)) {
          const model =
            (typeof r.json.modelId === 'string' && r.json.modelId) ||
            (typeof r.json.audit?.modelId === 'string' && r.json.audit.modelId) ||
            null;
          const msg = model
            ? `Send scrubbed slice to ${model}?`
            : 'Send scrubbed slice to the model the local config routes to?';
          const selAtConfirm = useSel;
          setConfirm({
            msg,
            run: () => {
              void runLensLive(name, selAtConfirm);
            },
          });
        }
      } finally {
        if (gen === dryGenRef.current) setBusy(null);
      }
    },
    [flash, runLensLive, currentSel],
  );

  /** Debounced re-dry-run on the dry-run panel after a selection change. */
  const scheduleReDry = useCallback(
    (sel: LensSelection) => {
      setConfirm(null);
      if (panelRef.current !== 'dry-run' || !selectedLensRef.current) return;
      if (dryRerunTimer.current) clearTimeout(dryRerunTimer.current);
      const lens = selectedLensRef.current;
      dryRerunTimer.current = setTimeout(() => {
        dryRerunTimer.current = null;
        void runLensDry(lens, sel);
      }, LAST_N_DEBOUNCE_MS);
    },
    [runLensDry],
  );

  /** Apply a new last-n (clears session target — last-n is the no-target default). */
  const applyLastN = useCallback(
    (n: LastNOption) => {
      setLastN(n);
      lastNRef.current = n;
      setSessionId(null);
      sessionIdRef.current = null;
      setSessionPickOpen(false);
      scheduleReDry(defaultLensSelection(n, noSubRef.current, null));
    },
    [scheduleReDry],
  );

  const applyNoSubagents = useCallback(
    (on: boolean) => {
      setNoSubagents(on);
      noSubRef.current = on;
      scheduleReDry(defaultLensSelection(lastNRef.current, on, sessionIdRef.current));
    },
    [scheduleReDry],
  );

  const applySessionId = useCallback(
    (id: string | null) => {
      setSessionId(id);
      sessionIdRef.current = id;
      setSessionPickOpen(false);
      scheduleReDry(defaultLensSelection(lastNRef.current, noSubRef.current, id));
    },
    [scheduleReDry],
  );

  const openSessionPick = useCallback(() => {
    const list = loadRecentSessions(RECENT_SESSION_LIMIT);
    setRecentSessions(list);
    // Prefer the currently targeted id, else the dry-run envelope's first selection id.
    const prefer =
      sessionIdRef.current ??
      (typeof dryRunEnv?.slice?.selectionSessionIds?.[0] === 'string'
        ? dryRunEnv.slice.selectionSessionIds[0]
        : null);
    let idx = 0;
    if (prefer) {
      const found = list.findIndex((s) => s.id === prefer || s.id.startsWith(prefer));
      if (found >= 0) idx = found;
    }
    setSessionPickIdx(idx);
    setSessionPickOpen(true);
  }, [dryRunEnv]);

  const loadAudit = useCallback(async () => {
    if (busy || installed === false) return;
    setBusy('audit…');
    try {
      const r = await runSpeculum<AuditEnvelope>('audit', [
        '-n',
        String(AUDIT_FETCH_N),
        '--json',
      ]);
      if (!r.ok) {
        if (r.error.kind === 'not-installed') {
          setInstalled(false);
          flash(errorFlash(r, 'audit'));
          return;
        }
        // TTY-only / parse miss: try raw stdout lines defensively.
        if (r.error.kind === 'parse-failed' && r.error.stdoutTail) {
          const lines = r.error.stdoutTail
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-AUDIT_SHOW_SLOTS);
          setAuditRows(
            lines.map((line) => ({
              ts: '',
              lens: '',
              decision: line.slice(0, 80),
              reason: null,
            })),
          );
          setAuditCursor(0);
          setPanel('audit');
          return;
        }
        flash(errorFlash(r, 'audit'));
        return;
      }
      setInstalled(true);
      const rows = Array.isArray(r.json.records) ? r.json.records : [];
      const slice = rows.slice(-AUDIT_SHOW_SLOTS);
      setAuditRows(slice);
      setAuditCursor(Math.max(0, slice.length - 1));
      setPanel('audit');
    } finally {
      setBusy(null);
    }
  }, [busy, installed, flash]);

  useKeyboard((key: { name?: string; sequence?: string; shift?: boolean; ctrl?: boolean }) => {
    if (!inputActive) return;
    if (busy) return;

    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    const seq = key.sequence ?? '';
    const shift = !!key.shift;
    const isL = (n === 'l' && shift) || seq === 'L';
    const isA = (n === 'a' && shift) || seq === 'A';
    const isT = (n === 't' && shift) || seq === 'T';

    // Report markdown overlay owns esc (and swallows other keys while open).
    if (reportView) {
      if (n === 'escape') {
        setReportView(null);
        return;
      }
      return;
    }

    // Session target picker owns navigation while open.
    if (sessionPickOpen && (panel === 'picker' || panel === 'dry-run')) {
      if (n === 'escape') {
        setSessionPickOpen(false);
        return;
      }
      if (n === 'up' || n === 'k') {
        setSessionPickIdx((i) =>
          recentSessions.length === 0
            ? 0
            : (i - 1 + recentSessions.length) % recentSessions.length,
        );
        return;
      }
      if (n === 'down' || n === 'j') {
        setSessionPickIdx((i) =>
          recentSessions.length === 0 ? 0 : (i + 1) % recentSessions.length,
        );
        return;
      }
      if (n === 'return' || n === 'enter') {
        const row = recentSessions[sessionPickIdx];
        if (row) applySessionId(row.id);
        else setSessionPickOpen(false);
        return;
      }
      if (n === 'c' && !shift) {
        applySessionId(null);
        return;
      }
      return;
    }

    // Shared selection keys (picker + dry-run). Works even while ConfirmModal
    // is up: re-slicing clears confirm and re-runs dry-run (y/n/esc still modal-owned).
    const handleSelectionKeys = (): boolean => {
      if (n === 'left' || n === 'h') {
        applyLastN(stepLastN(lastN, -1));
        return true;
      }
      if (n === 'right' || (n === 'l' && !shift && seq !== 'L')) {
        // bare `l` (not shift-L) steps last-n while panel owns the keyboard
        applyLastN(stepLastN(lastN, 1));
        return true;
      }
      // Digit keys → direct option (0 → 10). Clears session target.
      const digit =
        n.length === 1 && n >= '0' && n <= '9'
          ? n
          : seq.length === 1 && seq >= '0' && seq <= '9'
            ? seq
            : null;
      if (digit) {
        const mapped = lastNFromDigit(digit);
        if (mapped != null) {
          applyLastN(mapped);
          return true;
        }
      }
      // n → toggle no-subagents (ConfirmModal owns bare n for cancel while open)
      if (n === 'n' && !shift) {
        if (confirm) return false;
        applyNoSubagents(!noSubRef.current);
        return true;
      }
      // t → open recent-session target picker
      if (n === 't' && !shift) {
        openSessionPick();
        return true;
      }
      // c → clear session target (back to last-n)
      if (n === 'c' && !shift && sessionIdRef.current) {
        applySessionId(null);
        return true;
      }
      return false;
    };

    if (panel === 'picker' || panel === 'dry-run') {
      if (handleSelectionKeys()) return;
    }

    // Confirm modal owns y/n/esc while active — block other panel keys.
    if (confirm) return;

    if (n === 'escape') {
      if (panel !== 'none') {
        closePanels();
        return;
      }
      return;
    }

    // Lens picker navigation.
    if (panel === 'picker') {
      if (n === 'up' || n === 'k') {
        setPickerIdx((i) => (i - 1 + BUILTIN_LENSES.length) % BUILTIN_LENSES.length);
        return;
      }
      if (n === 'down' || n === 'j') {
        setPickerIdx((i) => (i + 1) % BUILTIN_LENSES.length);
        return;
      }
      if (n === 'return' || n === 'enter') {
        const lens = BUILTIN_LENSES[pickerIdx]!;
        void runLensDry(lens, currentSel());
        return;
      }
      return;
    }

    // Dry-run report: enter re-runs dry-run; esc closes; confirm is separate modal when sendable.
    if (panel === 'dry-run') {
      if (n === 'return' || n === 'enter') {
        // Enter re-runs immediately (no debounce wait).
        if (selectedLens) {
          if (dryRerunTimer.current) {
            clearTimeout(dryRerunTimer.current);
            dryRerunTimer.current = null;
          }
          void runLensDry(selectedLens, currentSel());
        }
        return;
      }
      return;
    }

    // Summarize plan panel: esc closes (confirm owns y/n while up).
    if (panel === 'summarize') {
      return;
    }

    // Audit tail: ↑↓ select · enter opens report when file still exists.
    if (panel === 'audit') {
      if (n === 'up' || n === 'k') {
        setAuditCursor((i) => Math.max(0, i - 1));
        return;
      }
      if (n === 'down' || n === 'j') {
        setAuditCursor((i) => Math.min(Math.max(0, auditRows.length - 1), i + 1));
        return;
      }
      if (n === 'return' || n === 'enter') {
        const row = auditRows[auditCursor];
        if (!row) return;
        const path =
          typeof row.reportPath === 'string' && row.reportPath.length > 0
            ? row.reportPath
            : null;
        if (!path) {
          flash('no report for this row');
          return;
        }
        openReportPath(path);
        return;
      }
      return;
    }

    if (installed === false) return; // keys inert when not installed

    if (n === 'i' && !shift) {
      void runIngest();
      return;
    }
    if (isL) {
      setPickerIdx(0);
      setLastN(DEFAULT_LAST_N);
      lastNRef.current = DEFAULT_LAST_N;
      setNoSubagents(false);
      noSubRef.current = false;
      setSessionId(null);
      sessionIdRef.current = null;
      setSessionPickOpen(false);
      setDryRunEnv(null);
      setSelectedLens(null);
      setConfirm(null);
      setPanel('picker');
      return;
    }
    if (isT) {
      void runSummarizeDry();
      return;
    }
    if (isA) {
      if (panel === 'audit') {
        setPanel('none');
        return;
      }
      void loadAudit();
      return;
    }
  });

  const selNow = defaultLensSelection(lastN, noSubagents, sessionId);
  const envelopeSessionId =
    typeof dryRunEnv?.slice?.selectionSessionIds?.[0] === 'string'
      ? dryRunEnv.slice.selectionSessionIds[0]
      : typeof dryRunEnv?.slice?.sessionId === 'string'
        ? dryRunEnv.slice.sessionId
        : null;

  const footerHint = (() => {
    // Context strip only while a panel/confirm/busy is open — idle has zero chrome
    // (global i/L/A live on the member footer once).
    if (localFlash) return localFlash;
    if (busy) return busy;
    if (installed === false) return `speculum not installed — ${INSTALL_HINT}`;
    if (sessionPickOpen && (panel === 'picker' || panel === 'dry-run')) {
      return 'up/dn pick session · enter target · c clear · esc back';
    }
    if (panel === 'picker') {
      return `up/dn · ←/→ last-n · n no-sub · t session · enter dry-run · esc · ${formatSelectionLabel(selNow)}`;
    }
    if (panel === 'dry-run') {
      const decision = lensDecision(dryRunEnv);
      const reason = lensRefuseReason(dryRunEnv);
      if (canSend(decision, reason)) {
        return 'confirm: y send · n/esc cancel · ←/→ re-slice · t session';
      }
      if (isOversizeRefuse(reason)) {
        return `over cap · ${formatNarrowHint(selNow)} · esc close`;
      }
      return 'slice not sendable · ←/→ re-slice · n no-sub · t session · esc close';
    }
    if (panel === 'summarize') {
      if (canSummarizeSend(summarizeEnv)) {
        return 'confirm: y run · n/esc cancel · content leaves scrubbed';
      }
      return 'no sessions matched · esc close';
    }
    if (panel === 'audit') {
      return '↑↓ row · enter open report · A close';
    }
    return '';
  })();

  // Idle + installed: no strip (keyboard still lives on this component).
  // Flash for idle work lands on the member footer via onFlash.
  // Report overlay is keep-mounted on both idle and context paths.
  const contextOpen =
    panel !== 'none' || !!busy || !!confirm || installed === false;

  // ── not-installed ──
  if (installed === false) {
    return (
      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
        backgroundColor={t.background}
      >
        <Panel title="Speculum" flexShrink={0}>
          <box flexDirection="column">
            <text fg={t.foreground}>speculum is not installed</text>
            <text fg={t.muted}>{`Install with: ${INSTALL_HINT}`}</text>
            <text fg={t.muted}>Keys i / L / A are inert until the binary is on PATH.</text>
          </box>
        </Panel>
        <box flexDirection="row" flexShrink={0} height={1} overflow="hidden" marginTop={1} backgroundColor={t.background}>
          <text fg={t.muted} wrapMode="none">
            {formatLucernaDisplayLine(footerHint, Math.max(16, dims.width - 2))}
          </text>
        </box>
      </box>
    );
  }

  const showPicker = panel === 'picker';
  const showDryRun = panel === 'dry-run';
  const showAudit = panel === 'audit';
  const showSummarize = panel === 'summarize';
  const auditSlice = auditRows.slice(-AUDIT_SHOW_SLOTS);
  const headerRight = sessionId
    ? `--session ${shortSessionId(sessionId)}${noSubagents ? ' · no-sub' : ''}`
    : `--last-n ${lastN}${noSubagents ? ' · no-sub' : ''}`;

  const reportModalW = Math.min(Math.max(40, dims.width - 4), 100);
  const reportModalH = Math.min(Math.max(10, dims.height - 4), 36);

  // Keep-mounted report overlay + confirm (OpenTUI crash law: never mount/unmount).
  const reportOverlay = (
    <Modal
      title={reportView ? basename(reportView.path) : 'Report'}
      width={reportModalW}
      height={reportModalH}
      visible={!!reportView}
    >
      <box flexDirection="column" flexGrow={1} minHeight={0}>
        <MarkdownView
          body={reportView?.body ?? ''}
          inputActive={!!reportView && !!inputActive}
        />
        <box flexShrink={0} height={1} overflow="hidden" backgroundColor={t.background}>
          <text fg={t.muted} wrapMode="none">
            {formatLucernaDisplayLine('esc close · read-only report', reportModalW - 4)}
          </text>
        </box>
      </box>
    </Modal>
  );

  // Idle path: zero chrome (no margin, no footer strip). Confirm + report stay mounted.
  if (!contextOpen) {
    return (
      <>
        {reportOverlay}
        <ConfirmModal
          active={false}
          message=""
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      </>
    );
  }

  const renderSessionPick = () => (
    <box flexDirection="column" flexShrink={0}>
      <FixedClearRow
        width={rowW}
        color={t.info}
        text={formatLucernaDisplayLine(
          recentSessions.length > 0
            ? `pick session (${recentSessions.length} recent)`
            : 'no recent sessions in index',
          rowW,
        )}
      />
      {recentSessions.length === 0 ? (
        <FixedClearRow
          width={rowW}
          color={t.muted}
          text={formatLucernaDisplayLine('open index empty or unavailable · esc back', rowW)}
        />
      ) : (
        recentSessions.slice(0, 8).map((s, i) => (
          <FixedClearRow
            key={s.id}
            width={rowW}
            color={i === sessionPickIdx ? t.info : t.foreground}
            text={formatLucernaDisplayLine(
              formatRecentSessionLine(s, i === sessionPickIdx),
              rowW,
            )}
          />
        ))
      )}
    </box>
  );

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      paddingLeft={1}
      paddingRight={1}
      marginTop={1}
      backgroundColor={t.background}
    >
      {busy ? (
        <box flexShrink={0} height={1} overflow="hidden" backgroundColor={t.background}>
          <text fg={t.info} wrapMode="none">
            {formatLucernaDisplayLine(busy, Math.max(16, dims.width - 2))}
          </text>
        </box>
      ) : null}

      {showPicker ? (
        <Panel title="Lens picker" flexShrink={0} headerRight={headerRight}>
          <box flexDirection="column" flexShrink={0}>
            <LastNStepper lastN={lastN} onChange={applyLastN} width={rowW} />
            <SelectionChrome
              sel={selNow}
              width={rowW}
              onToggleNoSub={() => applyNoSubagents(!noSubagents)}
            />
            {sessionPickOpen ? (
              renderSessionPick()
            ) : (
              BUILTIN_LENSES.map((name, idx) => {
                const selected = idx === pickerIdx;
                const prefix = selected ? '>' : ' ';
                return (
                  <FixedClearRow
                    key={name}
                    width={rowW}
                    color={selected ? t.info : t.foreground}
                    text={formatLucernaDisplayLine(`${prefix} ${name}`, rowW)}
                  />
                );
              })
            )}
          </box>
        </Panel>
      ) : null}

      {showDryRun ? (
        <Panel
          title={selectedLens ? `Lens dry-run · ${selectedLens}` : 'Lens dry-run'}
          flexShrink={0}
          headerRight={headerRight}
        >
          <box flexDirection="column" flexShrink={0}>
            <LastNStepper
              lastN={lastN}
              onChange={applyLastN}
              width={rowW}
              disabled={!!busy}
            />
            <SelectionChrome
              sel={selNow}
              width={rowW}
              onToggleNoSub={() => applyNoSubagents(!noSubagents)}
              disabled={!!busy}
            />
            {sessionPickOpen ? (
              renderSessionPick()
            ) : busy && !dryRunEnv ? (
              <FixedClearRow
                width={rowW}
                color={t.info}
                text={formatLucernaDisplayLine('running dry-run…', rowW)}
              />
            ) : (
              <>
                <FixedClearRow
                  width={rowW}
                  color={t.muted}
                  text={formatLucernaDisplayLine(
                    envelopeSessionId
                      ? `slice session ${shortSessionId(envelopeSessionId)}${
                          sessionId ? '' : ' · t pick · c clear target'
                        }`
                      : 'slice session n/a · t pick session',
                    rowW,
                  )}
                />
                <FixedClearRow
                  width={rowW}
                  color={t.foreground}
                  text={formatLucernaDisplayLine(
                    formatComposition(dryRunEnv, selNow),
                    rowW,
                  )}
                />
                <FixedClearRow
                  width={rowW}
                  color={t.muted}
                  text={formatLucernaDisplayLine(formatScrubSummary(dryRunEnv), rowW)}
                />
                {isOversizeRefuse(lensRefuseReason(dryRunEnv)) ? (
                  <>
                    <FixedClearRow
                      width={rowW}
                      color={t.warning}
                      text={formatLucernaDisplayLine(
                        formatOversizeMessage(dryRunEnv),
                        rowW,
                      )}
                    />
                    <FixedClearRow
                      width={rowW}
                      color={t.muted}
                      text={formatLucernaDisplayLine(
                        `${formatSelectionLabel(selNow)} · ${formatNarrowHint(selNow)}`,
                        rowW,
                      )}
                    />
                  </>
                ) : (
                  <FixedClearRow
                    width={rowW}
                    color={t.muted}
                    text={formatLucernaDisplayLine(
                      `reason: ${lensRefuseReason(dryRunEnv) ?? '—'}`,
                      rowW,
                    )}
                  />
                )}
                <FixedClearRow
                  width={rowW}
                  color={
                    canSend(lensDecision(dryRunEnv), lensRefuseReason(dryRunEnv))
                      ? t.success
                      : t.warning
                  }
                  text={formatLucernaDisplayLine(
                    formatFitsVerdict(
                      dryRunEnv,
                      lensDecision(dryRunEnv),
                      lensRefuseReason(dryRunEnv),
                    ),
                    rowW,
                  )}
                />
              </>
            )}
          </box>
        </Panel>
      ) : null}

      {showSummarize ? (
        <Panel title="Summarize plan" flexShrink={0} headerRight="dry-run">
          <box flexDirection="column" flexShrink={0}>
            {busy && !summarizeEnv ? (
              <FixedClearRow
                width={rowW}
                color={t.info}
                text={formatLucernaDisplayLine('running summarize dry-run…', rowW)}
              />
            ) : (
              <>
                <FixedClearRow
                  width={rowW}
                  color={t.foreground}
                  text={formatLucernaDisplayLine(
                    `attempted ${summarizeEnv?.attempted ?? 0} · scrub-refused ${summarizeEnv?.refused_scrub ?? 0} · parse-fail ${summarizeEnv?.failed_parse ?? 0}`,
                    rowW,
                  )}
                />
                <FixedClearRow
                  width={rowW}
                  color={t.muted}
                  text={formatLucernaDisplayLine(
                    'Content leaves this machine scrubbed and audited.',
                    rowW,
                  )}
                />
                <FixedClearRow
                  width={rowW}
                  color={
                    canSummarizeSend(summarizeEnv) ? t.success : t.warning
                  }
                  text={formatLucernaDisplayLine(
                    canSummarizeSend(summarizeEnv)
                      ? 'sendable — confirm to invoke model'
                      : 'no sessions matched — confirm disabled',
                    rowW,
                  )}
                />
              </>
            )}
          </box>
        </Panel>
      ) : null}

      {showAudit ? (
        <Panel title="Audit tail" flexShrink={0} headerRight={`${auditSlice.length} rec`}>
          <box flexDirection="column" flexShrink={0}>
            {Array.from({ length: AUDIT_SHOW_SLOTS }, (_, i) => {
              const r = auditSlice[i];
              if (!r) {
                return (
                  <FixedClearRow
                    key={`a-${i}`}
                    width={rowW}
                    color={t.muted}
                    text={
                      i === 0 && auditSlice.length === 0
                        ? formatLucernaDisplayLine('(empty audit)', rowW)
                        : emptyDisplayRow(rowW)
                    }
                  />
                );
              }
              const selected = i === auditCursor;
              return (
                <FixedClearRow
                  key={`a-${i}`}
                  width={rowW}
                  color={
                    selected
                      ? t.info
                      : r.decision === 'refused'
                        ? t.warning
                        : r.decision === 'accepted'
                          ? t.success
                          : t.muted
                  }
                  text={formatLucernaDisplayLine(formatAuditRow(r, selected), rowW)}
                />
              );
            })}
          </box>
        </Panel>
      ) : null}

      <box
        flexDirection="row"
        flexShrink={0}
        height={1}
        overflow="hidden"
        marginTop={
          showPicker || showDryRun || showAudit || showSummarize || busy ? 1 : 0
        }
        backgroundColor={t.background}
      >
        <text fg={localFlash || busy ? t.success : t.muted} wrapMode="none">
          {formatLucernaDisplayLine(footerHint, Math.max(16, dims.width - 2))}
        </text>
      </box>

      {reportOverlay}

      <ConfirmModal
        active={!!confirm && !!inputActive && !reportView}
        message={confirm?.msg ?? ''}
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </box>
  );
}
