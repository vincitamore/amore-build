import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTerminalDimensions } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  listForge,
  listInbox,
  listReminders,
  listTasks,
  type InboxListItem,
  type ReminderListItem,
  type TaskListItem,
} from '@amore/regula';
import { resolveOrgRoot } from '../daemon';
import { dlog } from '../debug';
import { usePalette } from '../ThemeProvider';
import { type Palette } from '../theme';
import { useHoverThrottle } from '../use-hover-throttle';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { runSpeculum } from '../speculum/speculum-spawn';
import {
  MAIL_UNAVAILABLE,
  PRESENCE_UNAVAILABLE,
  mailFromPayload,
  peerSeatRows,
  formatPeerSeatRow,
  peersFromPayload,
  unreadCount,
  formatAgo,
  type PeerStatus,
  type PresenceEntry,
} from '../coord/presence';
import { readConfig } from '../config';
import { Panel } from '../components/Panel';
import { Stat } from '../components/Stat';
import {
  formatLucernaPulseStatus,
  pulsePanelInnerWidth,
} from './lucerna-display';

/** Subset of `speculum status --json` used by the Dashboard Speculum pulse. */
export interface SpeculumStatusJson {
  generatedAt?: string;
  db?: { sizeBytes?: number };
  counts?: { sessions?: number; events?: number; usageRows?: number };
  ingest?: { lastIngestedAt?: string | null; forgottenFiles?: unknown };
  probes?: { registered?: number; names?: string[] };
  staleness?: {
    thresholdHours?: number;
    hoursSinceNewestSession?: number | null;
    stale?: boolean;
    message?: string;
  };
}

const SPECULUM_NOT_INSTALLED_LINE = 'speculum not installed · amore init --with-speculum';

/**
 * Coarsen an ISO timestamp into a glanceable age for the Speculum pulse
 * (`Xm ago` / `Xh ago` / `Xd ago`, or `never` when missing/unparseable).
 */
export function formatIngestAge(lastIngestedAt: string | null | undefined, now = Date.now()): string {
  if (lastIngestedAt == null || lastIngestedAt === '') return 'never';
  const ts = new Date(lastIngestedAt).getTime();
  if (Number.isNaN(ts)) return 'never';
  const ms = Math.max(0, now - ts);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * One-line Speculum pulse copy from a successful `status --json` payload.
 * Empty corpus stays honest (no fake ages); non-empty surfaces session-dir count,
 * last ingest age, stale. Wording is "session dirs" (flat total includes
 * primary + subagent rows) — the primary/subagent split lives on the Sessions
 * member strip (query-service), not this CLI-only pulse.
 */
export function formatPulseLine(status: SpeculumStatusJson, now = Date.now()): string {
  const parts = formatPulseParts(status, now);
  return parts.detail ? `${parts.status} · ${parts.detail}` : parts.status;
}

/** Split Speculum pulse so the Dashboard can put status on the label and details below. */
export function formatPulseParts(
  status: SpeculumStatusJson,
  now = Date.now(),
): { status: string; detail: string } {
  const sessions = status.counts?.sessions ?? 0;
  if (sessions === 0) {
    return { status: 'installed', detail: "0 session dirs · run 'speculum ingest'" };
  }
  const age = formatIngestAge(status.ingest?.lastIngestedAt, now);
  const stale = Boolean(status.staleness?.stale);
  return {
    status: stale ? 'stale' : 'installed',
    detail: `${sessions} session dirs · last ingest ${age}`,
  };
}

interface SpeculumPulseView {
  line: string;
  status?: string;
  detail?: string;
  stale: boolean;
  /** Tooltip-ish prose for non-install failures (shown muted under the pulse). */
  errorHint?: string;
}

interface ServerStatus {
  server: { uptime: number; connectedClients: number; lastIndexed: string };
  documents: { total: number; byType: Record<string, number>; byStatus: Record<string, number> };
  tags: { total: number; top: Array<{ tag: string; count: number }> };
}
interface GitEntry {
  hash: string;
  subject: string;
  when: string;
}

const ACTIVE_REMINDER = new Set(['pending', 'snoozed', 'ongoing']);

function fmtUptime(sec: number): string {
  if (!sec || sec < 0) return '—';
  const d = Math.floor(sec / 86400);
  if (d > 0) return `${d}d`;
  const h = Math.floor(sec / 3600);
  if (h > 0) return `${h}h`;
  return `${Math.max(1, Math.floor(sec / 60))}m`;
}
function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

/** Word-wrap a plain string to `width` columns (hard-breaking any single word longer than width). */
function PulseVital({
  label,
  value,
  subLines,
  dotFg,
  t,
  innerW,
}: {
  label: string;
  value: string;
  subLines: string[];
  dotFg: RGBA;
  t: Palette;
  innerW: number;
}) {
  const indent = '  ';
  const width = Math.max(8, innerW - indent.length);
  const wrapped = subLines.flatMap((s) => wrapText(s, width).map((ln, i) => (i === 0 ? `${indent}${ln}` : `${indent}${ln}`)));
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={t.background}>
      <box flexDirection="row" flexShrink={0} backgroundColor={t.background}>
        <text fg={dotFg} wrapMode="none">
          ●
        </text>
        <text fg={t.foreground} wrapMode="none">
          {` ${label} `}
        </text>
        <text fg={t.muted} wrapMode="word">
          {value}
        </text>
      </box>
      {wrapped.map((ln, i) => (
        <text key={i} fg={t.muted} wrapMode="none">
          {ln}
        </text>
      ))}
    </box>
  );
}

function wrapText(s: string, width: number): string[] {
  if (width < 4) return [s];
  const lines: string[] = [];
  let cur = '';
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if (cur === '') cur = w;
    else if (cur.length + 1 + w.length <= width) cur = `${cur} ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
    while (cur.length > width) {
      lines.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Human-readable duration, coarsened for a glanceable countdown. */
function humanDur(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return d < 3 && h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  if (h >= 1) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  if (m >= 1) return `${m}m`;
  return '<1m';
}

interface AgendaItem {
  id: string;
  title: string;
  effective?: number;
  overdue: boolean;
  label: string;
}

/** Active reminders → an agenda sorted overdue-first then soonest, with live countdowns. */
function buildAgenda(reminders: ReminderListItem[], now: number): AgendaItem[] {
  const items: AgendaItem[] = reminders
    .filter((r) => ACTIVE_REMINDER.has(r.status ?? ''))
    .map((r) => {
      const when = r.snoozedUntil || r.remindAt; // snoozed reminders surface at snoozed-until
      const effective = when ? new Date(when).getTime() : undefined;
      if (effective === undefined || Number.isNaN(effective)) {
        return { id: r.path, title: r.title, overdue: false, label: 'someday', effective: undefined };
      }
      const delta = effective - now;
      const overdue = delta < 0;
      return { id: r.path, title: r.title, effective, overdue, label: overdue ? `overdue ${humanDur(-delta)}` : `in ${humanDur(delta)}` };
    });
  items.sort((a, b) => {
    if (a.effective === undefined && b.effective === undefined) return a.title.localeCompare(b.title);
    if (a.effective === undefined) return 1; // untimed last
    if (b.effective === undefined) return -1;
    return a.effective - b.effective; // earliest (most overdue → soonest) first
  });
  return items;
}

// ─── Attention rail — the "what needs me" queue (dual of the retrospective Recent pane) ──────
interface RailItem {
  id: string;
  left: string; // a short left indicator (countdown for agenda; empty for the rest)
  leftFg: RGBA;
  title: string;
  open?: string; // doc path to open on click
  nav?: string; // member to jump to on click
}
interface RailSection {
  key: string;
  glyph: string;
  label: string;
  color: RGBA;
  count: number; // the meaningful tally shown in the header (may differ from items.length for summaries)
  nav?: string; // header click target
  items: RailItem[];
}

/**
 * Compose the Attention rail from local reads — everything gated on the operator, in priority
 * order, empty sections omitted: reminders (time), review-tasks + forge review queue,
 * decision-class blocks (only what your judgment can unblock), aging inbox decisions.
 */
function buildRail(
  t: Palette,
  agenda: AgendaItem[],
  tasks: TaskListItem[],
  inbox: InboxListItem[],
  forge: { dreams: number; proposals: number },
  now: number,
): RailSection[] {
  const sections: RailSection[] = [];

  if (agenda.length) {
    sections.push({
      key: 'agenda', glyph: '◔', label: 'AGENDA', color: t.info, count: agenda.length, nav: 'Reminders',
      items: agenda.map((a) => {
        const soon = a.effective !== undefined && !a.overdue && a.effective - now < 3_600_000;
        return { id: a.id, left: a.label, leftFg: a.overdue ? t.error : soon ? t.warning : t.muted, title: a.title, open: a.id };
      }),
    });
  }

  const review = tasks.filter((x) => x.status === 'review');
  if (review.length) {
    sections.push({
      key: 'review', glyph: '⚑', label: 'REVIEW', color: t.warning, count: review.length, nav: 'Tasks',
      items: review.map((x) => ({ id: x.path, left: '', leftFg: t.warning, title: x.title, open: x.path })),
    });
  }

  const decision = tasks.filter((x) => x.status === 'blocked' && x.blockedOn === 'decision');
  if (decision.length) {
    sections.push({
      key: 'decision', glyph: '⊘', label: 'BLOCKED ON YOU', color: t.error, count: decision.length, nav: 'Tasks',
      items: decision.map((x) => ({ id: x.path, left: '', leftFg: t.error, title: x.title, open: x.path })),
    });
  }

  if (forge.dreams > 0 || forge.proposals > 0) {
    const parts: string[] = [];
    if (forge.dreams) parts.push(`${forge.dreams} dream${forge.dreams === 1 ? '' : 's'}`);
    if (forge.proposals) parts.push(`${forge.proposals} proposal${forge.proposals === 1 ? '' : 's'}`);
    sections.push({
      key: 'forge-review', glyph: '☽', label: 'TO REVIEW', color: t.secondary, count: forge.dreams + forge.proposals, nav: 'Forge',
      items: [{ id: 'forge-review', left: '', leftFg: t.secondary, title: `${parts.join(' · ')} → Forge`, nav: 'Forge' }],
    });
  }

  const decisions = inbox
    .filter((x) => x.type === 'decisions' && !x.resolved)
    .sort((a, b) => String(a.created ?? '').localeCompare(String(b.created ?? ''))); // oldest first (rot signal)
  if (decisions.length) {
    sections.push({
      key: 'inbox-decisions', glyph: '✎', label: 'DECISIONS', color: t.muted, count: decisions.length, nav: 'Inbox',
      items: decisions.map((x) => ({ id: x.path, left: '', leftFg: t.muted, title: x.title, open: x.path })),
    });
  }

  return sections;
}

const SECTION_CAP = 6; // items shown per section before "… N more"

/**
 * Recent git commits for the Recent Changes panel. ASYNC (`execFile`, not `execFileSync`): a
 * synchronous spawn hung on a component remount after a detached child process had been spawned
 * (a Bun sync-`child_process` interaction), so the panel rendered once then stopped updating.
 * Async never blocks the render and sidesteps it.
 */
function fetchGitLog(root: string, n = 25): Promise<GitEntry[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['log', `--format=%h%x1f%s%x1f%cr`, '-n', String(n)],
      { cwd: root, timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          dlog('dash', `git FAIL root=${root} err=${err.message.slice(0, 140)}`);
          resolve([]);
          return;
        }
        const entries = (stdout || '')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [hash, subject, when] = line.split('\x1f');
            return { hash: hash ?? '', subject: subject ?? '', when: when ?? '' };
          });
        dlog('dash', `git ok root=${root} n=${entries.length}`);
        resolve(entries);
      },
    );
  });
}

interface GitStatus {
  branch: string;
  dirty: number; // uncommitted (staged + unstaged + untracked) entries
  ahead: number;
  behind: number;
}

// Skip a setState when the git poll returns no real change: the log is
// unchanged when its newest commit + count match (`when` is a drifting relative time, so it's
// deliberately NOT compared — a 20s-stale "2h ago" beats re-rendering the panel every poll).
const gitLogUnchanged = (prev: GitEntry[], next: GitEntry[]): boolean =>
  prev.length === next.length && prev[0]?.hash === next[0]?.hash;
const gitStatusUnchanged = (a: GitStatus | null, b: GitStatus | null): boolean =>
  !!a && !!b && a.branch === b.branch && a.dirty === b.dirty && a.ahead === b.ahead && a.behind === b.behind;

/** Working-tree pulse: branch, dirty-entry count, ahead/behind. ASYNC (never blocks the render). */
function fetchGitStatus(root: string): Promise<GitStatus | null> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain=v1', '--branch'], { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const lines = (stdout || '').split('\n');
      const head = lines.find((l) => l.startsWith('##')) ?? '';
      const branch = head.replace(/^##\s+/, '').split(/(?:\.\.\.| )/)[0] || '?';
      const ahead = Number(head.match(/ahead (\d+)/)?.[1] ?? 0);
      const behind = Number(head.match(/behind (\d+)/)?.[1] ?? 0);
      const dirty = lines.filter((l) => l && !l.startsWith('##')).length;
      resolve({ branch, dirty, ahead, behind });
    });
  });
}

interface NarrativeSection {
  date: string;
  titles: string[];
}

/**
 * The hand-authored "Recent structural changes (DATE)" sections of context/current-state.md:
 * each section's date + the bold lead of every `**Bold …**` paragraph under it (newest first).
 */
function fetchNarrative(root: string, maxSections = 12): NarrativeSection[] {
  try {
    const content = readFileSync(`${root}/context/current-state.md`, 'utf8');
    const out: NarrativeSection[] = [];
    const sectionRe = /## Recent structural changes \(([^)]+)\)\s*\n([\s\S]*?)(?=\n## |\n---|$)/g;
    let m: RegExpExecArray | null;
    while ((m = sectionRe.exec(content)) && out.length < maxSections) {
      const date = m[1];
      const titles: string[] = [];
      for (const para of m[2].split(/\n\s*\n/)) {
        const tr = para.trim();
        const bold = tr.startsWith('**') ? tr.match(/^\*\*(.+?)\*\*/) : null;
        if (bold) titles.push(bold[1].replace(/\s+/g, ' ').trim());
      }
      if (titles.length) out.push({ date, titles: titles.slice(0, 6) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Overview — stat cards (counts from regula directly, enriched by the daemon's /api/status when
 * up), an Agenda of active reminders with ticking countdowns (overdue first, in red), and a recent
 * pane (the hand-authored narrative over recent git commits). The overdue count is also surfaced
 * in the member bar.
 */
export function Dashboard({
  active = true,
  daemonUrl,
  onNavigate,
  onOpen,
}: {
  /** True while the Dashboard is the visible member. It's kept MOUNTED (never remounts), so the
   *  data would go stale otherwise — instead it re-reads whenever it becomes active and only polls
   *  live while active (no work while hidden). */
  active?: boolean;
  daemonUrl?: string | null;
  onNavigate?: (member: string) => void;
  onOpen?: (path: string) => void;
}) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  const root = useMemo(() => resolveOrgRoot(), []);
  const [now, setNow] = useState(() => Date.now());
  // Throttled hover (string-keyed) — a raw setHover per mouse-move sample re-renders the whole rail
  // ~70×/s under enableMouseMovement, the ambient churn that multiplies OpenTUI's teardown UAF.
  const [hover, hoverTo, clearHover] = useHoverThrottle<string>();

  const [reminders, setReminders] = useState<ReminderListItem[]>([]);
  const [git, setGit] = useState<GitEntry[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [narrative, setNarrative] = useState<NarrativeSection[]>([]);
  const [local, setLocal] = useState<{ active: number; blocked: number; review: number; tasksTotal: number; inbox: number } | null>(null);
  const [tasksList, setTasksList] = useState<TaskListItem[]>([]);
  const [inboxItems, setInboxItems] = useState<InboxListItem[]>([]);
  const [forgeCounts, setForgeCounts] = useState({ dreams: 0, proposals: 0 });

  // Re-read the local surfaces (tasks/inbox/reminders/narrative/forge/git) whenever the Dashboard
  // becomes active — so returning to it after completing a review item shows the change
  // (keep-mounted: it never remounts, so a one-shot mount read would go permanently stale).
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setNow(Date.now());
    const tasks = listTasks(root);
    const inb = listInbox(root);
    setTasksList(tasks);
    setInboxItems(inb);
    setLocal({
      active: tasks.filter((x) => x.status === 'active').length,
      blocked: tasks.filter((x) => x.status === 'blocked').length,
      review: tasks.filter((x) => x.status === 'review').length,
      tasksTotal: tasks.length,
      inbox: inb.length,
    });
    setReminders(listReminders(root));
    setNarrative(fetchNarrative(root));
    try {
      const f = listForge(root);
      setForgeCounts({
        dreams: f.filter((x) => x.triggeredBy === 'dream' && x.reviewStatus === 'pending').length,
        proposals: f.filter((x) => x.path.startsWith('forge/proposals/') && x.status === 'pending').length,
      });
    } catch {
      // a forge read failure must not break the dashboard
    }
    void fetchGitLog(root).then((g) => alive && g.length && setGit((prev) => (gitLogUnchanged(prev, g) ? prev : g)));
    void fetchGitStatus(root).then((s) => alive && s && setGitStatus((prev) => (gitStatusUnchanged(prev, s) ? prev : s)));
    return () => {
      alive = false;
    };
  }, [active, root]);

  // Clock (countdowns) + git refresh — only while active (paused when hidden).
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setNow(Date.now());
      void fetchGitStatus(root).then((s) => s && setGitStatus((prev) => (gitStatusUnchanged(prev, s) ? prev : s)));
      void fetchGitLog(root).then((g) => g.length && setGit((prev) => (gitLogUnchanged(prev, g) ? prev : g)));
    }, 20_000);
    return () => clearInterval(id);
  }, [active, root]);

  const [status, setStatus] = useState<ServerStatus | null>(null);
  /** Compact Lucerna pulse for the System Pulse panel (state, beat age, last notice). */
  const [lucernaPulse, setLucernaPulse] = useState<{
    available: boolean;
    state: string;
    beatAgeSec: number | null;
    lastNotification: { message?: string; kind?: string; level?: string } | null;
    pendingReview?: { dreams: number; proposals: number; total: number };
    phase?: string;
    capability?: { state?: string; resumesAt?: string; reasonCode?: string };
    tokens?: string;
    actionsToday?: number;
  } | null>(null);
  /** Speculum status freshness pulse — once at mount, again on re-activation. */
  const [speculumPulse, setSpeculumPulse] = useState<SpeculumPulseView | null>(null);
  const [peersLine, setPeersLine] = useState(() => (daemonUrl ? '…' : PRESENCE_UNAVAILABLE));
  const [peersEntries, setPeersEntries] = useState<PresenceEntry[]>([]);
  const [peersStatus, setPeersStatus] = useState<PeerStatus[]>([]);
  const [mailCount, setMailCount] = useState<number | null>(daemonUrl ? null : 0);
  const [mailUnread, setMailUnread] = useState(0);
  const [mailFrom, setMailFrom] = useState('');
  const [mailText, setMailText] = useState('');
  const [mailAgo, setMailAgo] = useState('');
  const [messagesLine, setMessagesLine] = useState(() => (daemonUrl ? '…' : MAIL_UNAVAILABLE));
  const speculumMounted = useRef(true);
  useEffect(() => {
    speculumMounted.current = true;
    return () => {
      speculumMounted.current = false;
    };
  }, []);
  const refreshSpeculum = useCallback(() => {
    void runSpeculum<SpeculumStatusJson>('status', ['--json']).then((r) => {
      if (!speculumMounted.current) return;
      if (r.ok) {
        const parts = formatPulseParts(r.json);
        setSpeculumPulse({
          line: formatPulseLine(r.json),
          status: parts.status,
          detail: parts.detail,
          stale: Boolean(r.json.staleness?.stale),
        });
        return;
      }
      if (r.error.kind === 'not-installed') {
        setSpeculumPulse({ line: SPECULUM_NOT_INSTALLED_LINE, stale: false });
        return;
      }
      // Degrade gracefully — never crash the Dashboard on spawn/parse/timeout failures.
      const hint = r.error.stderrTail
        ? `${r.error.message}: ${r.error.stderrTail.slice(0, 96)}`
        : r.error.message;
      setSpeculumPulse({ line: '—', stale: false, errorHint: hint });
    });
  }, []);
  useEffect(() => {
    refreshSpeculum();
  }, [refreshSpeculum]);
  useRefreshOnActive(active, refreshSpeculum);

  // LIVE poll while active — /api/status + coord presence/messages + lucerna pulse.
  // Every 3s while shown; paused when hidden. Coord miss is loud (never a frozen last roster).
  useEffect(() => {
    if (!active) return;
    if (!daemonUrl) {
      setPeersLine(PRESENCE_UNAVAILABLE);
      setPeersEntries([]);
      setMessagesLine(MAIL_UNAVAILABLE);
      setMailCount(0);
      setMailFrom('');
      setMailText('');
      return;
    }
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${daemonUrl}/api/status`);
        if (r.ok && alive) setStatus((await r.json()) as ServerStatus);
      } catch {
        // index still building
      }
      try {
        const r = await fetch(`${daemonUrl}/api/coord/presence`);
        if (alive) {
          if (r.ok) {
            const body = await r.json();
            const peers = peersFromPayload(body);
            setPeersLine(peers.line);
            setPeersEntries(peers.entries);
            setPeersStatus(peers.peers);
          } else {
            setPeersLine(PRESENCE_UNAVAILABLE);
            setPeersEntries([]);
            setPeersStatus([]);
          }
        }
      } catch {
        if (alive) {
          setPeersLine(PRESENCE_UNAVAILABLE);
          setPeersEntries([]);
          setPeersStatus([]);
        }
      }
      try {
        const r = await fetch(`${daemonUrl}/api/coord/messages`);
        if (alive) {
          if (r.ok) {
            const body = await r.json();
            const mail = mailFromPayload(body);
            setMailCount(mail.count);
            setMailUnread(unreadCount(mail.entries, readConfig().coordReadTs));
            setMailFrom(mail.lastFrom);
            setMailText(mail.lastText);
            setMailAgo(mail.lastTs ? formatAgo(mail.lastTs) : '');
            setMessagesLine(mail.count > 0 ? String(mail.count) : 'none');
          } else {
            setMessagesLine(MAIL_UNAVAILABLE);
            setMailCount(0);
            setMailUnread(0);
            setMailFrom('');
            setMailText('');
            setMailAgo('');
          }
        }
      } catch {
        if (alive) {
          setMessagesLine(MAIL_UNAVAILABLE);
          setMailCount(0);
          setMailUnread(0);
          setMailFrom('');
          setMailText('');
          setMailAgo('');
        }
      }
      try {
        const r = await fetch(`${daemonUrl}/api/lucerna/pulse`);
        if (r.ok && alive) {
          setLucernaPulse(
            (await r.json()) as {
              available: boolean;
              state: string;
              beatAgeSec: number | null;
              lastNotification: { message?: string; kind?: string; level?: string } | null;
              pendingReview?: { dreams: number; proposals: number; total: number };
              phase?: string;
              capability?: { state?: string; resumesAt?: string; reasonCode?: string };
              tokens?: string;
              actionsToday?: number;
            },
          );
        }
      } catch {
        // lucerna proxy optional while iris is up
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [daemonUrl, active]);

  const agenda = useMemo(() => buildAgenda(reminders, now), [reminders, now]);
  const overdueCount = agenda.filter((a) => a.overdue).length;

  // Authoritative counts from the daemon index when present, else the instant ones.
  const d = status?.documents;
  const bs = d?.byStatus ?? {};
  const bt = d?.byType ?? {};
  const activeTasks = d ? bs.active ?? 0 : local?.active ?? 0;
  const tasksTotal = d ? bt.task ?? 0 : local?.tasksTotal ?? 0;
  const inbox = d ? bt.inbox ?? 0 : local?.inbox ?? 0;
  const liveReminders = agenda.length;
  const knowledge = d ? bt.knowledge ?? 0 : null;
  const needsInput = d ? (bs.blocked ?? 0) + (bs.review ?? 0) : (local?.blocked ?? 0) + (local?.review ?? 0);
  const forgeReview = forgeCounts.dreams + forgeCounts.proposals;

  const stats: Array<{ value: string | number; label: string; sub?: string; color: RGBA; nav?: string }> = [
    { value: activeTasks, label: 'active tasks', sub: `${tasksTotal} total`, color: t.success, nav: 'Tasks' },
    { value: inbox, label: 'open inbox', color: t.warning, nav: 'Inbox' },
    { value: liveReminders, label: 'reminders', sub: overdueCount > 0 ? `${overdueCount} overdue` : undefined, color: overdueCount > 0 ? t.error : t.info, nav: 'Reminders' },
    { value: knowledge ?? '·', label: 'knowledge', color: t.info },
    { value: needsInput, label: 'needs input', sub: d ? `${bs.blocked ?? 0} blk · ${bs.review ?? 0} rev` : undefined, color: needsInput > 0 ? t.error : t.muted, nav: 'Tasks' },
    { value: forgeReview, label: 'forge review', sub: forgeReview ? `${forgeCounts.dreams} dreams · ${forgeCounts.proposals} props` : undefined, color: forgeReview > 0 ? t.secondary : t.muted, nav: 'Forge' },
  ];
  const perRow = dims.width >= 104 ? 6 : dims.width >= 68 ? 3 : 2;
  const statRows = chunk(stats, perRow);

  const wide = dims.width >= 92;
  const agendaW = Math.min(48, Math.max(30, Math.floor(dims.width * 0.42)));
  // Deterministic widths so the wrap/truncate math matches the actual box (flexGrow gave a width my
  // math couldn't predict → subjects overran the date → flex-squash garble). Row = attention + 1 gap
  // + recent = dims.width - 2 (the dashboard's own h-padding), so the two tile exactly.
  const recentW = wide ? Math.max(24, dims.width - 2 - agendaW - 1) : dims.width - 2;
  const paneInnerW = Math.max(16, recentW - 4); // inside the panel border + the scrollbar column

  // — Attention rail — stacked sections, each a compact clickable list (empty sections omitted).
  //   A <scrollbox> holds them all so the rail scrolls rather than truncating when it's full. —
  const rail = buildRail(t, agenda, tasksList, inboxItems, forgeCounts, now);
  const railTotal = rail.reduce((n, s) => n + s.count, 0);
  const railInner = (wide ? agendaW : dims.width - 2) - 5; // inside border(2) + panel padding(2) + scrollbar(1)
  const attentionPanel = (
    <Panel title="Attention" headerRight={railTotal ? `${railTotal}` : undefined} flexGrow={1} flexShrink={1} minHeight={0}>
      {rail.length === 0 ? (
        <text fg={t.muted}>nothing needs you right now.</text>
      ) : (
        // onMouseOut on the scrollbox (the container) clears the hover once the cursor leaves the rail
        // entirely; per-element onMouseOver updates it as the cursor moves between rows — the TreeView
        // pattern, which sidesteps the per-element out/over race the throttle can't resolve.
        <scrollbox scrollY flexGrow={1} minHeight={0} onMouseOut={clearHover}>
          {rail.map((sec) => {
            const shown = sec.items.slice(0, SECTION_CAP);
            const overflow = sec.items.length - shown.length;
            const hHi = hover === `h:${sec.key}`;
            return (
              <box key={sec.key} flexDirection="column" marginBottom={1}>
                <box
                  flexDirection="row"
                  backgroundColor={hHi ? t.selection : t.background}
                  onMouseOver={sec.nav ? () => hoverTo(`h:${sec.key}`) : undefined}
                  onMouseDown={sec.nav && onNavigate ? () => onNavigate(sec.nav as string) : undefined}
                >
                  <text fg={sec.color}>{`${sec.glyph} ${sec.label}`}</text>
                  <box flexGrow={1} />
                  <text fg={t.muted}>{`${sec.count}`}</text>
                </box>
                {shown.map((it) => {
                  const hi = hover === it.id;
                  const click = onOpen && it.open ? () => onOpen(it.open as string) : it.nav && onNavigate ? () => onNavigate(it.nav as string) : undefined;
                  // WRAP the title (not truncate — it was running off the right edge like Recent
                  // Changes did). The left indicator sits on line 1; continuations align under the title.
                  const leftStr = it.left ? `  ${it.left.padEnd(11).slice(0, 11)} ` : '  ';
                  const contPad = ' '.repeat(leftStr.length);
                  const wrapped = wrapText(it.title, Math.max(6, railInner - leftStr.length));
                  return (
                    <box
                      key={it.id}
                      flexDirection="column"
                      backgroundColor={hi ? t.selection : t.background}
                      onMouseOver={() => hoverTo(it.id)}
                      onMouseDown={click}
                    >
                      {wrapped.map((ln, li) => (
                        <box key={li} flexDirection="row">
                          <text fg={it.leftFg}>{li === 0 ? leftStr : contPad}</text>
                          <text fg={hi ? t.primary : t.foreground}>{ln}</text>
                        </box>
                      ))}
                    </box>
                  );
                })}
                {overflow > 0 ? <text fg={t.muted}>{`   … ${overflow} more`}</text> : null}
              </box>
            );
          })}
        </scrollbox>
      )}
    </Panel>
  );

  // — System Pulse — present-state vitals (Peers / Forge / Git / Daemon / Lucerna / Speculum), the fourth
  //   dashboard zone (counts · what-needs-me · what-happened · live-vitals). Content-height box
  //   below Attention. Pulse lives in the left column (agendaW) when wide, full width when stacked.
  const pulseColW = wide ? agendaW : dims.width - 2;
  const pulseInnerW = pulsePanelInnerWidth(pulseColW);
  const speculumLine = speculumPulse?.line ?? '…';
  const speculumHi = hover === 'speculum-pulse';
  const speculumNotInstalled = speculumLine === SPECULUM_NOT_INSTALLED_LINE;
  const speculumFailed = speculumLine === '—';
  const speculumDotFg = speculumPulse?.stale
    ? t.error
    : speculumNotInstalled || speculumFailed || !speculumPulse
      ? t.muted
      : t.info;
  const peersUnavailable = peersLine === PRESENCE_UNAVAILABLE;
  const mailUnavailable = messagesLine === MAIL_UNAVAILABLE;
  const peersLive = !peersUnavailable && peersLine !== '…' && !peersLine.startsWith('0 LIVE');
  const mailLive = !mailUnavailable && messagesLine !== 'none' && messagesLine !== '…';
  const peersDotFg = peersUnavailable ? t.error : peersLive ? t.info : t.muted;
  const mailDotFg = mailUnavailable ? t.error : mailUnread > 0 ? t.warning : mailLive ? t.info : t.muted;
  const lucernaDotFg =
    lucernaPulse?.state === 'running' && lucernaPulse.capability?.state === 'refusing'
      ? t.warning
      : lucernaPulse?.state === 'running'
        ? t.success
        : lucernaPulse?.state === 'stale'
          ? t.error
          : t.muted;
  const seatRows = peerSeatRows(peersEntries, peersStatus);
  const peerSubs = peersUnavailable
    ? []
    : seatRows.length > 0
      ? seatRows.map(formatPeerSeatRow)
      : peersLine === '…'
        ? []
        : [];
  const mailSubs: string[] = [];
  if (!mailUnavailable && mailCount && mailCount > 0) {
    if (mailFrom) mailSubs.push(`last ${mailFrom}${mailAgo ? `, ${mailAgo}` : ''}`);
    if (mailText) mailSubs.push(mailText);
  }
  const lucernaSubs: string[] = [];
  if (lucernaPulse?.state === 'running' && lucernaPulse.capability?.state === 'refusing') {
    const tok = lucernaPulse.tokens?.trim();
    if (tok) lucernaSubs.push(`token ceiling ${tok}`);
    if (lucernaPulse.actionsToday === 0) lucernaSubs.push('0 chores today');
  } else if (lucernaPulse?.lastNotification?.message) {
    lucernaSubs.push(lucernaPulse.lastNotification.message);
  }
  const speculumStatus = speculumNotInstalled
    ? 'not installed'
    : speculumFailed
      ? '—'
      : (speculumPulse?.status ?? speculumLine);
  const speculumSubs = speculumPulse?.detail
    ? [speculumPulse.detail]
    : speculumPulse?.errorHint
      ? [speculumPulse.errorHint]
      : speculumNotInstalled
        ? ["run 'amore init --with-speculum'"]
        : [];
  const peersHi = hover === 'peers-pulse';
  const mailHi = hover === 'mail-pulse';
  const mailValue = mailUnavailable
    ? MAIL_UNAVAILABLE
    : mailCount == null
      ? '…'
      : mailCount === 0
        ? 'none'
        : mailUnread > 0
          ? `${mailUnread} unread`
          : `none unread · ${mailCount} in log`;
  const pulsePanel = (
    <Panel title="Pulse" flexShrink={0} marginTop={1}>
      <box
        backgroundColor={peersHi ? t.selection : t.background}
        onMouseOver={() => hoverTo('peers-pulse')}
        onMouseDown={onNavigate ? () => onNavigate('Peers') : undefined}
      >
        <PulseVital
          label="Peers"
          value={peersUnavailable ? PRESENCE_UNAVAILABLE : peersLine}
          subLines={peerSubs}
          dotFg={peersDotFg}
          t={t}
          innerW={pulseInnerW}
        />
      </box>
      <box
        backgroundColor={mailHi ? t.selection : t.background}
        onMouseOver={() => hoverTo('mail-pulse')}
        onMouseDown={onNavigate ? () => onNavigate('Peers') : undefined}
      >
        <PulseVital
          label="Mail"
          value={mailValue}
          subLines={mailSubs}
          dotFg={mailDotFg}
          t={t}
          innerW={pulseInnerW}
        />
      </box>
      <PulseVital
        label="Forge"
        value={forgeReview > 0 ? `${forgeReview} pending review` : 'queue clear'}
        subLines={[
          `${forgeCounts.dreams} dream${forgeCounts.dreams === 1 ? '' : 's'} to review · ${forgeCounts.proposals} proposal${forgeCounts.proposals === 1 ? '' : 's'}`,
        ]}
        dotFg={forgeReview > 0 ? t.secondary : t.muted}
        t={t}
        innerW={pulseInnerW}
      />
      <PulseVital
        label="Git"
        value={
          gitStatus
            ? `${gitStatus.branch} · ${gitStatus.dirty > 0 ? `${gitStatus.dirty} uncommitted` : 'clean'}${gitStatus.ahead ? ` ↑${gitStatus.ahead}` : ''}`
            : '…'
        }
        subLines={[`last commit ${git[0]?.when ?? '—'}`]}
        dotFg={gitStatus ? (gitStatus.dirty > 0 ? t.warning : t.success) : t.muted}
        t={t}
        innerW={pulseInnerW}
      />
      <PulseVital
        label="Daemon"
        value={status ? `up ${fmtUptime(status.server.uptime)} · ${status.documents.total} docs` : 'starting…'}
        subLines={[]}
        dotFg={status ? t.info : t.muted}
        t={t}
        innerW={pulseInnerW}
      />
      <PulseVital
        label="Lucerna"
        value={formatLucernaPulseStatus(lucernaPulse, Math.max(20, pulseInnerW - 10))}
        subLines={lucernaSubs}
        dotFg={lucernaDotFg}
        t={t}
        innerW={pulseInnerW}
      />
      <box
        backgroundColor={speculumHi ? t.selection : t.background}
        onMouseOver={() => hoverTo('speculum-pulse')}
        onMouseDown={onNavigate ? () => onNavigate('Sessions') : undefined}
      >
        <PulseVital
          label="Speculum"
          value={speculumStatus}
          subLines={speculumSubs}
          dotFg={speculumDotFg}
          t={t}
          innerW={pulseInnerW}
        />
      </box>
    </Panel>
  );

  // — Recent pane: TWO fixed boxes, each filling half + scrolling its OWN content (DocView pattern:
  // a <scrollbox> inside each Panel) — keeps the fullscreen layout clean, no spanning scroll.
  // minHeight={0} + flexShrink on the chain lets the panels shrink below their content at short
  // heights so the scrollboxes clip (the "Recent Commits contents overwrite the card" class of
  // overflow — content must flow downward, not draw over the border).
  const recentPanel = (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} width={wide ? recentW : undefined} marginTop={wide ? undefined : 1}>
      <Panel title="Recent Changes" flexGrow={1} flexShrink={1} minHeight={0}>
        <scrollbox scrollY flexGrow={1} minHeight={0}>
          {narrative.length === 0 ? (
            <text fg={t.muted}>none recorded in current-state.md</text>
          ) : (
            narrative.map((sec) => (
              <box key={sec.date} flexDirection="column">
                <text fg={t.secondary}>{sec.date}</text>
                {sec.titles.map((title, i) =>
                  // WRAP (not truncate) so a long narrative lead stays fully readable — it was
                  // running off the right edge. Hanging indent: first line at 2, continuations at 4.
                  wrapText(title, Math.max(8, paneInnerW - 5)).map((ln, j) => (
                    <text key={`${sec.date}-${i}-${j}`} fg={t.foreground}>{`${j === 0 ? '  ' : '    '}${ln}`}</text>
                  )),
                )}
              </box>
            ))
          )}
        </scrollbox>
      </Panel>
      <Panel title="Recent Commits" headerRight="git" flexGrow={1} flexShrink={1} minHeight={0} marginTop={1}>
        <scrollbox scrollY flexGrow={1} minHeight={0}>
          {git.length === 0 ? (
            <text fg={t.muted}>no git history (or not a repo)</text>
          ) : (
            git.map((g, i) => (
              <box key={`${g.hash}-${i}`} flexDirection="row">
                <text fg={t.muted}>{'› '}</text>
                <text fg={t.foreground}>{truncate(g.subject, Math.max(8, paneInnerW - 2 - g.when.length - 2))}</text>
                <box flexGrow={1} />
                <text fg={t.muted}>{g.when}</text>
              </box>
            ))
          )}
        </scrollbox>
      </Panel>
    </box>
  );

  return (
    <box flexDirection="column" flexGrow={1} width="100%" backgroundColor={t.background} paddingLeft={1} paddingRight={1} paddingTop={1}>
      {statRows.map((row, ri) => (
        <box key={`statrow-${ri}`} flexDirection="row" flexShrink={0}>
          {row.map((s) => (
            <Stat key={s.label} value={s.value} label={s.label} sub={s.sub} color={s.color} onSelect={s.nav && onNavigate ? () => onNavigate(s.nav as string) : undefined} />
          ))}
        </box>
      ))}

      {/* Left column (Attention + Pulse) + Recent pane — side by side when wide, stacked when narrow */}
      <box flexDirection={wide ? 'row' : 'column'} flexGrow={1} marginTop={1}>
        {wide ? (
          <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={0} width={agendaW} marginRight={1}>
            {attentionPanel}
            {pulsePanel}
          </box>
        ) : (
          <>
            {attentionPanel}
            {pulsePanel}
          </>
        )}
        {recentPanel}
      </box>

      {/* Footer */}
      <box flexDirection="row" marginTop={1} paddingLeft={1} paddingRight={1}>
        <text fg={t.muted}>{status ? `server uptime ${fmtUptime(status.server.uptime)}` : root}</text>
        <box flexGrow={1} />
        <text fg={t.muted}>{status ? `${status.documents.total} docs indexed` : 'regula · direct-file'}</text>
      </box>
    </box>
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
