import { useEffect, useMemo, useState } from 'react';
import { listKnowledge, type KnowledgeListItem } from '@selene/regula';
import { resolveOrgRoot } from '../daemon';
import { usePalette } from '../ThemeProvider';
import { dlog } from '../debug';
import { TreeView } from '../components/TreeView';
import { DocView } from '../components/DocView';
import { useRefreshOnActive } from '../use-refresh-on-active';

/**
 * Knowledge member — the KB browser, a proper nested folder tree (parity with the Tauri
 * KbTree) over `knowledge/`. Expand folders to drill in; open a leaf into the unified
 * DocView (read + edit, themed markdown). Default all-collapsed.
 */
export function KnowledgeMember({
  inputActive,
  onCapture,
  daemonUrl,
}: {
  inputActive?: boolean;
  onCapture?: (b: boolean) => void;
  daemonUrl?: string | null;
}) {
  const t = usePalette();
  const root = useMemo(() => resolveOrgRoot(), []);
  const [items, setItems] = useState<KnowledgeListItem[]>([]);
  // Detail is keep-mounted: `detailPath` persists (what the mounted DocView renders), `detailOpen`
  // toggles visibility — open/close is never a mount/unmount (the OpenTUI-0.4.2 teardown UAF).
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [docEditing, setDocEditing] = useState(false);

  const reload = () => {
    const t0 = Date.now();
    dlog('knowledge', 'listKnowledge start');
    const ks = listKnowledge(root);
    dlog('knowledge', `listKnowledge done n=${ks.length} in ${Date.now() - t0}ms`);
    setItems(ks);
  };
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  useRefreshOnActive(inputActive, reload); // keep-mounted: re-read on return (edits add KB articles)
  useEffect(() => {
    onCapture?.(docEditing);
  }, [docEditing, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  const treeItems = useMemo(() => items.map((it) => ({ path: it.path, label: it.title })), [items]);

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" flexGrow={1} visible={!detailOpen}>
        <TreeView
          title="Knowledge"
          items={treeItems}
          prefix="knowledge"
          inputActive={inputActive && !detailOpen}
          reserve={7}
          onActivate={(id) => {
            setDetailPath(id);
            setDetailOpen(true);
          }}
        />
        <box flexShrink={0} paddingLeft={1}>
          <text fg={t.muted}>↑↓ navigate · →/← expand/collapse · enter open/toggle</text>
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
            onSaved={() => setDocEditing(false)}
          />
        </box>
      ) : null}
    </box>
  );
}
