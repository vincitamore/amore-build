import { useEffect, useMemo, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import type { RGBA } from '@opentui/core';
import {
  archiveInbox,
  deleteDoc,
  listInbox,
  moveInbox,
  resolveInbox,
  type InboxListItem,
  type InboxType,
} from '@selene/regula';
import { resolveOrgRoot } from '../daemon';
import { usePalette } from '../ThemeProvider';
import type { Palette } from '../theme';
import { GroupedList, type Group, type GroupedRow } from '../components/GroupedList';
import { DocView } from '../components/DocView';
import { ConfirmModal, PickModal, ResolveModal } from '../components/Modal';
import { useFlash } from '../components/use-flash';
import { useRefreshOnActive } from '../use-refresh-on-active';

const TYPE_ORDER = ['captures', 'investigations', 'decisions', 'ideas', 'emails', 'tickets'];
const TYPE_LABEL: Record<string, string> = {
  captures: 'Captures',
  investigations: 'Investigations',
  decisions: 'Decisions',
  ideas: 'Ideas',
  emails: 'Emails',
  tickets: 'Tickets',
};
const LIFECYCLE = new Set(['ideas', 'decisions', 'investigations']);

function inboxColor(p: Palette, sub?: string): RGBA {
  switch (sub) {
    case 'decisions':
      return p.warning;
    case 'investigations':
      return p.secondary;
    case 'ideas':
      return p.info;
    case 'emails':
    case 'tickets':
      return p.success;
    default:
      return p.muted;
  }
}

type ModalKind = null | 'resolve' | 'triage' | 'delete';

/**
 * Inbox member — open queue grouped by type (collapsible), master-detail DocView, and
 * the full action layer through regula: resolve (lifecycle flip + note), triage (move
 * between subtypes), archive, delete — each confirmed/prompted via an overlay modal.
 */
export function InboxMember({
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
  const [items, setItems] = useState<InboxListItem[]>([]);
  const [selected, setSelected] = useState<GroupedRow | null>(null);
  // Detail is keep-mounted: `detailPath` persists (what the mounted DocView renders), `detailOpen`
  // toggles visibility — open/close is never a mount/unmount (the OpenTUI-0.4.2 teardown UAF).
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [docEditing, setDocEditing] = useState(false);
  const [modal, setModal] = useState<ModalKind>(null);
  const [nonce, setNonce] = useState(0);
  const [flash, setFlash] = useFlash();

  useEffect(() => {
    setItems(listInbox(root));
  }, [root, nonce]);
  const reload = () => setNonce((x) => x + 1);
  useRefreshOnActive(inputActive, reload); // keep-mounted: re-read on return so external changes show

  // A modal or the DocView editor owns the keyboard → tell the shell to yield nav.
  const captured = docEditing || modal !== null;
  useEffect(() => {
    onCapture?.(captured);
  }, [captured, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  const groups = useMemo<Group[]>(() => {
    const by = new Map<string, GroupedRow[]>();
    for (const it of items) {
      const row: GroupedRow = { id: it.path, left: it.title, right: it.type };
      let arr = by.get(it.type);
      if (!arr) by.set(it.type, (arr = []));
      arr.push(row);
    }
    const ordered: Group[] = [];
    for (const ty of TYPE_ORDER) {
      const rows = by.get(ty);
      if (rows) ordered.push({ key: ty, label: TYPE_LABEL[ty] ?? ty, color: inboxColor(t, ty), rows });
    }
    for (const [ty, rows] of by) if (!TYPE_ORDER.includes(ty)) ordered.push({ key: ty, label: ty, color: t.muted, rows });
    return ordered;
  }, [items, t]);

  const ref = selected?.id;
  const selType = selected?.right;
  const doAct = (fn: () => void, msg: string) => {
    try {
      fn();
      setFlash(msg);
      reload();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : 'action failed');
    }
    setModal(null);
  };

  useKeyboard((key: { name?: string }) => {
    if (!inputActive || detailOpen || modal) return; // detail / modal own keys
    if (!ref) return;
    const n = (key.name ?? '').toLowerCase();
    if (n === 'r') {
      if (LIFECYCLE.has(selType ?? '')) setModal('resolve');
      else setFlash(`${selType} items don't resolve — triage (m) instead`);
      return;
    }
    if (n === 'm') return setModal('triage');
    if (n === 'x') return doAct(() => archiveInbox(root, ref), 'archived');
    if (n === 'd') return setModal('delete');
  });

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" flexGrow={1} visible={!detailOpen}>
        <GroupedList
          title="Inbox"
          groups={groups}
          persistKey="inbox"
          rightColor={(row) => inboxColor(t, row.right)}
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
                ? 'enter open · r resolve · m triage · x archive · d delete'
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

      {/* Modals are kept MOUNTED and toggled via `active` (visibility) — mount/unmount is the
          OpenTUI-0.4.2 teardown crash, and opening one over a hover-churning list is the trigger. */}
      {/* Each gate ANDs inputActive: a hidden-but-mounted member's open modal must not keep
          capturing keys (mouse tab-switches bypass capture — the wrong-target-mutation leak). */}
      <ResolveModal
        active={modal === 'resolve' && !!ref && inputActive}
        onCancel={() => setModal(null)}
        onConfirm={(status, note) =>
          ref &&
          doAct(
            () => resolveInbox(root, ref, { status: status as 'resolved' | 'dropped' | 'superseded', resolution: note || undefined }),
            status,
          )
        }
      />
      <PickModal
        active={modal === 'triage' && !!ref && inputActive}
        title="Triage to"
        options={TYPE_ORDER.filter((ty) => ty !== selType).map((ty) => ({ label: TYPE_LABEL[ty] ?? ty, value: ty }))}
        onCancel={() => setModal(null)}
        onPick={(ty) => ref && doAct(() => moveInbox(root, ref, ty as InboxType), `→ ${ty}`)}
      />
      <ConfirmModal
        active={modal === 'delete' && !!ref && inputActive}
        message={`Delete "${selected?.left ?? ''}"?`}
        onCancel={() => setModal(null)}
        onConfirm={() => ref && doAct(() => deleteDoc(root, ref), 'deleted')}
      />
    </box>
  );
}
