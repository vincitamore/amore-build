/**
 * Governed side-effect surface for the Sessions member.
 * All side-effects shell the speculum CLI via runSpeculum — never local writers.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { ConfirmModal } from '../components/Modal';
import { useStableDimensions } from '../use-stable-dimensions';
import {
  emptyDisplayRow,
  formatLucernaDisplayLine,
} from '../members/lucerna-display';
import { runSpeculum, type SpeculumResult } from './speculum-spawn';

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
  [k: string]: unknown;
};

export type AuditEnvelope = {
  path?: string;
  n?: number;
  records?: AuditRecord[];
  [k: string]: unknown;
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

/** Plain selection label: `--last-n 5 · 5 most recent primary sessions`. */
export function formatSelectionLabel(lastN: number): string {
  const n = Number.isFinite(lastN) && lastN > 0 ? Math.floor(lastN) : DEFAULT_LAST_N;
  return `--last-n ${n} · ${n} most recent primary sessions`;
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
 * `payload N bytes · cap 100 KB · M turns · S subagents · scrub: secret=… …`
 */
export function formatComposition(env: LensEnvelope | null | undefined): string {
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
  return `${payloadBit} · ${capBit} · ${turnsBit} · ${subBit} · ${scrubCountsBit(counts)}`;
}

/** Operator-facing oversize line: `payload 1.45 MB exceeds the 100 KB cap`. */
export function formatOversizeMessage(env: LensEnvelope | null | undefined): string {
  const bytes = env?.scrub?.bytes ?? env?.audit?.payloadBytes;
  if (typeof bytes === 'number' && Number.isFinite(bytes)) {
    return `payload ${formatHumanBytes(bytes)} exceeds the 100 KB cap`;
  }
  return 'payload exceeds the 100 KB cap';
}

/** Narrowing hint when over-cap; stepper re-dry-run is the remedy. */
export function formatNarrowHint(lastN: number): string {
  if (lastN > 1) return '‹1› likely fits — try it';
  return 'still over cap at 1 — try a different lens or window';
}

function formatAuditRow(r: AuditRecord): string {
  const ts = typeof r.ts === 'string' ? r.ts.slice(11, 19) : '??:??:??';
  const lens = typeof r.lens === 'string' ? r.lens : '?';
  const decision = typeof r.decision === 'string' ? r.decision : '?';
  const reason =
    typeof r.reason === 'string' && r.reason.length > 0
      ? r.reason.length > 36
        ? `${r.reason.slice(0, 35)}\u2026`
        : r.reason
      : '';
  return `${ts} ${decision} ${lens}${reason ? ` (${reason})` : ''}`;
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
      <FixedClearRow
        width={width}
        color={t.muted}
        text={formatLucernaDisplayLine(formatSelectionLabel(lastN), width)}
      />
    </box>
  );
}

// ── Component ──

type PanelMode = 'none' | 'picker' | 'dry-run' | 'audit';

export function SpeculumActions({
  inputActive,
  onFlash,
  onCapture,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  onCapture?: (b: boolean) => void;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const rowW = Math.max(24, dims.width - 4);

  const [installed, setInstalled] = useState<boolean | null>(null); // null = probing
  const [busy, setBusy] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelMode>('none');
  const [pickerIdx, setPickerIdx] = useState(0);
  const [lastN, setLastN] = useState<LastNOption>(DEFAULT_LAST_N);
  const [dryRunEnv, setDryRunEnv] = useState<LensEnvelope | null>(null);
  const [selectedLens, setSelectedLens] = useState<BuiltinLens | null>(null);
  const [confirm, setConfirm] = useState<{ msg: string; run: () => void } | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRecord[]>([]);
  const [localFlash, setLocalFlash] = useState<string | null>(null);

  const dryGenRef = useRef(0);
  const dryRerunTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNRef = useRef(lastN);
  lastNRef.current = lastN;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const selectedLensRef = useRef(selectedLens);
  selectedLensRef.current = selectedLens;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const installedRef = useRef(installed);
  installedRef.current = installed;

  const flash = useCallback(
    (msg: string) => {
      setLocalFlash(msg);
      onFlash?.(msg);
    },
    [onFlash],
  );

  const capturing =
    !!busy || panel === 'picker' || panel === 'dry-run' || panel === 'audit' || !!confirm;

  useEffect(() => {
    onCapture?.(capturing);
  }, [capturing, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  // Drop modal/panel claim when the member loses input focus.
  useEffect(() => {
    if (!inputActive) {
      setConfirm(null);
      if (panel === 'picker' || panel === 'dry-run') setPanel('none');
    }
  }, [inputActive, panel]);

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
    async (name: BuiltinLens, n?: number) => {
      if (busyRef.current || installedRef.current === false) return;
      const useN = n ?? lastNRef.current;
      setBusy(`lens ${name}…`);
      try {
        const r = await runSpeculum<LensEnvelope>('lens', [
          name,
          '--last-n',
          String(useN),
          '--json',
        ]);
        if (!r.ok) {
          if (r.error.kind === 'not-installed') setInstalled(false);
          flash(errorFlash(r, 'lens'));
          return;
        }
        setInstalled(true);
        setDryRunEnv(r.json);
        flash(formatLensFlash(r.json, true));
      } finally {
        setBusy(null);
        setConfirm(null);
        setPanel('none');
        setSelectedLens(null);
      }
    },
    [flash],
  );

  const runLensDry = useCallback(
    async (name: BuiltinLens, n?: number) => {
      if (installedRef.current === false) return;
      const useN = n ?? lastNRef.current;
      const gen = ++dryGenRef.current;
      setSelectedLens(name);
      setBusy(`lens dry-run ${name}…`);
      setPanel('dry-run');
      setDryRunEnv(null);
      setConfirm(null);
      try {
        const r = await runSpeculum<LensEnvelope>('lens', [
          name,
          '--last-n',
          String(useN),
          '--dry-run',
          '--json',
        ]);
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
          const nAtConfirm = useN;
          setConfirm({
            msg,
            run: () => {
              void runLensLive(name, nAtConfirm);
            },
          });
        }
      } finally {
        if (gen === dryGenRef.current) setBusy(null);
      }
    },
    [flash, runLensLive],
  );

  /** Apply a new last-n; on the dry-run panel, debounce a re-dry-run. */
  const applyLastN = useCallback(
    (n: LastNOption) => {
      setLastN(n);
      lastNRef.current = n;
      setConfirm(null);
      if (panelRef.current !== 'dry-run' || !selectedLensRef.current) return;
      if (dryRerunTimer.current) clearTimeout(dryRerunTimer.current);
      const lens = selectedLensRef.current;
      dryRerunTimer.current = setTimeout(() => {
        dryRerunTimer.current = null;
        void runLensDry(lens, n);
      }, LAST_N_DEBOUNCE_MS);
    },
    [runLensDry],
  );

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
          setPanel('audit');
          return;
        }
        flash(errorFlash(r, 'audit'));
        return;
      }
      setInstalled(true);
      const rows = Array.isArray(r.json.records) ? r.json.records : [];
      setAuditRows(rows.slice(-AUDIT_SHOW_SLOTS));
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

    // Shared last-n stepper keys (picker + dry-run). Works even while ConfirmModal
    // is up: re-slicing clears confirm and re-runs dry-run (y/n/esc still modal-owned).
    const handleLastNKeys = (): boolean => {
      if (n === 'left' || n === 'h') {
        applyLastN(stepLastN(lastN, -1));
        return true;
      }
      if (n === 'right' || (n === 'l' && !shift && seq !== 'L')) {
        // bare `l` (not shift-L) steps last-n while panel owns the keyboard
        applyLastN(stepLastN(lastN, 1));
        return true;
      }
      // Digit keys → direct option (0 → 10).
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
      return false;
    };

    if (panel === 'picker' || panel === 'dry-run') {
      if (handleLastNKeys()) return;
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
        void runLensDry(lens, lastN);
        return;
      }
      return;
    }

    // Dry-run report: last-n re-runs dry-run; esc closes; confirm is separate modal when sendable.
    if (panel === 'dry-run') {
      if (n === 'return' || n === 'enter') {
        // Enter re-runs immediately (no debounce wait).
        if (selectedLens) {
          if (dryRerunTimer.current) {
            clearTimeout(dryRerunTimer.current);
            dryRerunTimer.current = null;
          }
          void runLensDry(selectedLens, lastN);
        }
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
      setDryRunEnv(null);
      setSelectedLens(null);
      setConfirm(null);
      setPanel('picker');
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

  const footerHint = (() => {
    if (localFlash) return localFlash;
    if (busy) return busy;
    if (installed === false) return `speculum not installed — ${INSTALL_HINT}`;
    if (panel === 'picker') {
      return `up/dn · ←/→ last-n · enter dry-run · esc · ${formatSelectionLabel(lastN)}`;
    }
    if (panel === 'dry-run') {
      const decision = lensDecision(dryRunEnv);
      const reason = lensRefuseReason(dryRunEnv);
      if (canSend(decision, reason)) {
        return 'confirm modal: y send · n/esc cancel · ←/→ re-slice';
      }
      if (isOversizeRefuse(reason)) {
        return `over cap · ←/→ narrow · ${formatNarrowHint(lastN)} · esc close`;
      }
      return 'slice not sendable · ←/→ re-slice · esc close';
    }
    if (panel === 'audit') return 'A close audit · i ingest · L lens';
    if (installed === null) return 'checking speculum…';
    return 'i ingest · L lens · A audit';
  })();

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
  const auditSlice = auditRows.slice(-AUDIT_SHOW_SLOTS);

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
        <Panel title="Lens picker" flexShrink={0} headerRight={`--last-n ${lastN}`}>
          <box flexDirection="column" flexShrink={0}>
            <LastNStepper lastN={lastN} onChange={applyLastN} width={rowW} />
            {BUILTIN_LENSES.map((name, idx) => {
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
            })}
          </box>
        </Panel>
      ) : null}

      {showDryRun ? (
        <Panel
          title={selectedLens ? `Lens dry-run · ${selectedLens}` : 'Lens dry-run'}
          flexShrink={0}
          headerRight={`--last-n ${lastN}`}
        >
          <box flexDirection="column" flexShrink={0}>
            <LastNStepper
              lastN={lastN}
              onChange={applyLastN}
              width={rowW}
              disabled={!!busy}
            />
            {busy && !dryRunEnv ? (
              <FixedClearRow
                width={rowW}
                color={t.info}
                text={formatLucernaDisplayLine('running dry-run…', rowW)}
              />
            ) : (
              <>
                <FixedClearRow
                  width={rowW}
                  color={t.foreground}
                  text={formatLucernaDisplayLine(formatComposition(dryRunEnv), rowW)}
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
                        `${formatSelectionLabel(lastN)} · ${formatNarrowHint(lastN)}`,
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
                    canSend(lensDecision(dryRunEnv), lensRefuseReason(dryRunEnv))
                      ? 'sendable — confirm to invoke model'
                      : isOversizeRefuse(lensRefuseReason(dryRunEnv))
                        ? 'not sendable — narrow the slice (←/→) and re-run'
                        : 'not sendable — confirm disabled',
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
              return (
                <FixedClearRow
                  key={`a-${i}`}
                  width={rowW}
                  color={
                    r.decision === 'refused'
                      ? t.warning
                      : r.decision === 'accepted'
                        ? t.success
                        : t.muted
                  }
                  text={formatLucernaDisplayLine(formatAuditRow(r), rowW)}
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
        marginTop={showPicker || showDryRun || showAudit || busy ? 1 : 0}
        backgroundColor={t.background}
      >
        <text fg={localFlash || busy ? t.success : t.muted} wrapMode="none">
          {formatLucernaDisplayLine(footerHint, Math.max(16, dims.width - 2))}
        </text>
      </box>

      <ConfirmModal
        active={!!confirm && !!inputActive}
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
