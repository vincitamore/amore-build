/**
 * Governed side-effect surface for the Sessions member.
 * All side-effects shell the speculum CLI via runSpeculum — never local writers.
 */
import { useCallback, useEffect, useState } from 'react';
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

const DEFAULT_LAST_N = 5;
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
  const [dryRunEnv, setDryRunEnv] = useState<LensEnvelope | null>(null);
  const [selectedLens, setSelectedLens] = useState<BuiltinLens | null>(null);
  const [confirm, setConfirm] = useState<{ msg: string; run: () => void } | null>(null);
  const [auditRows, setAuditRows] = useState<AuditRecord[]>([]);
  const [localFlash, setLocalFlash] = useState<string | null>(null);

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

  const closePanels = useCallback(() => {
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
    async (name: BuiltinLens) => {
      if (busy || installed === false) return;
      setBusy(`lens ${name}…`);
      try {
        const r = await runSpeculum<LensEnvelope>('lens', [
          name,
          '--last-n',
          String(DEFAULT_LAST_N),
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
    [busy, installed, flash],
  );

  const runLensDry = useCallback(
    async (name: BuiltinLens) => {
      if (busy || installed === false) return;
      setSelectedLens(name);
      setBusy(`lens dry-run ${name}…`);
      setPanel('dry-run');
      setDryRunEnv(null);
      setConfirm(null);
      try {
        const r = await runSpeculum<LensEnvelope>('lens', [
          name,
          '--last-n',
          String(DEFAULT_LAST_N),
          '--dry-run',
          '--json',
        ]);
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
          setConfirm({
            msg,
            run: () => {
              void runLensLive(name);
            },
          });
        }
      } finally {
        setBusy(null);
      }
    },
    [busy, installed, flash, runLensLive],
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
    // Confirm modal owns y/n/esc while active.
    if (confirm) return;
    if (busy) return;

    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    const seq = key.sequence ?? '';
    const shift = !!key.shift;
    const isL = (n === 'l' && shift) || seq === 'L';
    const isA = (n === 'a' && shift) || seq === 'A';

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
        void runLensDry(lens);
        return;
      }
      return;
    }

    // Dry-run report: esc closes; confirm is separate modal when sendable.
    if (panel === 'dry-run') {
      return;
    }

    if (installed === false) return; // keys inert when not installed

    if (n === 'i' && !shift) {
      void runIngest();
      return;
    }
    if (isL) {
      setPickerIdx(0);
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
    if (panel === 'picker') return 'up/dn · enter dry-run · esc · selection --last-n 5';
    if (panel === 'dry-run') {
      const decision = lensDecision(dryRunEnv);
      const reason = lensRefuseReason(dryRunEnv);
      if (canSend(decision, reason)) return 'confirm modal: y send · n/esc cancel';
      return 'slice not sendable · esc close';
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
        <Panel title="Lens picker" flexShrink={0} headerRight={`--last-n ${DEFAULT_LAST_N}`}>
          <box flexDirection="column" flexShrink={0}>
            <FixedClearRow
              width={rowW}
              color={t.muted}
              text={formatLucernaDisplayLine(
                `selection: last ${DEFAULT_LAST_N} primary sessions`,
                rowW,
              )}
            />
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
          headerRight={`--last-n ${DEFAULT_LAST_N}`}
        >
          <box flexDirection="column" flexShrink={0}>
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
                  text={formatLucernaDisplayLine(formatScrubSummary(dryRunEnv), rowW)}
                />
                <FixedClearRow
                  width={rowW}
                  color={t.muted}
                  text={formatLucernaDisplayLine(
                    `reason: ${lensRefuseReason(dryRunEnv) ?? '—'}`,
                    rowW,
                  )}
                />
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
