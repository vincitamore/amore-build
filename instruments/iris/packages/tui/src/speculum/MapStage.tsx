/**
 * Sessions Map stage — Panel-framed density / cluster scatter of the session RECORD.
 *
 * Composition: pure `buildSessionWorld` anchors + Graph `renderView` (glyphs, cluster hue)
 * with EMPTY links (no force-edge web). Viewport chrome matches GraphView (pan/zoom/fit/hit-test).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { useRefreshOnActive } from '../use-refresh-on-active';
import {
  displayLabel,
  renderView,
  type FocusState,
  type GraphData,
  type WorldNode,
} from '../render/graph';
import {
  anchorViewport,
  fitViewport,
  panViewport,
  screenToWorld,
  zoomViewport,
  zoomViewportAt,
  type Viewport,
  type WorldPoint,
} from '../render/viewport';
import { blitGrid, GRAPH_BG, type DrawBuffer } from '../graph-view/blit';
import {
  openQueryService,
  resolveIndexPath,
  type QueryService,
  type SessionListRow,
} from './query-service';
import {
  buildSessionWorld,
  hitTestSession,
  sessionWorldToGraph,
  type MapMode,
  type SessionWorld,
} from './map-data';

const STATUS_BG = RGBA.fromInts(30, 34, 42);
const STATUS_FG = RGBA.fromInts(205, 211, 220);
const STATUS_DIM = RGBA.fromInts(120, 128, 140);
const SESSION_LIST_LIMIT = 500;
const INSTALL_RECIPE = 'amore init --with-speculum';

interface MouseLike {
  x: number;
  y: number;
  button?: number;
  scroll?: { direction?: string; deltaY?: number };
}

interface DragState {
  anchorWorld: WorldPoint;
  scale: number;
  startX: number;
  startY: number;
  moved: boolean;
}

type SoftState =
  | { kind: 'loading' }
  | { kind: 'missing'; path: string }
  | { kind: 'schema'; version: number; path: string }
  | { kind: 'busy'; path: string }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; path: string }
  | { kind: 'ready'; path: string; sessions: SessionListRow[] };

function padRow(text: string, width: number): string {
  if (width <= 0) return '';
  const ellipsis = '\u2026';
  const s = text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}${ellipsis}`;
  return s.length >= width ? s.slice(0, width) : s.padEnd(width, ' ');
}

function FixedClearRow({
  text,
  width,
  color,
}: {
  text: string;
  width: number;
  color: RGBA;
}) {
  const t = usePalette();
  const cell = text.length === width ? text : padRow(text, width);
  return (
    <box height={1} width={width} flexShrink={0} overflow="hidden" backgroundColor={t.background}>
      <text fg={color} wrapMode="none">
        {cell}
      </text>
    </box>
  );
}

function softCopy(state: SoftState): { title: string; lines: string[] } {
  switch (state.kind) {
    case 'loading':
      return { title: 'loading', lines: ['opening session index…'] };
    case 'missing':
      return {
        title: 'index missing',
        lines: [
          'No derived session index found.',
          `Expected: ${state.path}`,
          "run 'speculum ingest'",
          `Install recipe if needed: ${INSTALL_RECIPE}`,
          'r to retry',
        ],
      };
    case 'schema':
      return {
        title: 'schema mismatch',
        lines: [
          `Index schema v${state.version} is not supported by this reader.`,
          'Upgrade the dash or re-ingest with a matching speculum CLI.',
          `Path: ${state.path}`,
          'r to retry',
        ],
      };
    case 'busy':
      return {
        title: 'corpus busy',
        lines: [
          'Session index is locked (ingest in progress).',
          'Wait for ingest to finish, then r to retry.',
          `Path: ${state.path}`,
        ],
      };
    case 'error':
      return {
        title: 'map error',
        lines: [state.message, 'r to retry'],
      };
    case 'empty':
      return {
        title: 'empty',
        lines: [
          'Index is open but has no sessions.',
          "run 'speculum ingest'",
          'r to retry',
        ],
      };
    default:
      return { title: 'ready', lines: [] };
  }
}

/**
 * Interactive session map. Opens the readonly query-service, places sessions with
 * `buildSessionWorld`, draws via Graph `renderView` with zero links.
 */
export function MapStage({
  inputActive = true,
  onFlash,
  onOpenSession,
  initialSelected,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  onOpenSession?: (sessionId: string, opts?: { eventId?: string | number; ts?: string }) => void;
  /** Seed selection (smokes / jump restore). */
  initialSelected?: string;
}) {
  const t = usePalette();
  const dims = useTerminalDimensions();
  // Nested under SessionsMember: member pad + panel border/pad ≈ 8–10; 2 status rows live inside the body.
  const cols = Math.max(16, dims.width - 10);
  const rows = Math.max(6, dims.height - 12 - 2); // room for panel title + outer chrome + 2 status
  const width = cols * 2;
  const height = rows * 4;

  const [soft, setSoft] = useState<SoftState>({ kind: 'loading' });
  const [mode, setMode] = useState<MapMode>('cluster');
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
  const [hovered, setHovered] = useState<string | null>(null);
  const qsRef = useRef<QueryService | null>(null);
  const aliveRef = useRef(true);
  const onFlashRef = useRef(onFlash);
  onFlashRef.current = onFlash;
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      try {
        qsRef.current?.close();
      } catch {
        /* ignore */
      }
      qsRef.current = null;
    };
  }, []);

  const load = useCallback(() => {
    try {
      qsRef.current?.close();
    } catch {
      /* ignore */
    }
    qsRef.current = null;

    const path = resolveIndexPath();
    let qs: QueryService;
    try {
      qs = openQueryService({ path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(msg)) {
        if (aliveRef.current) setSoft({ kind: 'missing', path });
        onFlashRef.current?.('map: index missing');
        return;
      }
      if (aliveRef.current) setSoft({ kind: 'error', message: msg });
      onFlashRef.current?.(`map failed: ${msg}`);
      return;
    }
    qsRef.current = qs;

    if (!qs.schemaOK()) {
      if (aliveRef.current) setSoft({ kind: 'schema', version: qs.getVersion(), path: qs.path });
      onFlashRef.current?.('map: schema mismatch');
      return;
    }

    const sessions = qs.sessionList(SESSION_LIST_LIMIT);
    if (qs.busy()) {
      if (aliveRef.current) setSoft({ kind: 'busy', path: qs.path });
      onFlashRef.current?.('map: corpus busy');
      return;
    }
    if (sessions.length === 0) {
      if (aliveRef.current) setSoft({ kind: 'empty', path: qs.path });
      onFlashRef.current?.('map: empty index');
      return;
    }
    if (aliveRef.current) {
      setSoft({ kind: 'ready', path: qs.path, sessions });
      setSelected(null);
      setViewport(null);
      onFlashRef.current?.(`map: ${sessions.length} sessions`);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useRefreshOnActive(inputActive, load);

  const sessions = soft.kind === 'ready' ? soft.sessions : null;

  const sessionWorld: SessionWorld | null = useMemo(() => {
    if (!sessions) return null;
    return buildSessionWorld(sessions, mode);
  }, [sessions, mode]);

  const { graph, worldNodes } = useMemo(() => {
    if (!sessionWorld) {
      return {
        graph: { nodes: [], links: [] } as GraphData,
        worldNodes: [] as WorldNode[],
      };
    }
    return sessionWorldToGraph(sessionWorld);
  }, [sessionWorld]);

  // Structure-invalidating mode change → reset viewport (GraphView pattern).
  const lastMode = useRef(mode);
  if (lastMode.current !== mode) {
    lastMode.current = mode;
    if (viewport) setViewport(null);
  }

  // Re-seed selection when soft state becomes ready and initialSelected is set.
  useEffect(() => {
    if (soft.kind === 'ready' && initialSelected) {
      const ok = soft.sessions.some((s) => s.id === initialSelected);
      if (ok) setSelected(initialSelected);
    }
  }, [soft, initialSelected]);

  const vp = useMemo(
    () => viewport ?? fitViewport(worldNodes, width, height),
    [viewport, worldNodes, width, height],
  );
  const fitScale = useMemo(
    () => fitViewport(worldNodes, width, height).scale,
    [worldNodes, width, height],
  );
  const zoomFactor = fitScale > 0 ? vp.scale / fitScale : 1;

  const focusId = selected ?? hovered;
  const focus = useMemo<FocusState | undefined>(
    () => (focusId ? { selected: focusId, neighbors: new Set() } : undefined),
    [focusId],
  );

  const { grid, nodes: screenNodes } = useMemo(
    () =>
      renderView(
        graph,
        worldNodes,
        vp,
        {
          cols,
          rows,
          mode: 'cluster',
          attention: true,
        },
        focus,
      ),
    [graph, worldNodes, vp, cols, rows, focus],
  );

  const gridRef = useRef(grid);
  gridRef.current = grid;
  const draw = useCallback(
    (buffer: DrawBuffer) => {
      blitGrid(buffer, gridRef.current, 0, 0, cols, rows);
    },
    [cols, rows],
  );

  const hitTest = useCallback(
    (cellX: number, cellY: number): string | null => hitTestSession(screenNodes, cellX, cellY),
    [screenNodes],
  );

  const openSelected = useCallback(
    (id: string | null) => {
      if (!id) return;
      const row = sessions?.find((s) => s.id === id);
      onOpenSession?.(id, { ts: row?.startedAt });
      onFlashRef.current?.(`open session ${id.slice(-8)}`);
    },
    [sessions, onOpenSession],
  );

  const sub = useCallback((e: MouseLike) => ({ x: e.x * 2 + 1, y: e.y * 4 + 2 }), []);

  useKeyboard((key: { name?: string; sequence?: string }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    const seq = key.sequence ?? '';

    if (n === 'r') {
      load();
      return;
    }

    if (soft.kind !== 'ready') return;

    if ((n === 'return' || n === 'enter') && selected) {
      openSelected(selected);
      return;
    }
    if (n === 'escape') {
      if (selected) setSelected(null);
      return;
    }
    if (n === 'd') {
      setMode((m) => (m === 'cluster' ? 'density' : 'cluster'));
      return;
    }
    if (n === 'left') setViewport(panViewport(vp, -3, 0));
    else if (n === 'right') setViewport(panViewport(vp, 3, 0));
    else if (n === 'up') setViewport(panViewport(vp, 0, -2));
    else if (n === 'down') setViewport(panViewport(vp, 0, 2));
    else if (n === '=' || n === '+' || seq === '+' || seq === '=') setViewport(zoomViewport(vp, 1.25));
    else if (n === '-' || n === '_' || seq === '-') setViewport(zoomViewport(vp, 0.8));
    else if (n === 'f' || n === '0') setViewport(null);
    else if (n === 'c') {
      const id = selected ?? hovered;
      const target = id ? worldNodes.find((w) => w.id === id) : undefined;
      if (target) setViewport({ ...vp, cx: target.x, cy: target.y });
    }
  });

  const onMouseDown = useCallback(
    (e: MouseLike) => {
      dragRef.current = {
        anchorWorld: screenToWorld(sub(e), vp, width, height),
        scale: vp.scale,
        startX: e.x,
        startY: e.y,
        moved: false,
      };
    },
    [vp, width, height, sub],
  );

  const onMouseDrag = useCallback(
    (e: MouseLike) => {
      const d = dragRef.current;
      if (!d) return;
      if (e.x !== d.startX || e.y !== d.startY) d.moved = true;
      const s = sub(e);
      setViewport(anchorViewport(d.anchorWorld, d.scale, s.x, s.y, width, height));
    },
    [width, height, sub],
  );

  const onMouseUp = useCallback(
    (e: MouseLike) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d && !d.moved && (e.button ?? 0) === 0) {
        const hit = hitTest(e.x, e.y);
        if (hit && hit === selected) openSelected(hit);
        else setSelected(hit);
      }
    },
    [hitTest, selected, openSelected],
  );

  const onMouseMove = useCallback(
    (e: MouseLike) => {
      if (dragRef.current) return;
      const hit = hitTest(e.x, e.y);
      setHovered((h) => (h === hit ? h : hit));
    },
    [hitTest],
  );

  const onMouseScroll = useCallback(
    (e: MouseLike) => {
      let dir = e.scroll?.direction;
      if (!dir && typeof e.scroll?.deltaY === 'number') dir = e.scroll.deltaY < 0 ? 'up' : 'down';
      if (!dir && e.button === 4) dir = 'up';
      if (!dir && e.button === 5) dir = 'down';
      if (!dir) return;
      const s = sub(e);
      setViewport(zoomViewportAt(vp, dir === 'up' ? 1.2 : 1 / 1.2, s.x, s.y, width, height));
    },
    [vp, width, height, sub],
  );

  const rowW = Math.max(16, dims.width - 8);
  const groupCount = sessionWorld?.groupKeys.length ?? 0;
  const selNode = selected ? sessionWorld?.nodes.find((n) => n.id === selected) : undefined;

  const headerRight =
    soft.kind === 'ready'
      ? `${soft.sessions.length} sess · ${mode}`
      : soft.kind === 'loading'
        ? 'loading'
        : soft.kind;

  const infoLine =
    soft.kind === 'ready'
      ? ` ${soft.sessions.length} sessions · 0 links · ${mode}${groupCount ? ` (${groupCount})` : ''} · ${zoomFactor.toFixed(1)}× zoom` +
        (selNode
          ? `   ◉ ${displayLabel(selNode.label)} · ${selNode.groupKey} · turns ${selNode.turnCount}`
          : '')
      : ` ${softCopy(soft).title}`;

  const controlLine =
    soft.kind === 'ready'
      ? ' drag pan · scroll zoom · click select · click·click / ⏎ open · [d]ensity/cluster · [f]it [c]enter [r]eload'
      : ' r retry';

  const softBody =
    soft.kind !== 'ready' ? (
      <box flexDirection="column" flexShrink={0}>
        {softCopy(soft).lines.map((line, i) => (
          <FixedClearRow
            key={`s-${i}`}
            width={rowW}
            color={i === 0 ? (soft.kind === 'error' || soft.kind === 'schema' ? t.error : t.muted) : t.muted}
            text={padRow(line, rowW)}
          />
        ))}
      </box>
    ) : null;

  return (
    <Panel title="Map" headerRight={headerRight} flexGrow={1} minHeight={0} active={!!inputActive}>
      {softBody ?? (
        <box flexDirection="column" flexGrow={1} width="100%" minHeight={0}>
          <box
            flexGrow={1}
            width="100%"
            minHeight={0}
            backgroundColor={GRAPH_BG}
            renderAfter={draw}
            onMouseDown={onMouseDown}
            onMouseDrag={onMouseDrag}
            onMouseUp={onMouseUp}
            onMouseMove={onMouseMove}
            onMouseScroll={onMouseScroll}
          />
          <box width="100%" height={1} flexShrink={0} overflow="hidden" backgroundColor={STATUS_BG}>
            <FixedClearRow width={rowW} color={STATUS_FG} text={padRow(infoLine.trimStart(), rowW)} />
          </box>
          <box width="100%" height={1} flexShrink={0} overflow="hidden" backgroundColor={GRAPH_BG}>
            <FixedClearRow width={rowW} color={STATUS_DIM} text={padRow(controlLine, rowW)} />
          </box>
        </box>
      )}
    </Panel>
  );
}
