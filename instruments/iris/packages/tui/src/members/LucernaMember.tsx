import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { Stat } from '../components/Stat';
import { ConfirmModal, Modal } from '../components/Modal';
import { useFlash } from '../components/use-flash';
import { useStableDimensions } from '../use-stable-dimensions';
import { tickRender } from '../debug';
import {
  BUDGETS_EMPTY_NEVER_RAN,
  BUDGETS_EMPTY_UNAVAILABLE,
  autoCommitMode,
  autoCommitModeLabel,
  budgetsPanelKind,
  choreOverlayItems,
  deriveLucernaUiState,
  emptyDisplayRow,
  enablementPatchForMode,
  formatBudgetPanelLines,
  formatChoreOverlayRow,
  formatChoresOverlayHeader,
  formatLucernaDisplayLine,
  formatLucernaLastActionsLine,
  formatUnknownChoreRow,
  lucernaActivitySub,
  lucernaActivityValue,
  lucernaBeatAgeSub,
  nextAutoCommitMode,
  parseLucernaBudgets,
  type LucernaCapabilityView,
  type LucernaRosterView,
} from './lucerna-display';
import {
  LucernaReviewOverlay,
  type ReviewOverlayModel,
} from './LucernaReviewOverlay';

// Re-export display helpers for existing imports / tests.
export {
  formatLogCell,
  formatLucernaDisplayLine,
  collapseHomeInText,
  deriveLucernaUiState,
  lastActionsSummary,
  formatLucernaLastActionsLine,
  lucernaActivityValue,
  lucernaActivitySub,
} from './lucerna-display';

// Lucerna daemon-proxy response shapes (subset rendered here).

interface Health {
  available: boolean;
  reason?: string;
  stale?: boolean;
  pid?: number;
  startedAt?: string;
  lastBeat?: string;
  version?: string;
  beatAgeSec?: number | null;
  heartbeatIntervalSec?: number;
  pidAlive?: boolean;
  phase?: string;
  stopped?: boolean;
  workInProgress?: boolean;
  staleBoundSec?: number;
}

interface Enablement {
  dreamsEnabled: boolean;
  autoCommitEnabled?: boolean;
  autoCommitLive: boolean;
}

interface Status {
  available: boolean;
  reason?: string;
  stale?: boolean;
  version?: string;
  pid?: number;
  activity?: unknown;
  lastActions?: unknown;
  budgets?: unknown;
  capability?: LucernaCapabilityView;
  enablement?: Enablement;
  phase?: string;
}

interface Notification {
  ts: string;
  level: string;
  kind: string;
  message: string;
  ref?: string;
}

/** Unified list row for dreams (manifest/light) + proposals. */
interface ReviewRow {
  kind: 'dream' | 'proposal';
  dreamKind?: 'manifest' | 'light';
  id: string;
  path: string;
  title: string;
  pending: boolean;
  statusLabel: string;
  created?: string;
  reportPath?: string;
}

interface DreamListItem {
  id: string;
  kind: 'manifest' | 'light';
  path: string;
  title?: string;
  goal?: string;
  reviewStatus?: string;
  status?: string;
  created?: string;
  reportPath?: string;
}

interface ProposalListItem {
  id: string;
  path: string;
  title?: string;
  status?: string;
  created?: string;
  target?: string;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}.`;
}

function dreamPending(d: DreamListItem): boolean {
  if (d.kind === 'manifest') return d.reviewStatus === 'pending' || d.reviewStatus === undefined;
  return d.status === 'pending' || d.status === undefined;
}

function proposalPending(p: ProposalListItem): boolean {
  return p.status === 'pending' || p.status === undefined;
}

function toReviewRows(dreams: DreamListItem[], proposals: ProposalListItem[]): ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const d of dreams) {
    const pending = dreamPending(d);
    const statusLabel =
      d.kind === 'manifest'
        ? d.reviewStatus ?? 'pending'
        : d.status ?? 'pending';
    rows.push({
      kind: 'dream',
      dreamKind: d.kind,
      id: d.id,
      path: d.path,
      title: d.title || d.goal || d.id,
      pending,
      statusLabel,
      created: d.created,
      reportPath: d.reportPath,
    });
  }
  for (const p of proposals) {
    const pending = proposalPending(p);
    rows.push({
      kind: 'proposal',
      id: p.id,
      path: p.path,
      title: p.title || p.id,
      pending,
      statusLabel: p.status ?? 'pending',
      created: p.created,
    });
  }
  rows.sort((a, b) => {
    if (a.pending !== b.pending) return a.pending ? -1 : 1;
    const ca = a.created ?? '';
    const cb = b.created ?? '';
    if (ca !== cb) return cb.localeCompare(ca);
    return b.path.localeCompare(a.path);
  });
  return rows;
}

function formatReviewRow(row: ReviewRow): string {
  const glyph = row.kind === 'dream' ? 'D' : 'P';
  const tag = row.pending ? 'pend' : row.statusLabel.slice(0, 6);
  return `${glyph} [${tag}] ${row.title}`;
}

/**
 * One fixed-height, full-width list row with opaque background.
 * Space glyphs alone do not clear prior OpenTUI cells; the background fill does.
 */
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

function formatBeatAge(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '—';
  if (sec < 0) return '—';
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function uptimeStr(ts?: string): string {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  if (Number.isNaN(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d`;
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, m)}m`;
}

function formatNotification(n: Notification): string {
  return `${n.level} ${n.kind}: ${n.message}`;
}

const SCROLLBACK = 200;
const NOTE_LIMIT = 8;
/** Fixed notification slots so a shorter set still repaints every prior row. */
const NOTE_SLOTS = 5;
/** Fixed review list slots for opaque clear-on-repaint. */
const REVIEW_SLOTS = 6;

const BUDGET_EDIT_CHIPS = [
  { id: 'actions', label: 'actions', knob: 'dailyActionCap' as const, noun: 'actions/day' },
  { id: 'expensive', label: 'expensive', knob: 'weeklyExpensiveCap' as const, noun: 'expensive/week' },
  { id: 'tokens', label: 'tokens', knob: 'dailyTokenCeiling' as const, noun: 'tokens/day' },
] as const;

function parseCapInput(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function BudgetEditModal({
  active,
  current,
  onRequestConfirm,
  onCancel,
}: {
  active: boolean;
  current: {
    dailyActionCap: number;
    weeklyExpensiveCap: number;
    dailyTokenCeiling: number;
  };
  onRequestConfirm: (
    knob: (typeof BUDGET_EDIT_CHIPS)[number]['knob'],
    noun: string,
    value: number,
  ) => void;
  onCancel: () => void;
}) {
  const t = usePalette();
  const [ci, setCi] = useState(0);
  const [hint, setHint] = useState('←→ cap · type value · ⏎ confirm · esc cancel');
  const inputRef = useRef<{ value?: string } | null>(null);
  const chip = BUDGET_EDIT_CHIPS[ci] ?? BUDGET_EDIT_CHIPS[0];

  useEffect(() => {
    if (!active) return;
    setCi(0);
    setHint('←→ cap · type value · ⏎ confirm · esc cancel');
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const c = BUDGET_EDIT_CHIPS[ci] ?? BUDGET_EDIT_CHIPS[0];
    if (inputRef.current) inputRef.current.value = String(current[c.knob]);
    // Prefill on open/chip only — do not reset while the operator types.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ci]);

  useKeyboard((key: { name?: string }) => {
    if (!active) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'left' || n === 'up') {
      setCi((x) => (x + BUDGET_EDIT_CHIPS.length - 1) % BUDGET_EDIT_CHIPS.length);
      setHint('←→ cap · type value · ⏎ confirm · esc cancel');
      return;
    }
    if (n === 'right' || n === 'down') {
      setCi((x) => (x + 1) % BUDGET_EDIT_CHIPS.length);
      setHint('←→ cap · type value · ⏎ confirm · esc cancel');
      return;
    }
    if (n === 'return' || n === 'enter') {
      const parsed = parseCapInput(inputRef.current?.value ?? '');
      if (parsed === null) {
        setHint(`${chip.noun} must be a non-negative integer`);
        return;
      }
      onRequestConfirm(chip.knob, chip.noun, parsed);
      return;
    }
    if (n === 'escape') return onCancel();
  });

  return (
    <Modal title="Edit budget cap" width={58} visible={active}>
      <box flexDirection="row">
        {BUDGET_EDIT_CHIPS.map((c, idx) => (
          <box
            key={c.id}
            marginRight={1}
            backgroundColor={idx === ci ? t.selection : t.background}
            onMouseDown={() => setCi(idx)}
          >
            <text fg={idx === ci ? t.primary : t.muted}>{` ${c.label} `}</text>
          </box>
        ))}
      </box>
      <input
        ref={inputRef as never}
        focused={active}
        placeholder="cap value"
        backgroundColor={t.background}
        textColor={t.foreground}
      />
      <text fg={t.muted}>{hint}</text>
    </Modal>
  );
}

function pendingFromBudgets(budgets: unknown): Record<string, number> {
  if (typeof budgets !== 'object' || budgets === null || Array.isArray(budgets)) return {};
  const charter = (budgets as { charter?: { pending?: unknown } }).charter;
  if (!charter || typeof charter.pending !== 'object' || charter.pending === null) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(charter.pending as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function visiblePending(
  local: Record<string, number>,
  snap: Record<string, number>,
  effective: Record<string, number>,
): Record<string, number> {
  const merged = { ...snap, ...local };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (effective[k] !== v) out[k] = v;
  }
  return out;
}

function withPendingMarkers(
  lines: { text: string; tone: 'muted' | 'warning' }[],
  pending: Record<string, number>,
): { text: string; tone: 'muted' | 'warning' }[] {
  const map: Array<[string, string]> = [
    ['actions', 'dailyActionCap'],
    ['expensive', 'weeklyExpensiveCap'],
    ['tokens', 'dailyTokenCeiling'],
  ];
  return lines.map((ln) => {
    for (const [prefix, key] of map) {
      if (ln.text.startsWith(prefix) && pending[key] !== undefined) {
        return { ...ln, text: `${ln.text} (${pending[key]} pending)`, tone: 'warning' };
      }
    }
    return ln;
  });
}

function LucernaChoresOverlay({
  active,
  roster,
  cursor,
  onClose,
  onMove,
  onToggle,
}: {
  active: boolean;
  roster: LucernaRosterView | null;
  cursor: number;
  onClose: () => void;
  onMove: (delta: number) => void;
  onToggle: () => void;
}) {
  const t = usePalette();
  const dims = useStableDimensions();

  const width = Math.min(dims.width - 4, 110);
  const left = Math.max(0, Math.floor((dims.width - width) / 2));
  const height = Math.max(10, dims.height - 4);
  const top = 1;
  const innerW = Math.max(8, width - 4);
  const items = roster ? choreOverlayItems(roster) : [];
  const slots = Math.max(4, height - 6);
  const start = Math.max(0, Math.min(cursor, Math.max(0, items.length - slots)));
  const slice = items.slice(start, start + slots);
  const header = roster
    ? formatChoresOverlayHeader(roster)
    : 'no roster on this snapshot';

  useKeyboard((key: { name?: string }) => {
    if (!active) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'escape') return onClose();
    if (n === 'up') return onMove(-1);
    if (n === 'down') return onMove(1);
    if (n === 't') return onToggle();
  });

  return (
    <box
      visible={active}
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={height}
      zIndex={200}
      border
      borderStyle="rounded"
      borderColor={t.borderActive}
      backgroundColor={t.background}
      title=" Chores "
      titleAlignment="center"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box height={1} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
        <text fg={t.muted} wrapMode="none">
          {formatLucernaDisplayLine(header, innerW)}
        </text>
      </box>
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minHeight={0}
        backgroundColor={t.background}
      >
        {Array.from({ length: slots }, (_, i) => {
          const item = slice[i];
          if (!item) {
            return (
              <FixedClearRow
                key={`c-${i}`}
                width={innerW}
                color={t.muted}
                text={
                  i === 0 && items.length === 0
                    ? formatLucernaDisplayLine('no chores listed', innerW)
                    : emptyDisplayRow(innerW)
                }
              />
            );
          }
          const abs = start + i;
          const selected = abs === cursor;
          const text =
            item.kind === 'entry'
              ? formatChoreOverlayRow(item.entry, selected)
              : formatUnknownChoreRow(item.key, selected);
          return (
            <FixedClearRow
              key={`c-${i}`}
              width={innerW}
              color={selected ? t.info : item.kind === 'unknown' || (item.kind === 'entry' && !item.entry.enabled) ? t.muted : t.foreground}
              text={formatLucernaDisplayLine(text, innerW)}
            />
          );
        })}
      </box>
      <box height={1} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
        <text fg={t.muted} wrapMode="none">
          {formatLucernaDisplayLine('esc close · up/dn · t toggle', innerW)}
        </text>
      </box>
    </box>
  );
}

type PanelFocus = 'log' | 'review';

/**
 * Lucerna member — agency operations console. Honest at every state:
 * iris-daemon-down, not-installed, stopped, running, stale/hung.
 * Ops: r start · k stop · h halt · w wake · s sleep · d dreams enable · a auto-commit · p review.
 * Review detail opens a centered overlay (list stays in the panel).
 */
export function LucernaMember({
  inputActive,
  onCapture,
  daemonUrl,
}: {
  inputActive?: boolean;
  onCapture?: (b: boolean) => void;
  daemonUrl?: string | null;
}) {
  const t = usePalette();
  const dims = useStableDimensions();

  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [notes, setNotes] = useState<Notification[]>([]);
  const [dreamItems, setDreamItems] = useState<DreamListItem[]>([]);
  const [proposalItems, setProposalItems] = useState<ProposalListItem[]>([]);
  const [dreamsEnabledFlag, setDreamsEnabledFlag] = useState(false);
  const [reviewCursor, setReviewCursor] = useState(0);
  const [panelFocus, setPanelFocus] = useState<PanelFocus>('log');
  const [overlay, setOverlay] = useState<ReviewOverlayModel | null>(null);
  const [choresOpen, setChoresOpen] = useState(false);
  const [choreCursor, setChoreCursor] = useState(0);
  const [budgetEditOpen, setBudgetEditOpen] = useState(false);
  const [localPending, setLocalPending] = useState<Record<string, number>>({});
  const [scroll, setScroll] = useState(0);
  const [flash, setFlash] = useFlash();
  const [confirm, setConfirm] = useState<{ msg: string; detail?: string[]; run: () => void } | null>(null);
  const [busy, setBusy] = useState(false);

  const overlayOpen = !!overlay || choresOpen;

  useEffect(() => {
    if (!inputActive && confirm) setConfirm(null);
    if (!inputActive && budgetEditOpen) setBudgetEditOpen(false);
  }, [inputActive, confirm, budgetEditOpen]);

  useEffect(() => {
    onCapture?.(!!confirm || overlayOpen || budgetEditOpen);
  }, [confirm, overlayOpen, budgetEditOpen, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  const refresh = async (url: string, alive: () => boolean) => {
    try {
      const r = await fetch(`${url}/api/lucerna/health`);
      if (r.ok && alive()) setHealth((await r.json()) as Health);
    } catch {
      /* daemon warming */
    }
    try {
      const r = await fetch(`${url}/api/lucerna/status`);
      if (r.ok && alive()) setStatus((await r.json()) as Status);
    } catch {
      /* ignore */
    }
    try {
      const r = await fetch(`${url}/api/lucerna/log?n=${SCROLLBACK}`);
      if (r.ok && alive()) {
        const body = (await r.json()) as { lines?: string[] };
        setLogLines(body.lines ?? []);
      }
    } catch {
      /* ignore */
    }
    try {
      const r = await fetch(`${url}/api/lucerna/notifications?n=${NOTE_LIMIT}`);
      if (r.ok && alive()) {
        const body = (await r.json()) as { entries?: Notification[] };
        setNotes(body.entries ?? []);
      }
    } catch {
      /* ignore */
    }
    try {
      const r = await fetch(`${url}/api/lucerna/dreams`);
      if (r.ok && alive()) {
        const body = (await r.json()) as {
          items?: DreamListItem[];
          dreamsEnabled?: boolean;
        };
        setDreamItems(body.items ?? []);
        if (typeof body.dreamsEnabled === 'boolean') setDreamsEnabledFlag(body.dreamsEnabled);
      }
    } catch {
      /* ignore */
    }
    try {
      const r = await fetch(`${url}/api/lucerna/proposals`);
      if (r.ok && alive()) {
        const body = (await r.json()) as { items?: ProposalListItem[] };
        setProposalItems(body.items ?? []);
      }
    } catch {
      /* ignore */
    }
  };

  // HTTP poll against the iris daemon's Lucerna proxy while this tab is active.
  useEffect(() => {
    if (!daemonUrl || !inputActive) return;
    let alive = true;
    const pull = () => void refresh(daemonUrl, () => alive);
    pull();
    const id = setInterval(() => alive && pull(), 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [daemonUrl, inputActive]);

  tickRender('LucernaMember');

  const uiState = deriveLucernaUiState(daemonUrl, health, status);
  const enablement: Enablement = status?.enablement ?? {
    dreamsEnabled: dreamsEnabledFlag,
    autoCommitEnabled: true,
    autoCommitLive: false,
  };
  const commitMode = autoCommitMode(enablement);

  const reviewRows = useMemo(
    () => toReviewRows(dreamItems, proposalItems),
    [dreamItems, proposalItems],
  );
  const pendingReview = reviewRows.filter((r) => r.pending).length;
  const selectedRow = reviewRows[Math.min(reviewCursor, Math.max(0, reviewRows.length - 1))] ?? null;

  const reserve = 27; // status (taller budgets) + notifications + review + footer
  const visible = Math.max(3, dims.height - reserve);
  // Outer pad (2) + panel border (2) + panel pad (2) = 6. Exact so rows fill the panel.
  const rowW = Math.max(16, dims.width - 6);
  const maxScroll = Math.max(0, logLines.length - visible);
  const clamped = Math.min(scroll, maxScroll);
  const startIdx = Math.max(0, logLines.length - visible - clamped);
  const shown = logLines.slice(startIdx, startIdx + visible);

  const prevLogLen = useRef(0);
  useEffect(() => {
    const len = logLines.length;
    const delta = len - prevLogLen.current;
    prevLogLen.current = len;
    if (delta > 0) setScroll((s) => (s > 0 ? Math.min(s + delta, Math.max(0, len - visible)) : 0));
  }, [logLines.length, visible]);

  useEffect(() => {
    if (reviewCursor >= reviewRows.length) setReviewCursor(Math.max(0, reviewRows.length - 1));
  }, [reviewRows.length, reviewCursor]);

  const roster = parseLucernaBudgets(status?.budgets)?.roster ?? null;
  const choreCount = roster ? choreOverlayItems(roster).length : 0;
  useEffect(() => {
    if (choreCursor >= choreCount) setChoreCursor(Math.max(0, choreCount - 1));
  }, [choreCount, choreCursor]);

  const post = async (path: string, label: string, body?: Record<string, unknown>) => {
    if (!daemonUrl) return setFlash('Iris daemon down — cannot reach Lucerna proxy');
    setBusy(true);
    try {
      const r = await fetch(`${daemonUrl}/api/lucerna/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        available?: boolean;
        reason?: string;
        message?: string;
        outcome?: string;
        enablement?: Enablement;
        graceful?: boolean;
        escalated?: boolean;
      };
      if (j.available === false && j.reason === 'not-installed') {
        setFlash(`${label}: Lucerna not installed`);
      } else if (path === 'start' || path === 'stop') {
        const outcome = j.outcome ?? (j.ok === false ? 'failed' : 'ok');
        setFlash(j.ok === false ? `${label}: ${outcome}` : `${label}: ${outcome}`);
      } else if (path === 'enable') {
        if (j.ok === false) setFlash(`${label} failed`);
        else {
          const e = j.enablement;
          setFlash(
            e
              ? `enablement: dreams ${e.dreamsEnabled ? 'on' : 'off'} · auto-commit ${autoCommitModeLabel(autoCommitMode(e))}`
              : label,
          );
          // Force status re-read so TUI always shows file truth after write
          if (daemonUrl) await refresh(daemonUrl, () => true);
        }
      } else if (path === 'budgets' || path === 'chores') {
        if (j.ok === false) setFlash(`${label} failed`);
        else setFlash(label);
        // Force status re-read so TUI always shows file truth after write
        if (daemonUrl) await refresh(daemonUrl, () => true);
      } else if (
        path === 'dreams/review' ||
        path === 'proposals/apply' ||
        path === 'proposals/close'
      ) {
        if (j.ok === false) setFlash(`${label}: ${j.reason ?? j.message ?? 'failed'}`);
        else setFlash(label);
        if (daemonUrl) await refresh(daemonUrl, () => true);
        setOverlay(null);
      } else {
        setFlash(j.ok === false ? `${label} failed` : label);
      }
      if (
        daemonUrl &&
        path !== 'enable' &&
        path !== 'budgets' &&
        path !== 'chores' &&
        path !== 'dreams/review' &&
        path !== 'proposals/apply' &&
        path !== 'proposals/close'
      ) {
        await refresh(daemonUrl, () => true);
      }
    } catch {
      setFlash(`${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  const openDetail = async (row: ReviewRow) => {
    if (!daemonUrl) return setFlash('Iris daemon down — cannot reach Lucerna proxy');
    try {
      const path =
        row.kind === 'dream'
          ? `${daemonUrl}/api/lucerna/dream?id=${encodeURIComponent(row.id)}`
          : `${daemonUrl}/api/lucerna/proposal?id=${encodeURIComponent(row.id)}`;
      const r = await fetch(path);
      if (!r.ok) return setFlash('detail load failed');
      const j = (await r.json()) as {
        found?: boolean;
        body?: string;
        raw?: string;
        displayBody?: string;
        reportPath?: string;
        reportBody?: string;
        item?: { title?: string; goal?: string; reportPath?: string };
      };
      if (!j.found) return setFlash('not found');
      const body =
        (j.displayBody ?? j.body ?? j.raw ?? '').trim() || '(empty body)';
      setOverlay({
        kind: row.kind,
        id: row.id,
        title: j.item?.title || j.item?.goal || row.title,
        statusLabel: row.statusLabel,
        path: row.path,
        body,
        pending: row.pending,
        reportPath: j.reportPath ?? j.item?.reportPath ?? row.reportPath,
      });
      setPanelFocus('review');
    } catch {
      setFlash('detail load failed');
    }
  };

  useKeyboard((key: { name?: string }) => {
    // Overlay owns keys while open (except confirm modal).
    if (!inputActive || confirm || busy || overlayOpen || budgetEditOpen) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');

    // Escape: leave review focus → log
    if (n === 'escape') {
      if (panelFocus === 'review') {
        setPanelFocus('log');
        return;
      }
    }

    // Review panel navigation when focused (list only — detail is the overlay)
    if (panelFocus === 'review') {
      if (n === 'up') {
        return setReviewCursor((c) => Math.max(0, c - 1));
      }
      if (n === 'down') {
        return setReviewCursor((c) => Math.min(Math.max(0, reviewRows.length - 1), c + 1));
      }
      if (n === 'return' || n === 'enter') {
        if (selectedRow) return void openDetail(selectedRow);
      }
      if (n === 'v' && selectedRow?.pending) {
        if (selectedRow.kind === 'dream') {
          return setConfirm({
            msg: `Mark dream ${selectedRow.id} reviewed?`,
            run: () => void post('dreams/review', `reviewed ${selectedRow.id}`, { id: selectedRow.id }),
          });
        }
        return setConfirm({
          msg: `Mark proposal ${selectedRow.id} applied (status only — content not executed)?`,
          run: () =>
            void post('proposals/apply', `applied ${selectedRow.id} (status only)`, {
              id: selectedRow.id,
            }),
        });
      }
      if (n === 'x' && selectedRow?.pending && selectedRow.kind === 'proposal') {
        return setConfirm({
          msg: `Close proposal ${selectedRow.id} (status only)?`,
          run: () =>
            void post('proposals/close', `closed ${selectedRow.id} (status only)`, {
              id: selectedRow.id,
            }),
        });
      }
    }

    // Global ops (also when review focused, except arrows which navigate review)
    if (panelFocus === 'log') {
      if (n === 'up') return setScroll((s) => Math.min(s + 1, maxScroll));
      if (n === 'down') return setScroll((s) => Math.max(s - 1, 0));
      if (n === 'pageup') return setScroll((s) => Math.min(s + visible, maxScroll));
      if (n === 'pagedown') return setScroll((s) => Math.max(s - visible, 0));
      if (n === 'home') return setScroll(maxScroll);
      if (n === 'end') return setScroll(0);
    }
    if (n === 'p') {
      setPanelFocus((f) => (f === 'review' ? 'log' : 'review'));
      return;
    }
    if (n === 'c') {
      setChoresOpen(true);
      return;
    }
    if (n === 'b') {
      setBudgetEditOpen(true);
      return;
    }
    if (n === 'r') return void post('start', 'start');
    if (n === 'k') {
      return setConfirm({
        msg: 'Stop Lucerna (halt, then pid kill if needed)?',
        run: () => void post('stop', 'stop'),
      });
    }
    if (n === 'h') {
      return setConfirm({
        msg: 'Halt Lucerna — write halt sentinel?',
        run: () => void post('halt', 'halted'),
      });
    }
    if (n === 'w') return void post('wake', 'wake sent');
    if (n === 's') return void post('sleep', 'sleep sent');
    if (n === 'd') {
      const next = !enablement.dreamsEnabled;
      const parsed = parseLucernaBudgets(status?.budgets);
      const actions = parsed?.dailyCap ?? 12;
      const expensive = parsed?.windows?.weekly?.cap ?? 6;
      const tokens = parsed?.dailyTokenCeiling ?? 200000;
      const tokLabel = tokens >= 10_000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
      return setConfirm({
        msg: `Set dreams ${next ? 'ON' : 'OFF'} in lucerna.enable.json?`,
        detail: next
          ? [
              'Dreams make model calls on your configured model + key.',
              `Bounded by ${actions} actions/day, ${expensive} expensive/week, ${tokLabel}`,
              'tokens/day. Press b on this tab to change them.',
            ]
          : undefined,
        run: () => void post('enable', 'dreams', { dreamsEnabled: next }),
      });
    }
    if (n === 'a') {
      const next = nextAutoCommitMode(commitMode);
      const label = autoCommitModeLabel(next);
      return setConfirm({
        msg: `Set auto-commit ${label} in lucerna.enable.json?`,
        detail:
          next === 'off'
            ? ['No drafts. No model calls. Token budget is untouched.']
            : next === 'dry-run'
              ? ['Drafts a commit message via your configured model.', 'Does not commit. Still spends tokens.']
              : [
                  'Live remains draft-only until a hardened path ships.',
                  'This still spends tokens on the draft call.',
                ],
        run: () => void post('enable', 'auto-commit', enablementPatchForMode(next)),
      });
    }
  });

  const onLogScroll = (e: { scroll?: { direction?: string }; button?: number }) => {
    let dir = e.scroll?.direction;
    if (!dir && e.button === 4) dir = 'up';
    if (!dir && e.button === 5) dir = 'down';
    if (dir === 'up') setScroll((s) => Math.min(s + 3, maxScroll));
    else if (dir === 'down') setScroll((s) => Math.max(s - 3, 0));
  };

  const statusSection = useMemo(() => {
    if (uiState === 'daemon-down') {
      return (
        <Panel title="Lucerna" flexShrink={0}>
          <text fg={t.muted}>Iris daemon is down. Agency proxy is unreachable until the daemon starts.</text>
        </Panel>
      );
    }
    if (uiState === 'not-installed') {
      return (
        <Panel title="Lucerna" flexShrink={0}>
          <box flexDirection="column">
            <text fg={t.foreground}>Lucerna is not installed in this house.</text>
            <text fg={t.muted}>Install with: amore init --with-lucerna</text>
            <text fg={t.muted}>Once installed, this tab shows health, budgets, enablement, and the activity log.</text>
          </box>
        </Panel>
      );
    }

    const parsedBudgets = parseLucernaBudgets(status?.budgets);
    const capability = status?.capability ?? parsedBudgets?.capability ?? null;
    const refusing = uiState === 'running' && capability?.state === 'refusing';
    const phaseValue = lucernaActivityValue(uiState);
    const phaseColor =
      uiState === 'stale'
        ? t.error
        : uiState === 'stopped'
          ? t.muted
          : refusing
            ? t.warning
            : t.success;
    const beat = formatBeatAge(health?.beatAgeSec);
    const dreamsBadge = enablement.dreamsEnabled ? 'dreams on' : 'dreams off';
    const commitBadge = `auto-commit ${autoCommitModeLabel(autoCommitMode(enablement))}`;
    const hasOtherState = status?.activity != null || status?.lastActions != null;
    const panelKind = budgetsPanelKind(status?.budgets, hasOtherState);
    const budgetInnerW = Math.max(20, Math.floor(dims.width / 2) - 8);
    const weeklyCap =
      parsedBudgets?.windows?.weekly?.cap ??
      (parsedBudgets?.weekly.match(/\/(\d+)/)?.[1]
        ? Number(parsedBudgets.weekly.match(/\/(\d+)/)?.[1])
        : undefined);
    const pending = visiblePending(localPending, pendingFromBudgets(status?.budgets), {
      dailyActionCap: parsedBudgets?.dailyCap ?? Number.NaN,
      weeklyExpensiveCap: weeklyCap ?? Number.NaN,
      dailyTokenCeiling: parsedBudgets?.dailyTokenCeiling ?? Number.NaN,
    });
    const budgetLines =
      panelKind === 'rows' && parsedBudgets
        ? withPendingMarkers(formatBudgetPanelLines(parsedBudgets, budgetInnerW), pending)
        : [
            {
              text:
                panelKind === 'unavailable' ? BUDGETS_EMPTY_UNAVAILABLE : BUDGETS_EMPTY_NEVER_RAN,
              tone: 'muted' as const,
            },
          ];

    return (
      <>
        <box flexDirection="row" flexShrink={0}>
          <Stat
            value={phaseValue}
            label="Activity"
            sub={lucernaActivitySub(uiState, status, health, capability)}
            color={phaseColor}
          />
          <Stat
            value={beat}
            label="Beat age"
            sub={lucernaBeatAgeSub(health)}
            color={uiState === 'stale' ? t.error : uiState === 'running' ? t.info : t.muted}
          />
          <Stat
            value={uptimeStr(health?.startedAt)}
            label="Uptime"
            sub={health?.version ? `v${health.version}` : health?.pid ? `pid ${health.pid}` : ' '}
            color={uiState === 'running' ? t.success : t.muted}
          />
          <Stat
            value={enablement.dreamsEnabled ? 'On' : 'Off'}
            label="Dreams"
            sub={
              pendingReview > 0
                ? `${pendingReview} pending review`
                : commitBadge
            }
            color={
              pendingReview > 0
                ? t.warning
                : enablement.dreamsEnabled
                  ? t.warning
                  : t.muted
            }
          />
        </box>
        <box flexDirection="row" flexShrink={0} marginTop={1}>
          <Panel title="Budgets" flexGrow={1} marginRight={1}>
            <box flexDirection="column">
              {budgetLines.map((ln, i) => (
                <text
                  key={`b-${i}`}
                  fg={ln.tone === 'warning' ? t.warning : t.muted}
                  wrapMode="none"
                >
                  {formatLucernaDisplayLine(ln.text, budgetInnerW)}
                </text>
              ))}
            </box>
          </Panel>
          <Panel title="Enablement" flexGrow={1}>
            <text fg={t.foreground}>{`${dreamsBadge} · ${commitBadge}`}</text>
            <text fg={t.muted}>d toggle dreams · a cycle auto-commit off/dry-run/live (confirm)</text>
          </Panel>
        </box>
        <box flexShrink={0} marginTop={1}>
          <text fg={t.muted}>{`Last actions: ${truncate(formatLucernaLastActionsLine(status), Math.max(20, dims.width - 20))}`}</text>
        </box>
      </>
    );
  }, [uiState, health, status, enablement, dims.width, t, pendingReview, localPending]);

  const showLog = uiState !== 'not-installed' && uiState !== 'daemon-down';
  // Review panel is reachable whenever the iris daemon is up (forge artifacts live on the house,
  // independent of the Lucerna process). When daemon is down, keep the honest empty notice.
  const showReview = uiState !== 'daemon-down';

  const reviewEmptyMessage = (): string => {
    if (uiState === 'not-installed') return 'lucerna not installed — forge review still lists house artifacts when present';
    if (!enablement.dreamsEnabled && reviewRows.length === 0) return 'no dreams yet · dreams disabled (d to enable)';
    if (reviewRows.length === 0) return 'no dreams or proposals yet';
    return '';
  };

  const reviewListStart = Math.max(0, Math.min(reviewCursor, Math.max(0, reviewRows.length - REVIEW_SLOTS)));
  const reviewSlice = reviewRows.slice(reviewListStart, reviewListStart + REVIEW_SLOTS);

  const footerHint = flash
    ? flash
    : panelFocus === 'review'
      ? 'up/dn · enter open · v review/apply · x close · p log · c chores · esc'
      : uiState === 'not-installed' || uiState === 'daemon-down'
        ? 'r start · k stop · h halt · w wake · s sleep · d dreams · a auto-commit · c chores · p review'
        : 'r start · k stop · h halt · w wake · s sleep · d dreams · a auto-commit · c chores · p review · up/dn';

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1} backgroundColor={t.background}>
      {statusSection}

      {showLog ? (
        <Panel
          title="Notifications"
          flexShrink={0}
          marginTop={1}
          headerRight={notes.length > 0 ? `${Math.min(notes.length, NOTE_SLOTS)} newest` : 'empty'}
        >
          <box flexDirection="column" flexShrink={0}>
            {Array.from({ length: NOTE_SLOTS }, (_, i) => {
              const n = notes[i];
              if (!n) {
                return (
                  <FixedClearRow
                    key={`n-${i}`}
                    width={rowW}
                    color={t.muted}
                    text={i === 0 && notes.length === 0 ? 'no notifications yet' : emptyDisplayRow(rowW)}
                  />
                );
              }
              const color = n.level === 'error' ? t.error : n.level === 'warn' ? t.warning : t.muted;
              return (
                <FixedClearRow
                  key={`n-${i}`}
                  width={rowW}
                  color={color}
                  text={formatLucernaDisplayLine(formatNotification(n), rowW)}
                />
              );
            })}
          </box>
        </Panel>
      ) : null}

      {showReview ? (
        <Panel
          title={panelFocus === 'review' ? 'Review *' : 'Review'}
          flexShrink={0}
          marginTop={1}
          headerRight={
            pendingReview > 0
              ? `${pendingReview} pending · ${reviewRows.length} total`
              : reviewRows.length > 0
                ? `${reviewRows.length} total`
                : 'empty'
          }
        >
          <box flexDirection="column" flexShrink={0}>
            {Array.from({ length: REVIEW_SLOTS }, (_, i) => {
              const row = reviewSlice[i];
              if (!row) {
                const empty =
                  i === 0 && reviewRows.length === 0
                    ? reviewEmptyMessage()
                    : emptyDisplayRow(rowW);
                return (
                  <FixedClearRow
                    key={`r-${i}`}
                    width={rowW}
                    color={t.muted}
                    text={
                      typeof empty === 'string' && empty.length === rowW
                        ? empty
                        : formatLucernaDisplayLine(empty, rowW)
                    }
                  />
                );
              }
              const absIdx = reviewListStart + i;
              const selected = panelFocus === 'review' && absIdx === reviewCursor;
              const color = selected ? t.info : row.pending ? t.warning : t.muted;
              const prefix = selected ? '>' : ' ';
              return (
                <FixedClearRow
                  key={`r-${i}`}
                  width={rowW}
                  color={color}
                  text={formatLucernaDisplayLine(`${prefix}${formatReviewRow(row)}`, rowW)}
                />
              );
            })}
          </box>
        </Panel>
      ) : null}

      {showLog ? (
        <Panel
          title={panelFocus === 'log' ? 'Activity Log *' : 'Activity Log'}
          headerRight={`${logLines.length} ln${clamped > 0 ? ` · ^${clamped}` : ' · live'} · up/dn`}
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          marginTop={1}
        >
          <box
            flexDirection="column"
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            overflow="hidden"
            onMouseScroll={onLogScroll}
            backgroundColor={t.background}
          >
            {Array.from({ length: visible }, (_, i) => (
              <FixedClearRow
                key={`log-${i}`}
                width={rowW}
                color={t.foreground}
                text={shown[i] ? formatLucernaDisplayLine(shown[i], rowW) : emptyDisplayRow(rowW)}
              />
            ))}
          </box>
        </Panel>
      ) : (
        <box flexGrow={1} />
      )}

      <box flexDirection="row" flexShrink={0} height={1} overflow="hidden" backgroundColor={t.background}>
        <text fg={flash ? t.success : t.muted} wrapMode="none">
          {formatLucernaDisplayLine(footerHint, Math.max(16, dims.width - 2))}
        </text>
      </box>

      <LucernaChoresOverlay
        active={choresOpen && inputActive && !confirm}
        roster={roster}
        cursor={choreCursor}
        onClose={() => setChoresOpen(false)}
        onMove={(delta) =>
          setChoreCursor((c) => Math.max(0, Math.min(Math.max(0, choreCount - 1), c + delta)))
        }
        onToggle={() => {
          const items = roster ? choreOverlayItems(roster) : [];
          const item = items[choreCursor];
          if (!item) return;
          const key = item.kind === 'entry' ? item.entry.key : item.key;
          const enabled = item.kind === 'entry' ? item.entry.enabled : false;
          const next = !enabled;
          setConfirm({
            msg: next
              ? `Enable chore ${key}? The planner may pick it.`
              : `Disable chore ${key}? The planner will not pick it.`,
            run: () =>
              void post('chores', next ? `chore ${key} on` : `chore ${key} off`, {
                key,
                enabled: next,
              }),
          });
        }}
      />

      <BudgetEditModal
        active={budgetEditOpen && inputActive && !confirm}
        current={{
          dailyActionCap: parseLucernaBudgets(status?.budgets)?.dailyCap ?? 12,
          weeklyExpensiveCap:
            parseLucernaBudgets(status?.budgets)?.windows?.weekly?.cap ??
            (parseLucernaBudgets(status?.budgets)?.weekly.match(/\/(\d+)/)?.[1]
              ? Number(parseLucernaBudgets(status?.budgets)?.weekly.match(/\/(\d+)/)?.[1])
              : 6),
          dailyTokenCeiling: parseLucernaBudgets(status?.budgets)?.dailyTokenCeiling ?? 200000,
        }}
        onCancel={() => setBudgetEditOpen(false)}
        onRequestConfirm={(knob, noun, value) => {
          const flashNoun =
            knob === 'dailyActionCap'
              ? `actions ${value}/day`
              : knob === 'weeklyExpensiveCap'
                ? `expensive ${value}/week`
                : `tokens ${value}/day`;
          setConfirm({
            msg: `Set ${noun} to ${value}? Applies at the next cycle.`,
            run: () => {
              setLocalPending((p) => ({ ...p, [knob]: value }));
              setBudgetEditOpen(false);
              void post('budgets', `budgets: ${flashNoun} · applies next cycle`, { [knob]: value });
            },
          });
        }}
      />

      <LucernaReviewOverlay
        active={!!overlay && inputActive && !confirm}
        model={overlay}
        onClose={() => setOverlay(null)}
        onReview={() => {
          if (!overlay || overlay.kind !== 'dream') return;
          setConfirm({
            msg: `Mark dream ${overlay.id} reviewed?`,
            run: () => void post('dreams/review', `reviewed ${overlay.id}`, { id: overlay.id }),
          });
        }}
        onApply={() => {
          if (!overlay || overlay.kind !== 'proposal') return;
          setConfirm({
            msg: `Mark proposal ${overlay.id} applied (status only — content not executed)?`,
            run: () =>
              void post('proposals/apply', `applied ${overlay.id} (status only)`, {
                id: overlay.id,
              }),
          });
        }}
        onCloseProposal={() => {
          if (!overlay || overlay.kind !== 'proposal') return;
          setConfirm({
            msg: `Close proposal ${overlay.id} (status only)?`,
            run: () =>
              void post('proposals/close', `closed ${overlay.id} (status only)`, {
                id: overlay.id,
              }),
          });
        }}
      />

      <ConfirmModal
        active={!!confirm && inputActive}
        message={confirm?.msg ?? ''}
        detail={confirm?.detail}
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </box>
  );
}
