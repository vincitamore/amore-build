import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { Stat } from '../components/Stat';
import { ConfirmModal } from '../components/Modal';
import { useFlash } from '../components/use-flash';
import { useStableDimensions } from '../use-stable-dimensions';
import { tickRender } from '../debug';

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
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}.`;
}

/**
 * ASCII-safe fixed-width cell for OpenTUI log rows.
 * Multi-byte glyphs mis-advance the Zig cell grid; truncate then pad so shorter
 * lines clear longer previous frames.
 */
export function formatLogCell(line: string, width: number): string {
  if (width <= 0) return '';
  const ascii = line
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u2014/g, '-')
    .replace(/\u2013/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
    .replace(/[^\t\r\n\x20-\x7e]/g, '?');
  const t = truncate(ascii, width);
  return t.length >= width ? t : t.padEnd(width, ' ');
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

function activityLabel(activity: unknown): string {
  if (typeof activity === 'string' && activity) return activity;
  if (activity && typeof activity === 'object') {
    const a = activity as Record<string, unknown>;
    if (typeof a.name === 'string') return a.name;
    if (typeof a.phase === 'string') return a.phase;
    if (typeof a.type === 'string') return a.type;
  }
  return '—';
}

function budgetSummary(budgets: unknown): string {
  if (!budgets || typeof budgets !== 'object') return '—';
  const entries = Object.entries(budgets as Record<string, unknown>).slice(0, 4);
  if (entries.length === 0) return '—';
  return entries
    .map(([k, v]) => `${k}:${typeof v === 'number' || typeof v === 'string' ? v : '?'}`)
    .join(' · ');
}

function lastActionsSummary(lastActions: unknown): string {
  if (Array.isArray(lastActions) && lastActions.length > 0) {
    const first = lastActions[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      const a = first as Record<string, unknown>;
      return String(a.action ?? a.type ?? a.name ?? JSON.stringify(first));
    }
  }
  if (lastActions && typeof lastActions === 'object') {
    const keys = Object.keys(lastActions as object);
    if (keys.length) return keys.slice(0, 3).join(', ');
  }
  return 'none yet';
}

type UiState = 'daemon-down' | 'not-installed' | 'stopped' | 'running' | 'stale';

function deriveState(daemonUrl: string | null | undefined, health: Health | null, status: Status | null): UiState {
  if (!daemonUrl) return 'daemon-down';
  if (!health && !status) return 'stopped'; // still loading or empty
  const avail = health?.available ?? status?.available;
  if (avail === false && (health?.reason === 'not-installed' || status?.reason === 'not-installed')) {
    return 'not-installed';
  }
  if (avail === false) return 'not-installed';
  const stale = health?.stale ?? status?.stale;
  if (stale) return 'stale';
  // Dir present, no beat / no pid → stopped
  if (health && health.available && !health.lastBeat && health.stale === false) return 'stopped';
  if (health?.available && health.lastBeat && !stale) return 'running';
  if (status?.available && !stale) return 'running';
  return 'stopped';
}

const SCROLLBACK = 200;

/**
 * Lucerna member — agency operations console. Honest at every state:
 * iris-daemon-down, not-installed, stopped, running, stale/hung.
 * Control: h halt · w wake · s sleep (POSTs via the iris daemon proxy).
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
  const [scroll, setScroll] = useState(0);
  const [flash, setFlash] = useFlash();
  const [confirm, setConfirm] = useState<{ msg: string; run: () => void } | null>(null);

  useEffect(() => {
    if (!inputActive && confirm) setConfirm(null);
  }, [inputActive, confirm]);

  useEffect(() => {
    onCapture?.(!!confirm);
  }, [confirm, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  // HTTP poll against the iris daemon's Lucerna proxy while this tab is active.
  useEffect(() => {
    if (!daemonUrl || !inputActive) return;
    let alive = true;
    const pull = async () => {
      try {
        const r = await fetch(`${daemonUrl}/api/lucerna/health`);
        if (r.ok && alive) setHealth((await r.json()) as Health);
      } catch {
        /* daemon warming */
      }
      try {
        const r = await fetch(`${daemonUrl}/api/lucerna/status`);
        if (r.ok && alive) setStatus((await r.json()) as Status);
      } catch {
        /* ignore */
      }
      try {
        const r = await fetch(`${daemonUrl}/api/lucerna/log?n=${SCROLLBACK}`);
        if (r.ok && alive) {
          const body = (await r.json()) as { lines?: string[] };
          setLogLines(body.lines ?? []);
        }
      } catch {
        /* ignore */
      }
    };
    void pull();
    const id = setInterval(() => alive && void pull(), 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [daemonUrl, inputActive]);

  tickRender('LucernaMember');

  const uiState = deriveState(daemonUrl, health, status);
  const enablement: Enablement = status?.enablement ?? { dreamsEnabled: false, autoCommitLive: false };

  const reserve = 12; // status cards + badges + footer + borders
  const visible = Math.max(3, dims.height - reserve);
  const innerW = Math.max(16, dims.width - 6);
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

  const post = async (path: string, label: string) => {
    if (!daemonUrl) return setFlash('Iris daemon down — cannot reach Lucerna proxy');
    try {
      const r = await fetch(`${daemonUrl}/api/lucerna/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const j = (await r.json()) as { ok?: boolean; available?: boolean; reason?: string };
      if (j.available === false && j.reason === 'not-installed') {
        setFlash(`${label}: Lucerna not installed`);
      } else {
        setFlash(j.ok === false ? `${label} failed` : label);
      }
    } catch {
      setFlash(`${label} failed`);
    }
  };

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || confirm) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'up') return setScroll((s) => Math.min(s + 1, maxScroll));
    if (n === 'down') return setScroll((s) => Math.max(s - 1, 0));
    if (n === 'pageup') return setScroll((s) => Math.min(s + visible, maxScroll));
    if (n === 'pagedown') return setScroll((s) => Math.max(s - visible, 0));
    if (n === 'home') return setScroll(maxScroll);
    if (n === 'end') return setScroll(0);
    if (n === 'h') return setConfirm({ msg: 'Halt Lucerna — write halt sentinel?', run: () => void post('halt', 'halted') });
    if (n === 'w') return void post('wake', 'wake sent');
    if (n === 's') return void post('sleep', 'sleep sent');
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

    const phaseValue =
      uiState === 'stale' ? 'Hung' : uiState === 'stopped' ? 'Stopped' : activityLabel(status?.activity);
    const phaseColor = uiState === 'stale' ? t.error : uiState === 'stopped' ? t.muted : t.success;
    const beat = formatBeatAge(health?.beatAgeSec);
    const dreamsBadge = enablement.dreamsEnabled ? 'dreams on' : 'dreams off';
    const commitBadge = enablement.autoCommitLive ? 'auto-commit live' : 'auto-commit dry-run';

    return (
      <>
        <box flexDirection="row" flexShrink={0}>
          <Stat value={phaseValue} label="Activity" sub={uiState === 'running' ? 'live' : uiState} color={phaseColor} />
          <Stat
            value={beat}
            label="Beat age"
            sub={health?.lastBeat ? 'since lastBeat' : 'no beat'}
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
            sub={commitBadge}
            color={enablement.dreamsEnabled ? t.warning : t.muted}
          />
        </box>
        <box flexDirection="row" flexShrink={0} marginTop={1}>
          <Panel title="Budgets" flexGrow={1} marginRight={1}>
            <text fg={t.muted}>{truncate(budgetSummary(status?.budgets), Math.max(10, Math.floor(dims.width / 2) - 6))}</text>
          </Panel>
          <Panel title="Enablement" flexGrow={1}>
            <text fg={t.foreground}>{`${dreamsBadge} · ${commitBadge}`}</text>
          </Panel>
        </box>
        <box flexShrink={0} marginTop={1}>
          <text fg={t.muted}>{`Last actions: ${truncate(lastActionsSummary(status?.lastActions), Math.max(20, dims.width - 20))}`}</text>
        </box>
      </>
    );
  }, [uiState, health, status, enablement, dims.width, t]);

  const showLog = uiState !== 'not-installed' && uiState !== 'daemon-down';

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
      {statusSection}

      {showLog ? (
        <Panel
          title="Activity Log"
          headerRight={`${logLines.length} ln${clamped > 0 ? ` · ^${clamped}` : ' · live'} · up/dn`}
          flexGrow={1}
          marginTop={1}
        >
          <box flexDirection="column" flexGrow={1} onMouseScroll={onLogScroll}>
            {Array.from({ length: visible }, (_, i) => (
              <text key={`log-${i}`} fg={t.foreground}>
                {shown[i] ? formatLogCell(shown[i], innerW) : ' '.repeat(Math.max(0, innerW))}
              </text>
            ))}
          </box>
        </Panel>
      ) : (
        <box flexGrow={1} />
      )}

      <box flexDirection="row" flexShrink={0}>
        <text fg={flash ? t.success : t.muted}>
          {flash
            ? `${flash}   `
            : uiState === 'not-installed' || uiState === 'daemon-down'
              ? 'h halt · w wake · s sleep (needs installed Lucerna + iris daemon)'
              : 'h halt · w wake · s sleep · up/dn scroll'}
        </text>
      </box>

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
