import { useEffect, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from '../ThemeProvider';
import { tickRender } from '../debug';
import { Modal } from '../components/Modal';
import type { GraphConfig, LayoutMode } from '../render/graph';

const MODES: LayoutMode[] = ['force', 'cluster', 'status', 'community', 'radial'];
const MODE_HINT: Record<LayoutMode, string> = {
  force: 'organic springs + gentle status bias',
  cluster: 'grid-grouped by folder/type',
  status: 'grid-grouped by task/inbox status',
  community: 'grid-grouped by detected link communities',
  radial: 'attention rank → center (no sim)',
};
const FORCE_STEPS = [0, 0.03, 0.06, 0.12, 0.2]; // status-force strength options

/**
 * The graph's algo/config panel (`o`). ↑↓ move between rows; ←→ (or space) adjust the focused row —
 * cycling the layout mode, toggling the render overlays, or stepping the status-force strength.
 * Mode + status-force feed the LAYOUT (a change re-lays out); the rest are render toggles (instant,
 * no reflow). Kept MOUNTED; `active` toggles visibility + owns the keyboard.
 */
export function GraphConfigModal({
  active,
  mode,
  config,
  onSetMode,
  onChange,
  onClose,
}: {
  active: boolean;
  mode: LayoutMode;
  config: GraphConfig;
  onSetMode: (m: LayoutMode) => void;
  onChange: (patch: Partial<GraphConfig>) => void;
  onClose: () => void;
}) {
  const t = usePalette();
  tickRender('GraphConfigModal'); // breadcrumb — surfaces this modal in the crash log if it recurs
  const [row, setRow] = useState(0);
  useEffect(() => {
    if (active) setRow(0);
  }, [active]);

  const rows = ['Layout', 'Attention shading', 'Recency fade', 'Emphasize hubs', 'Typed edges', 'Orphans', 'Focus hops', 'Status-force'] as const;

  const stepMode = (d: number) => onSetMode(MODES[(MODES.indexOf(mode) + d + MODES.length) % MODES.length]);
  const stepForce = (d: number) => {
    const i = FORCE_STEPS.reduce((best, v, idx) => (Math.abs(v - config.statusForce) < Math.abs(FORCE_STEPS[best] - config.statusForce) ? idx : best), 0);
    onChange({ statusForce: FORCE_STEPS[(i + d + FORCE_STEPS.length) % FORCE_STEPS.length] });
  };
  const stepHops = (d: number) => onChange({ focusHops: Math.min(3, Math.max(1, config.focusHops + d)) }); // clamp to 1..3
  const adjust = (d: number) => {
    if (row === 0) return stepMode(d);
    if (row === 1) return onChange({ attention: !config.attention });
    if (row === 2) return onChange({ recencyFade: !config.recencyFade });
    if (row === 3) return onChange({ emphasizeHubs: !config.emphasizeHubs });
    if (row === 4) return onChange({ typedEdges: config.typedEdges === 'on' ? 'off' : 'on' });
    if (row === 5) return onChange({ orphans: config.orphans === 'hide-transient' ? 'all' : 'hide-transient' });
    if (row === 6) return stepHops(d);
    if (row === 7) return stepForce(d);
  };

  useKeyboard((key: { name?: string; sequence?: string }) => {
    if (!active) return; // mounted-but-hidden
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (n === 'escape' || n === 'o') return onClose();
    if (n === 'up' || n === 'k') return setRow((r) => (r - 1 + rows.length) % rows.length);
    if (n === 'down' || n === 'j') return setRow((r) => (r + 1) % rows.length);
    if (n === 'left' || n === 'h') return adjust(-1);
    if (n === 'right' || n === 'l' || n === 'space' || n === 'return' || n === 'enter') return adjust(1);
  });

  const onOff = (b: boolean) => (b ? 'on' : 'off');
  const value = (i: number): string => {
    if (i === 0) return mode;
    if (i === 1) return onOff(config.attention);
    if (i === 2) return onOff(config.recencyFade);
    if (i === 3) return onOff(config.emphasizeHubs);
    if (i === 4) return config.typedEdges;
    if (i === 5) return config.orphans;
    if (i === 6) return `${config.focusHops}-hop`;
    return config.statusForce.toFixed(2);
  };
  const valueColor = (i: number) => {
    if (i === 0 || i === 6 || i === 7) return t.primary; // numeric/mode rows use the accent
    const on = [config.attention, config.recencyFade, config.emphasizeHubs, config.typedEdges === 'on', config.orphans === 'hide-transient'][i - 1];
    return on ? t.success : t.muted;
  };

  return (
    <Modal title="Graph · algo & config" width={56} visible={active}>
      {rows.map((label, i) => {
        const sel = i === row;
        return (
          <box key={label} flexDirection="row" backgroundColor={sel ? t.selection : t.background} onMouseDown={() => setRow(i)}>
            <text fg={sel ? t.primary : t.muted}>{sel ? '› ' : '  '}</text>
            <text fg={sel ? t.foreground : t.muted}>{label.padEnd(20)}</text>
            <text fg={valueColor(i)}>{`‹ ${value(i)} ›`}</text>
          </box>
        );
      })}
      <box marginTop={1}>
        <text fg={t.muted}>
          {row === 0
            ? MODE_HINT[mode]
            : row === 5
              ? 'hide-transient: hide linkless transient-by-design docs · all: show every orphan'
              : row === 6
                ? 'focus/neighborhood radius (1..3): N hops from the seed — press n on a selected node'
                : 'attention/recency/hubs/typed apply in place · status-force re-lays out'}
        </text>
      </box>
      <text fg={t.muted}>↑↓ row · ←→ change · esc/o close</text>
    </Modal>
  );
}
