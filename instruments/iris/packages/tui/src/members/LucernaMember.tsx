import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { Stat } from '../components/Stat';
import { ConfirmModal } from '../components/Modal';
import { useFlash } from '../components/use-flash';
import { useStableDimensions } from '../use-stable-dimensions';
import { tickRender } from '../debug';
import {
  deriveLucernaUiState,
  emptyDisplayRow,
  formatLucernaDisplayLine,
  formatLucernaLastActionsLine,
  lucernaActivitySub,
  lucernaActivityValue,
  lucernaBeatAgeSub,
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

function budgetSummary(budgets: unknown): string {
  if (!budgets || typeof budgets !== 'object') return '—';
  const entries = Object.entries(budgets as Record<string, unknown>).slice(0, 4);
  if (entries.length === 0) return '—';
  return entries
    .map(([k, v]) => `${k}:${typeof v === 'number' || typeof v === 'string' ? v : '?'}`)
    .join(' · ');
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
  const [scroll, setScroll] = useState(0);
  const [flash, setFlash] = useFlash();
  const [confirm, setConfirm] = useState<{ msg: string; run: () => void } | null>(null);
  const [busy, setBusy] = useState(false);

  const overlayOpen = !!overlay;

  useEffect(() => {
    if (!inputActive && confirm) setConfirm(null);
  }, [inputActive, confirm]);

  useEffect(() => {
    onCapture?.(!!confirm || overlayOpen);
  }, [confirm, overlayOpen, onCapture]);
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
    autoCommitLive: false,
  };

  const reviewRows = useMemo(
    () => toReviewRows(dreamItems, proposalItems),
    [dreamItems, proposalItems],
  );
  const pendingReview = reviewRows.filter((r) => r.pending).length;
  const selectedRow = reviewRows[Math.min(reviewCursor, Math.max(0, reviewRows.length - 1))] ?? null;

  const reserve = 20; // status + notifications + review + footer
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
              ? `enablement: dreams ${e.dreamsEnabled ? 'on' : 'off'} · auto-commit ${e.autoCommitLive ? 'live' : 'dry-run'}`
              : label,
          );
          // Force status re-read so TUI always shows file truth after write
          if (daemonUrl) await refresh(daemonUrl, () => true);
        }
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
    if (!inputActive || confirm || busy || overlayOpen) return;
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
      return setConfirm({
        msg: `Set dreams ${next ? 'ON' : 'OFF'} in lucerna.enable.json?`,
        run: () => void post('enable', 'dreams', { dreamsEnabled: next }),
      });
    }
    if (n === 'a') {
      const next = !enablement.autoCommitLive;
      return setConfirm({
        msg: `Set auto-commit ${next ? 'LIVE' : 'dry-run'} in lucerna.enable.json?`,
        run: () => void post('enable', 'auto-commit', { autoCommitLive: next }),
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

    const phaseValue = lucernaActivityValue(uiState);
    const phaseColor = uiState === 'stale' ? t.error : uiState === 'stopped' ? t.muted : t.success;
    const beat = formatBeatAge(health?.beatAgeSec);
    const dreamsBadge = enablement.dreamsEnabled ? 'dreams on' : 'dreams off';
    const commitBadge = enablement.autoCommitLive ? 'auto-commit live' : 'auto-commit dry-run';

    return (
      <>
        <box flexDirection="row" flexShrink={0}>
          <Stat
            value={phaseValue}
            label="Activity"
            sub={lucernaActivitySub(uiState, status, health)}
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
            <text fg={t.muted}>{truncate(budgetSummary(status?.budgets), Math.max(10, Math.floor(dims.width / 2) - 6))}</text>
          </Panel>
          <Panel title="Enablement" flexGrow={1}>
            <text fg={t.foreground}>{`${dreamsBadge} · ${commitBadge}`}</text>
            <text fg={t.muted}>d toggle dreams · a toggle auto-commit (confirm)</text>
          </Panel>
        </box>
        <box flexShrink={0} marginTop={1}>
          <text fg={t.muted}>{`Last actions: ${truncate(formatLucernaLastActionsLine(status), Math.max(20, dims.width - 20))}`}</text>
        </box>
      </>
    );
  }, [uiState, health, status, enablement, dims.width, t, pendingReview]);

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
      ? 'up/dn · enter open · v review/apply · x close · p log · esc'
      : uiState === 'not-installed' || uiState === 'daemon-down'
        ? 'r start · k stop · h halt · w wake · s sleep · d dreams · a auto-commit · p review'
        : 'r start · k stop · h halt · w wake · s sleep · d dreams · a auto-commit · p review · up/dn';

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

      <LucernaReviewOverlay
        active={overlayOpen && inputActive && !confirm}
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
        onConfirm={() => {
          confirm?.run();
          setConfirm(null);
        }}
        onCancel={() => setConfirm(null)}
      />
    </box>
  );
}
