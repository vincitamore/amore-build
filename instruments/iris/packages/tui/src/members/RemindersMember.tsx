import { useEffect, useMemo, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import {
  completeReminder,
  createReminder,
  dismissReminder,
  listReminders,
  setReminderStatus,
  snoozeReminder,
  type ReminderListItem,
} from '@amore/regula';
import { resolveOrgRoot } from '../daemon';
import { usePalette } from '../ThemeProvider';
import { reminderStatusColor } from '../theme';
import { GroupedList, type Group, type GroupedRow } from '../components/GroupedList';
import { DocView } from '../components/DocView';
import { PickModal } from '../components/Modal';
import { CreateReminderModal } from '../components/CreateReminderModal';
import { useFlash } from '../components/use-flash';
import { WHEN_PRESETS, formatCountdown } from '../reminder-when';
import { useRefreshOnActive } from '../use-refresh-on-active';

const STATUS_ORDER = ['pending', 'snoozed', 'ongoing', 'completed', 'dismissed'];
const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  snoozed: 'Snoozed',
  ongoing: 'Ongoing',
  completed: 'Completed',
  dismissed: 'Dismissed',
};
const ACTIVE = new Set(['pending', 'snoozed', 'ongoing']);
const DONE = new Set(['completed', 'dismissed']);

/**
 * Reminders member — collapsible groups by status (completed/dismissed collapsed by default),
 * live countdowns (overdue pinned to the top of its group and toned red), and single-key
 * lifecycle actions through regula (atomic status↔folder): complete, dismiss, ongoing,
 * reactivate, snooze (preset picker). Master-detail: the grouped list and the DocView are
 * modes, not panes.
 */
export function RemindersMember({
  inputActive,
  onCapture,
  daemonUrl,
  focusPath,
  focusKey,
}: {
  inputActive?: boolean;
  onCapture?: (b: boolean) => void;
  daemonUrl?: string | null;
  focusPath?: string;
  focusKey?: number;
}) {
  const t = usePalette();
  const root = useMemo(() => resolveOrgRoot(), []);
  const [items, setItems] = useState<ReminderListItem[]>([]);
  const [selected, setSelected] = useState<GroupedRow | null>(null);
  // Detail is keep-mounted: `detailPath` persists (what the mounted DocView renders), `detailOpen`
  // toggles visibility — open/close is never a mount/unmount (the OpenTUI-0.4.2 teardown UAF).
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [docEditing, setDocEditing] = useState(false);
  const [snoozing, setSnoozing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [flash, setFlash] = useFlash();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setItems(listReminders(root));
  }, [root, nonce]);

  // Tick the clock so countdowns advance and reminders cross into "overdue" on their own.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // While a doc edit or an overlay (snooze/create) owns the keyboard, tell the shell to yield nav.
  useEffect(() => {
    onCapture?.(docEditing || !!snoozing || creating);
  }, [docEditing, snoozing, creating, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  const groups = useMemo<Group[]>(() => {
    const by = new Map<string, GroupedRow[]>();
    for (const r of items) {
      const s = r.status ?? 'other';
      const when = s === 'snoozed' ? r.snoozedUntil : r.remindAt;
      const cd = ACTIVE.has(s) ? formatCountdown(when, now) : { text: '', overdue: false };
      const lead = cd.text ? `${cd.text.padEnd(12)}` : '';
      const row: GroupedRow = {
        id: r.path,
        left: `${lead}${r.title}`,
        right: s,
        dim: DONE.has(s),
        mainColor: cd.overdue ? t.error : undefined,
        // carried for sort (not rendered)
      };
      (row as GroupedRow & { _when: number })._when = when ? new Date(when).getTime() : Number.POSITIVE_INFINITY;
      (by.get(s) ?? by.set(s, []).get(s)!).push(row);
    }
    const ordered: Group[] = [];
    for (const s of STATUS_ORDER) {
      const rows = by.get(s);
      if (!rows) continue;
      const sorted = ACTIVE.has(s)
        ? rows.sort((a, b) => (a as GroupedRow & { _when: number })._when - (b as GroupedRow & { _when: number })._when)
        : rows.sort((a, b) => a.left.localeCompare(b.left));
      ordered.push({ key: s, label: STATUS_LABEL[s] ?? s, color: reminderStatusColor(t, s), rows: sorted });
    }
    for (const [s, rows] of by) if (!STATUS_ORDER.includes(s)) ordered.push({ key: s, label: s, color: t.muted, rows });
    return ordered;
  }, [items, now, t]);

  const reload = () => setNonce((x) => x + 1);
  useRefreshOnActive(inputActive, reload); // keep-mounted: re-read on return so external changes show
  const act = (fn: () => void, msg: string) => {
    if (!selected) return;
    try {
      fn();
      setFlash(msg);
      reload();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : 'action failed');
    }
  };

  const modal = !!snoozing || creating;

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || detailOpen || modal) return; // DocView / overlay owns keys
    const ref = selected?.id;
    const n = (key.name ?? '').toLowerCase();
    if (n === 'n') return setCreating(true);
    if (!ref) return;
    if (n === 'c') return act(() => completeReminder(root, ref), 'completed');
    if (n === 'd') return act(() => dismissReminder(root, ref), 'dismissed');
    if (n === 'o') return act(() => setReminderStatus(root, ref, 'ongoing'), '→ ongoing');
    if (n === 'r') return act(() => setReminderStatus(root, ref, 'pending'), '→ pending');
    if (n === 's') return setSnoozing(ref);
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" flexGrow={1} visible={!detailOpen}>
        <GroupedList
          title="Reminders"
          groups={groups}
          persistKey="reminders"
          defaultCollapsed={['completed', 'dismissed']}
          rightColor={(row) => reminderStatusColor(t, row.right)}
          inputActive={inputActive && !modal && !detailOpen}
          reserve={7}
          focusId={focusPath}
          focusKey={focusKey}
          onSelect={setSelected}
          onActivate={(row) => {
            setDetailPath(row.id);
            setDetailOpen(true);
          }}
        />
        <box flexShrink={0} paddingLeft={1}>
          <text fg={flash ? t.success : t.muted}>
            {flash
              ? `${flash}   `
              : selected
                ? 'enter open · c complete · d dismiss · o ongoing · r reactivate · s snooze · n new'
                : '↑↓ navigate · ←/→ collapse · n new reminder'}
          </text>
        </box>
      </box>
      {detailPath ? (
        <box flexDirection="column" flexGrow={1} visible={detailOpen}>
          <DocView
            path={detailPath}
            daemonUrl={daemonUrl}
            inputActive={inputActive && detailOpen}
            onEditingChange={setDocEditing}
            onClose={() => {
              setDetailOpen(false);
              setDocEditing(false);
            }}
            onSaved={() => {
              setDetailOpen(false);
              setDocEditing(false);
              reload();
            }}
          />
        </box>
      ) : null}
      {/* Modals kept MOUNTED, toggled via `active` (visibility) — mount/unmount is the teardown UAF.
          Gates AND inputActive so a hidden member's open modal can't keep capturing keys. */}
      <PickModal
        active={!!snoozing && inputActive}
        title="Snooze until"
        options={WHEN_PRESETS.map((p) => ({ label: p.label, value: p.compute(now) }))}
        onPick={(until) => {
          const ref = snoozing;
          setSnoozing(null);
          if (!ref) return;
          try {
            snoozeReminder(root, ref, until);
            setFlash('snoozed');
            reload();
          } catch (e) {
            setFlash(e instanceof Error ? e.message : 'snooze failed');
          }
        }}
        onCancel={() => setSnoozing(null)}
      />
      <CreateReminderModal
        active={creating && inputActive}
        onConfirm={(title, remindAt) => {
          setCreating(false);
          try {
            createReminder(root, { title, remindAt });
            setFlash('created');
            reload();
          } catch (e) {
            setFlash(e instanceof Error ? e.message : 'create failed');
          }
        }}
        onCancel={() => setCreating(false)}
      />
    </box>
  );
}
