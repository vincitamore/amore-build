import { useEffect, useMemo, useState } from 'react';
import { usePalette } from '../ThemeProvider';
import { resolveOrgRoot } from '../daemon';
import { FileTree } from '../components/FileTree';
import { DocView } from '../components/DocView';

/**
 * Files member — a lazy filesystem browser over the org tree, opening any file into the
 * unified DocView (markdown rendered, source highlighted, else plain). The way to reach
 * code in the TUI; the graph→doc jump and search open into the same DocView.
 */
export function FilesMember({ inputActive, onCapture, daemonUrl }: { inputActive?: boolean; onCapture?: (b: boolean) => void; daemonUrl?: string | null }) {
  const t = usePalette();
  const root = useMemo(() => resolveOrgRoot(), []);
  // Detail is keep-mounted: `detailPath` persists (what the mounted DocView renders), `detailOpen`
  // toggles visibility — open/close is never a mount/unmount (the OpenTUI-0.4.2 teardown UAF).
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [docEditing, setDocEditing] = useState(false);

  useEffect(() => {
    onCapture?.(docEditing);
  }, [docEditing, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="column" flexGrow={1} visible={!detailOpen}>
        <FileTree
          root={root}
          inputActive={inputActive && !detailOpen}
          reserve={7}
          onActivate={(abs) => {
            setDetailPath(abs);
            setDetailOpen(true);
          }}
        />
        <box flexShrink={0} paddingLeft={1}>
          <text fg={t.muted}>↑↓ navigate · →/← expand/collapse · enter open</text>
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
