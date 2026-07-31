import { useEffect, useMemo, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { completeTask, listTasks, pauseTask, setTaskStatus, type TaskListItem } from '@arcus/regula';
import { resolveOrgRoot } from '../daemon';
import { usePalette } from '../ThemeProvider';
import { taskStatusColor } from '../theme';
import { GroupedList, type Group, type GroupedRow } from '../components/GroupedList';
import { DocView } from '../components/DocView';
import { useFlash } from '../components/use-flash';
import { useRefreshOnActive } from '../use-refresh-on-active';

const STATUS_ORDER = ['active', 'blocked', 'review', 'incubating', 'backlog', 'paused', 'complete'];
const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  blocked: 'Blocked',
  review: 'Review',
  incubating: 'Incubating',
  backlog: 'Backlog',
  paused: 'Paused',
  complete: 'Complete',
};

/**
 * Tasks member — grouped by status (collapsible), select to open the unified DocView,
 * single-key status actions through regula (atomic status↔folder). Master-detail: the
 * grouped list and the DocView are modes, not panes (responsive at any width).
 */
export function TasksMember({
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
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [selected, setSelected] = useState<GroupedRow | null>(null);
  // Detail is keep-mounted: `detailPath` persists (what the mounted DocView renders), `detailOpen`
  // toggles visibility — open/close is never a mount/unmount (the OpenTUI-0.4.2 teardown UAF).
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [docEditing, setDocEditing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [flash, setFlash] = useFlash();

  useEffect(() => {
    setTasks(listTasks(root));
  }, [root, nonce]);

  // The DocView editor owns the keyboard while editing → tell the shell to yield nav.
  useEffect(() => {
    onCapture?.(docEditing);
  }, [docEditing, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  const groups = useMemo<Group[]>(() => {
    const by = new Map<string, GroupedRow[]>();
    for (const tk of tasks) {
      const s = tk.status ?? 'other';
      const row: GroupedRow = { id: tk.path, left: tk.title, right: s, dim: s === 'complete' || s === 'paused' };
      (by.get(s) ?? by.set(s, []).get(s)!).push(row);
    }
    const ordered: Group[] = [];
    for (const s of STATUS_ORDER) {
      const rows = by.get(s);
      if (rows) ordered.push({ key: s, label: STATUS_LABEL[s] ?? s, color: taskStatusColor(t, s), rows: rows.sort((a, b) => a.left.localeCompare(b.left)) });
    }
    for (const [s, rows] of by) if (!STATUS_ORDER.includes(s)) ordered.push({ key: s, label: s, color: t.muted, rows });
    return ordered;
  }, [tasks, t]);

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

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || detailOpen) return; // DocView owns keys in detail mode
    const ref = selected?.id;
    if (!ref) return;
    const n = (key.name ?? '').toLowerCase();
    if (n === 'c') return act(() => completeTask(root, ref), 'completed');
    if (n === 'a') return act(() => setTaskStatus(root, ref, 'active'), '→ active');
    if (n === 'b') return act(() => setTaskStatus(root, ref, 'blocked'), '→ blocked');
    if (n === 'r') return act(() => setTaskStatus(root, ref, 'review'), '→ review');
    if (n === 'p') return act(() => pauseTask(root, ref), 'paused');
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" flexGrow={1} visible={!detailOpen}>
        <GroupedList
          title="Tasks"
          groups={groups}
          persistKey="tasks"
          rightColor={(row) => taskStatusColor(t, row.right)}
          inputActive={inputActive && !detailOpen}
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
                ? 'enter open · c complete · a active · b block · r review · p pause'
                : '↑↓ navigate · ←/→ collapse · enter open'}
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
    </box>
  );
}
