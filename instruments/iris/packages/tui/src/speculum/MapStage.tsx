/**
 * Sessions Map stage — Panel-framed timeline / structure scatter of the session RECORD.
 *
 * Composition: pure one-house world builders + Graph `renderView` (glyphs, origin hue)
 * with evidence links only (parentage + event_links + session_links). Viewport chrome
 * matches GraphView (pan/zoom/fit/hit-test). Legend is a canvas OVERLAY (top-right,
 * same draw/hit geometry contract as graph-view) so it consumes zero flex rows.
 * Timeline mode reserves the canvas bottom row as a time axis.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { RGBA } from '@opentui/core';
import { usePalette } from '../ThemeProvider';
import { Panel } from '../components/Panel';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { useStableDimensions } from '../use-stable-dimensions';
import type { MeasuredSize } from '../use-measured-size';
import { seedStageBox } from './sessions-layout';
import {
  renderView,
  type Cell,
  type FocusState,
  type GraphData,
  type WorldNode,
} from '../render/graph';
import {
  anchorViewport,
  fitViewport,
  panViewport,
  screenToWorld,
  worldToScreen,
  zoomViewport,
  zoomViewportAt,
  type Viewport,
  type WorldPoint,
} from '../render/viewport';
import { BrailleCanvas } from '../render/braille';
import { attentionShade, clusterColor, EDGE_FAINT, type RGB } from '../render/color';
import { blitGrid, GRAPH_BG, type DrawBuffer } from '../graph-view/blit';
import {
  openQueryService,
  resolveIndexPath,
  type QueryService,
  type SessionAnnotation,
  type SessionListRow,
  type SessionMapLink,
} from './query-service';
import {
  budgetMapCanvasRows,
  buildMapLegendRows,
  buildSessionWorld,
  clampMapLegendEntries,
  DEFAULT_ALLOWED_AGENTS,
  DEFAULT_ALLOWED_ORIGINS,
  errorDensityTier,
  filtersShortLabel,
  formatHoverReadout,
  formatLinksStatus,
  formatSelectionReadout,
  hitTestSession,
  layoutAxisStrip,
  legendToggleTarget,
  lightnessStatusLabel,
  countCoVisibleLinks,
  eventToCanvasCell,
  eventToCanvasSubpixel,
  mapCanvasBodyRows,
  mapCanvasTooSmall,
  mapFitPadding,
  mapLegendHitAt,
  minMapCanvasRows,
  modeStatusLabel,
  neighborhoodIds,
  paintMapLegendOntoGrid,
  partitionDrawnLinks,
  resolveMapCellWinners,
  selectDrawnLinks,
  selectZoomTierLabels,
  sessionWorldToGraph,
  worldNodeIdSet,
  ZOOM_TIER_MIN,
  type MapAgent,
  type MapCanvasOrigin,
  type MapEdgeKind,
  type MapLightness,
  type MapMode,
  type MapOrigin,
  type MapPaintCandidate,
  type SessionWorld,
} from './map-data';
import { nodeGlyph } from '../render/graph';

const STATUS_BG = RGBA.fromInts(30, 34, 42);
const STATUS_FG = RGBA.fromInts(205, 211, 220);
const STATUS_DIM = RGBA.fromInts(120, 128, 140);
/** Axis strip chrome (month/week ticks) — palette-adjacent slate. */
const AXIS_CHROME: RGB = { r: 120, g: 128, b: 140 };
/** Full-set fetch ceiling — well above any realistic corpus; never a soft product cap. */
const SESSION_LIST_FETCH = 1_000_000;
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
  | {
      kind: 'ready';
      path: string;
      sessions: SessionListRow[];
      /** Total sessions in the index (honest coverage denominator). */
      total: number;
      /** Evidence edges from sessionLinks (parentage + event + resumed/shared). */
      links: SessionMapLink[];
      /** session_annotations by id (empty on v5 / missing table). */
      annotations: Record<string, SessionAnnotation>;
    };

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
  bg,
  onMouseDown,
}: {
  text: string;
  width: number;
  color: RGBA;
  bg?: RGBA;
  onMouseDown?: () => void;
}) {
  const t = usePalette();
  const cell = text.length === width ? text : padRow(text, width);
  return (
    <box
      height={1}
      width={width}
      flexShrink={0}
      overflow="hidden"
      backgroundColor={bg ?? t.background}
      onMouseDown={onMouseDown}
    >
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
 * one-house world builders, draws via Graph `renderView` with evidence links.
 *
 * Canvas height is an EXPLICIT fit-clamp from the residual stage host (not a
 * flexGrow measure fight against the React legend). Legend is fixed-slot React
 * chrome budgeted before the canvas so the blit rows always match the box.
 */
/** Panel title+borders (~3) + status/control lines (2). */
const MAP_BASE_CHROME = 5;
/** Panel paddingLeft+Right — content width is host width minus this. */
const MAP_PANEL_PAD_COLS = 2;

export function MapStage({
  inputActive = true,
  onFlash,
  onOpenSession,
  initialSelected,
  stageBox: stageBoxProp,
}: {
  inputActive?: boolean;
  onFlash?: (msg: string) => void;
  onOpenSession?: (sessionId: string, opts?: { eventId?: string | number; ts?: string }) => void;
  /** Seed selection (smokes / jump restore). */
  initialSelected?: string;
  /** Residual host box from SessionsMember; optional for isolated stage smokes. */
  stageBox?: MeasuredSize;
}) {
  const t = usePalette();
  const dims = useStableDimensions();
  const stageBox = stageBoxProp ?? seedStageBox(dims.width, dims.height);

  const [soft, setSoft] = useState<SoftState>({ kind: 'loading' });
  /** density = timeline (default); cluster = structure. */
  const [mode, setMode] = useState<MapMode>('density');
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [allowedOrigins, setAllowedOrigins] = useState<Set<MapOrigin>>(
    () => new Set(DEFAULT_ALLOWED_ORIGINS),
  );
  const [allowedAgents, setAllowedAgents] = useState<Set<MapAgent>>(
    () => new Set(DEFAULT_ALLOWED_AGENTS),
  );
  const [hiddenEdgeKinds, setHiddenEdgeKinds] = useState<Set<MapEdgeKind>>(() => new Set());
  /** Exclusive lightness channel: volume-halo (default) ↔ error-density (`e`). */
  const [lightness, setLightness] = useState<MapLightness>('volume');
  /** Legend overlay visible by default (graph-view `l` convention). */
  const [showLegend, setShowLegend] = useState(true);
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

    const st = qs.status();
    const total = st.sessions;
    // Full-set fetch — no product 500 cap. Coverage line reports showing N of M.
    const sessions = qs.sessionList(SESSION_LIST_FETCH);
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
    const ids = sessions.map((s) => s.id);
    // sessionLinks soft-degrades to links() when session_links is absent (v5).
    const links = qs.sessionLinks(ids);
    const annotations = qs.annotations(ids);
    if (aliveRef.current) {
      setSoft({
        kind: 'ready',
        path: qs.path,
        sessions,
        total: Math.max(total, sessions.length),
        links,
        annotations,
      });
      setSelected(null);
      setViewport(null);
      onFlashRef.current?.(
        `map: showing ${sessions.length} of ${Math.max(total, sessions.length)} · ${formatLinksStatus(0, links.length)}`,
      );
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useRefreshOnActive(inputActive, load);

  const sessions = soft.kind === 'ready' ? soft.sessions : null;
  const evidenceLinks = soft.kind === 'ready' ? soft.links : [];
  const annotationMap = soft.kind === 'ready' ? soft.annotations : {};
  const totalSessions = soft.kind === 'ready' ? soft.total : 0;

  const populationFilters = useMemo(
    () => ({ origins: allowedOrigins, agents: allowedAgents }),
    [allowedOrigins, allowedAgents],
  );

  const sessionWorld: SessionWorld | null = useMemo(() => {
    if (!sessions) return null;
    return buildSessionWorld(sessions, mode, populationFilters);
  }, [sessions, mode, populationFilters]);

  const subagentsVisible = allowedAgents.has('subagent');

  /** Visible node ids = current population (filters applied). Links load/draw only here. */
  const visibleNodeIds = useMemo(
    () => (sessionWorld ? worldNodeIdSet(sessionWorld) : new Set<string>()),
    [sessionWorld],
  );

  /** Loaded denominator: both endpoints in the current population (not the raw corpus fetch). */
  const loadedLinkCount = useMemo(
    () => countCoVisibleLinks(evidenceLinks, visibleNodeIds),
    [evidenceLinks, visibleNodeIds],
  );

  const drawnLinks = useMemo(() => {
    if (!sessionWorld) return [] as SessionMapLink[];
    return selectDrawnLinks(sessionWorld, evidenceLinks, {
      selected,
      subagentsVisible,
      hiddenEdgeKinds,
    });
  }, [sessionWorld, evidenceLinks, selected, subagentsVisible, hiddenEdgeKinds]);

  const { solid: solidLinks, faint: faintLinks } = useMemo(
    () => partitionDrawnLinks(drawnLinks),
    [drawnLinks],
  );

  const { graph, worldNodes } = useMemo(() => {
    if (!sessionWorld) {
      return {
        graph: { nodes: [], links: [] } as GraphData,
        worldNodes: [] as WorldNode[],
      };
    }
    // Solid kinds through renderView; faint shared_artifact overlaid after.
    return sessionWorldToGraph(sessionWorld, solidLinks);
  }, [sessionWorld, solidLinks]);

  const legend = useMemo(() => {
    if (!sessions) return [];
    return buildMapLegendRows(
      sessions,
      evidenceLinks,
      allowedOrigins,
      allowedAgents,
      hiddenEdgeKinds,
    );
  }, [sessions, evidenceLinks, allowedOrigins, allowedAgents, hiddenEdgeKinds]);

  // ── Explicit canvas budget (fit-clamp from residual host) ─────────────────
  // Legend is a canvas OVERLAY — pass legendRows=0 so the world reclaims full height.
  const canvasRowsBudget = budgetMapCanvasRows(stageBox.height, 0, MAP_BASE_CHROME);
  const cols = Math.max(1, stageBox.width - MAP_PANEL_PAD_COLS);
  const rows = Math.max(0, canvasRowsBudget);
  const tooSmall = soft.kind === 'ready' && mapCanvasTooSmall(rows, mode);
  // Timeline reserves the bottom canvas row as the axis strip.
  const bodyRows = mapCanvasBodyRows(rows, mode);
  const bodyHeight = Math.max(0, bodyRows * 4);
  const width = cols * 2;
  const hasAxis = mode === 'density' && rows >= minMapCanvasRows('density');
  const fitPad = mapFitPadding(bodyHeight, width);
  // Overlay clamp: never paint past the canvas; leave axis strip free in timeline.
  const legendDrawn = showLegend
    ? clampMapLegendEntries(legend, rows, { reserveAxis: hasAxis })
    : [];
  const legendDrawnCount = legendDrawn.length;

  // Structure-invalidating mode change → reset viewport (GraphView pattern).
  const lastMode = useRef(mode);
  if (lastMode.current !== mode) {
    lastMode.current = mode;
    if (viewport) setViewport(null);
  }

  // Population filter change → re-fit so void does not return when a mass appears/disappears.
  const filterSig = `${[...allowedOrigins].sort().join(',')}|${[...allowedAgents].sort().join(',')}`;
  const lastFilterSig = useRef(filterSig);
  if (lastFilterSig.current !== filterSig) {
    lastFilterSig.current = filterSig;
    if (viewport) setViewport(null);
  }

  // Host size change → re-fit (tight↔operator profile, nest residual).
  const hostSig = `${stageBox.width}x${stageBox.height}|${rows}x${cols}`;
  const lastHostSig = useRef(hostSig);
  if (lastHostSig.current !== hostSig) {
    lastHostSig.current = hostSig;
    if (viewport) setViewport(null);
  }

  // Re-seed selection when soft state becomes ready and initialSelected is set.
  useEffect(() => {
    if (soft.kind === 'ready' && initialSelected) {
      const ok = soft.sessions.some((s) => s.id === initialSelected);
      if (ok) setSelected(initialSelected);
    }
  }, [soft, initialSelected]);

  // Drop selection if the selected session left the population filter.
  useEffect(() => {
    if (!selected || !sessionWorld) return;
    if (!sessionWorld.nodes.some((n) => n.id === selected)) {
      setSelected(null);
    }
  }, [selected, sessionWorld]);

  const vp = useMemo(
    () =>
      viewport ??
      (bodyHeight > 0 && width > 0
        ? fitViewport(worldNodes, width, bodyHeight, fitPad)
        : { cx: 0, cy: 0, scale: 1 }),
    [viewport, worldNodes, width, bodyHeight, fitPad],
  );
  const fitScale = useMemo(
    () =>
      bodyHeight > 0 && width > 0
        ? fitViewport(worldNodes, width, bodyHeight, fitPad).scale
        : 1,
    [worldNodes, width, bodyHeight, fitPad],
  );
  const zoomFactor = fitScale > 0 ? vp.scale / fitScale : 1;

  const neighbors = useMemo(
    () =>
      sessionWorld
        ? neighborhoodIds(selected, sessionWorld, evidenceLinks)
        : new Set<string>(),
    [selected, sessionWorld, evidenceLinks],
  );

  // Focus for dimming: selection (or hover without neighborhood) via existing FocusState.
  // Hover alone does NOT enter focus (keeps zoom-tier labels + avoids mystery selection ring);
  // selection still labels the neighborhood.
  const focus = useMemo<FocusState | undefined>(() => {
    if (selected) {
      return { selected, neighbors };
    }
    return undefined;
  }, [selected, neighbors]);

  const { grid, nodes: screenNodes } = useMemo(() => {
    // Empty grid when the host cannot hold a paintable canvas — caller shows soft too-small.
    if (tooSmall || bodyRows <= 0 || cols <= 0) {
      return {
        grid: { cols: Math.max(1, cols), rows: Math.max(1, rows), cells: [] as (Cell | null)[] },
        nodes: [] as { id: string; x: number; y: number }[],
      };
    }
    const result = renderView(
      graph,
      worldNodes,
      vp,
      {
        cols,
        rows: bodyRows,
        mode: 'cluster',
        attention: true,
        // Volume-halo uses hub size from volume-mapped linkCount; exclusive with error overlay.
        emphasizeHubs: lightness === 'volume',
      },
      focus,
    );

    // Faint shared_artifact edges under glyphs (EDGE_FAINT).
    // Never overwrite a node glyph — only empty cells or other edge braille.
    if (faintLinks.length > 0 && sessionWorld) {
      const byId = new Map(worldNodes.map((n) => [n.id, n]));
      const canvas = new BrailleCanvas(width, bodyHeight);
      for (const l of faintLinks) {
        const a = byId.get(l.source);
        const b = byId.get(l.target);
        if (!a || !b) continue;
        // Both endpoints already co-visible (selectDrawnLinks); double-check.
        if (!visibleNodeIds.has(l.source) || !visibleNodeIds.has(l.target)) continue;
        const sa = worldToScreen(a, vp, width, bodyHeight);
        const sb = worldToScreen(b, vp, width, bodyHeight);
        canvas.line(sa.x, sa.y, sb.x, sb.y);
      }
      for (let cy = 0; cy < bodyRows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const mask = canvas.cellAt(cx, cy);
          if (mask === 0) continue;
          const idx = cy * cols + cx;
          const existing = result.grid.cells[idx];
          // Links never overwrite node glyphs (●◇◉ etc.) — only empty / edge braille.
          const isNodeGlyph =
            existing &&
            existing.char !== ' ' &&
            !(existing.char >= '⠀' && existing.char <= '⣿') &&
            existing.char !== '░';
          if (isNodeGlyph) continue;
          if (
            !existing ||
            (existing.char >= '⠀' && existing.char <= '⣿' && existing.fg.r <= EDGE_FAINT.r + 40)
          ) {
            result.grid.cells[idx] = {
              char: String.fromCodePoint(0x2800 + mask),
              fg: EDGE_FAINT,
            };
          }
        }
      }
    }

    // ── Node paint priority (collision contract) ────────────────────────────
    // Links already painted. Re-resolve node cells so rare classes win over
    // dense ones: selected > hovered > operator > subagent > harness > experiment.
    // A cell that holds any node glyph is never left as link texture.
    if (sessionWorld && bodyRows > 0) {
      const byId = new Map(sessionWorld.nodes.map((n) => [n.id, n]));
      const candidates: MapPaintCandidate[] = [];
      for (const sn of result.nodes) {
        const wn = byId.get(sn.id);
        if (!wn) continue;
        const cx = Math.floor(sn.x / 2);
        const cy = Math.floor(sn.y / 4);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= bodyRows) continue;
        const isSel = selected === sn.id;
        const isHov = !selected && hovered === sn.id;
        const hue = clusterColor(wn.cluster);
        let fg = hue;
        if (lightness === 'error') {
          const density = annotationMap[sn.id]?.errorDensity ?? 0;
          fg = attentionShade(hue, errorDensityTier(density));
        }
        let glyph = nodeGlyph(wn.agent === 'subagent' ? 'other' : 'knowledge');
        if (isSel) {
          glyph = '◉';
          fg = { r: 240, g: 244, b: 250 };
        }
        candidates.push({
          id: sn.id,
          cx,
          cy,
          origin: wn.origin,
          agent: wn.agent,
          glyph,
          fg,
          selected: isSel,
          hovered: isHov,
        });
      }
      const winners = resolveMapCellWinners(candidates, { cols, rows: bodyRows });
      for (const w of winners) {
        const idx = w.cy * cols + w.cx;
        result.grid.cells[idx] = { char: w.glyph, fg: w.fg };
      }
    }

    // Error-density lightness: re-shade glyph cells via attention machinery.
    if (lightness === 'error' && sessionWorld) {
      const nodeById = new Map(sessionWorld.nodes.map((n) => [n.id, n]));
      for (const sn of result.nodes) {
        const cx = Math.floor(sn.x / 2);
        const cy = Math.floor(sn.y / 4);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= bodyRows) continue;
        const idx = cy * cols + cx;
        const cell = result.grid.cells[idx];
        if (!cell) continue;
        // Leave the selection ring alone.
        if (selected && sn.id === selected) continue;
        const wn = nodeById.get(sn.id);
        if (!wn) continue;
        const density = annotationMap[sn.id]?.errorDensity ?? 0;
        const tier = errorDensityTier(density);
        const hue = clusterColor(wn.cluster);
        const shaded = attentionShade(hue, tier);
        result.grid.cells[idx] = { ...cell, fg: shaded };
      }
    }

    // Zoom-tier labels (top-K by turns) when sufficiently zoomed and no selection focus labels.
    if (zoomFactor >= ZOOM_TIER_MIN && sessionWorld && !selected) {
      const nodeById = new Map(sessionWorld.nodes.map((n) => [n.id, n]));
      const occupied = new Set<number>();
      for (let i = 0; i < result.grid.cells.length; i++) {
        const c = result.grid.cells[i];
        if (c && c.char && c.char !== ' ') occupied.add(i);
      }
      const candidates = result.nodes.map((sn) => {
        const wn = nodeById.get(sn.id);
        return {
          id: sn.id,
          turnCount: wn?.turnCount ?? 0,
          label: wn?.label ?? sn.id,
          cx: Math.floor(sn.x / 2),
          cy: Math.floor(sn.y / 4),
        };
      });
      const placements = selectZoomTierLabels(candidates, {
        cols,
        rows: bodyRows,
        occupied,
      });
      for (const p of placements) {
        const text = ` ${p.text}`;
        const baseIdx = p.cy * cols + (p.cx - 1); // glyph cell
        const glyphCell = result.grid.cells[baseIdx];
        const fg = glyphCell?.fg ?? AXIS_CHROME;
        for (let i = 0; i < text.length; i++) {
          const lx = p.cx + i;
          if (lx < 0 || lx >= cols) break;
          const idx = p.cy * cols + lx;
          result.grid.cells[idx] = { char: text[i]!, fg };
        }
      }
    }

    // Expand grid to full canvas rows so the axis strip is addressable.
    if (hasAxis && bodyRows < rows) {
      const full: (Cell | null)[] = new Array(cols * rows).fill(null);
      for (let cy = 0; cy < bodyRows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          full[cy * cols + cx] = result.grid.cells[cy * cols + cx] ?? null;
        }
      }
      const axis = layoutAxisStrip(
        sessionWorld?.nodes ?? [],
        vp,
        cols,
        bodyRows,
      );
      const axisY = rows - 1;
      // Light baseline (only interior cells) so panel side borders stay untouched.
      for (let cx = 1; cx < cols - 1; cx++) {
        full[axisY * cols + cx] = { char: '─', fg: AXIS_CHROME };
      }
      for (const tick of axis.ticks) {
        if (tick.cellX < 0 || tick.cellX >= cols) continue;
        // Tick mark
        full[axisY * cols + tick.cellX] = { char: '│', fg: AXIS_CHROME };
        // Label to the right of the tick when space allows
        const label = tick.label;
        for (let i = 0; i < label.length; i++) {
          const lx = tick.cellX + 1 + i;
          if (lx <= 0 || lx >= cols - 1) break;
          // Stop if we would overwrite the next tick column
          const nextTick = axis.ticks.find((t) => t.cellX > tick.cellX);
          if (nextTick && lx >= nextTick.cellX) break;
          full[axisY * cols + lx] = { char: label[i]!, fg: AXIS_CHROME };
        }
      }
      result.grid.rows = rows;
      result.grid.cells = full;
    } else if (result.grid.rows !== rows || result.grid.cols !== cols) {
      // Ensure full canvas grid size when no axis expansion path ran.
      const full: (Cell | null)[] = new Array(cols * Math.max(1, rows)).fill(null);
      const gr = result.grid.rows;
      const gc = result.grid.cols;
      for (let cy = 0; cy < Math.min(gr, rows); cy++) {
        for (let cx = 0; cx < Math.min(gc, cols); cx++) {
          full[cy * cols + cx] = result.grid.cells[cy * gc + cx] ?? null;
        }
      }
      result.grid.rows = Math.max(1, rows);
      result.grid.cols = cols;
      result.grid.cells = full;
    }

    // Legend overlay (top-right) — after world + axis so it paints on top; clamped
    // away from the axis strip. Zero layout rows; draw/hit share clamp geometry.
    if (legendDrawnCount > 0) {
      paintMapLegendOntoGrid(
        result.grid.cells,
        result.grid.cols,
        legendDrawn,
        cols,
        legendDrawnCount,
      );
    }

    return result;
  }, [
    graph,
    worldNodes,
    vp,
    cols,
    bodyRows,
    rows,
    focus,
    lightness,
    faintLinks,
    sessionWorld,
    annotationMap,
    selected,
    zoomFactor,
    hasAxis,
    width,
    bodyHeight,
    tooSmall,
    legendDrawn,
    legendDrawnCount,
    hovered,
    visibleNodeIds,
  ]);

  const gridRef = useRef(grid);
  gridRef.current = grid;
  /**
   * Screen origin of the canvas element at last paint — the single number both
   * blit and every mouse path share (via eventToCanvasCell).
   */
  const canvasOriginRef = useRef<MapCanvasOrigin>({ x: 0, y: 0 });

  // Keep-mounted stages load while parent height is 0; when the stage becomes
  // active (or the residual host settles), bump paintGen so renderAfter rebinds.
  const [paintGen, setPaintGen] = useState(0);
  useEffect(() => {
    if (!inputActive || rows <= 0 || soft.kind !== 'ready') return;
    setPaintGen((g) => g + 1);
    const t = setTimeout(() => setPaintGen((g) => g + 1), 80);
    return () => clearTimeout(t);
  }, [inputActive, rows, cols, soft.kind, stageBox.width, stageBox.height]);

  /**
   * Canvas blit. OpenTUI setCell is screen-absolute on the root buffer; paint the
   * local grid at the element's `_screenX/_screenY` and STASH that origin so
   * mouse handlers convert event coords with the same numbers.
   */
  const draw = useCallback(
    function mapDraw(
      this: { _screenX?: number; _screenY?: number },
      buffer: DrawBuffer,
    ) {
      if (rows <= 0 || cols <= 0) return;
      const ox = Math.max(0, Math.floor(this?._screenX ?? 0));
      const oy = Math.max(0, Math.floor(this?._screenY ?? 0));
      canvasOriginRef.current = { x: ox, y: oy };
      blitGrid(buffer, gridRef.current, ox, oy, cols, rows);
    } as (buffer: DrawBuffer) => void,
    [cols, rows, grid, paintGen, inputActive],
  );

  /** Event (screen cells) → canvas-local cell via the last paint origin. */
  const toCell = useCallback((e: MouseLike) => {
    return eventToCanvasCell(e, canvasOriginRef.current);
  }, []);

  /** Event → canvas sub-pixel center for pan/zoom anchors. */
  const toSub = useCallback((e: MouseLike) => {
    return eventToCanvasSubpixel(e, canvasOriginRef.current);
  }, []);

  const hitTest = useCallback(
    (cellX: number, cellY: number): string | null => {
      // Axis strip is not a hit target.
      if (hasAxis && cellY >= bodyRows) return null;
      if (cellX < 0 || cellY < 0 || cellX >= cols || cellY >= rows) return null;
      return hitTestSession(screenNodes, cellX, cellY);
    },
    [screenNodes, hasAxis, bodyRows, cols, rows],
  );

  /** Overlay hit — same geometry as paintMapLegendOntoGrid (clamped drawn rows). */
  const legendHit = useCallback(
    (cellX: number, cellY: number) => {
      if (!showLegend || legendDrawnCount <= 0) return null;
      return mapLegendHitAt(legendDrawn, cols, legendDrawnCount, cellX, cellY);
    },
    [showLegend, legendDrawn, legendDrawnCount, cols],
  );

  const toggleLegendKey = useCallback((label: string) => {
    const target = legendToggleTarget(label);
    if (!target) return;
    if (target.kind === 'edge') {
      setHiddenEdgeKinds((prev) => {
        const next = new Set(prev);
        if (next.has(target.key)) next.delete(target.key);
        else next.add(target.key);
        return next;
      });
      return;
    }
    if (target.kind === 'origin') {
      setAllowedOrigins((prev) => {
        const next = new Set(prev);
        if (next.has(target.key)) {
          // Keep at least one origin so the canvas is never a silent void of all filters off.
          if (next.size > 1) next.delete(target.key);
        } else {
          next.add(target.key);
        }
        return next;
      });
      return;
    }
    if (target.kind === 'agent') {
      setAllowedAgents((prev) => {
        const next = new Set(prev);
        if (next.has(target.key)) {
          if (next.size > 1) next.delete(target.key);
        } else {
          next.add(target.key);
        }
        return next;
      });
    }
  }, []);

  const openSelected = useCallback(
    (id: string | null) => {
      if (!id) return;
      const row = sessions?.find((s) => s.id === id);
      onOpenSession?.(id, { ts: row?.startedAt });
      const label = row ? (row.title?.trim() || id.slice(-8)) : id.slice(-8);
      onFlashRef.current?.(`open session ${label}`);
    },
    [sessions, onOpenSession],
  );

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
      // Esc cascade: clear selection/neighborhood (no house-focus stack).
      if (selected) setSelected(null);
      return;
    }
    if (n === 'd') {
      setMode((m) => (m === 'cluster' ? 'density' : 'cluster'));
      return;
    }
    if (n === 'e') {
      // Exclusive lightness channel: volume-halo ↔ error-density.
      setLightness((m) => (m === 'volume' ? 'error' : 'volume'));
      return;
    }
    if (n === 'l') {
      // Graph-view convention: toggle legend overlay (default ON).
      setShowLegend((s) => !s);
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
      const s = toSub(e);
      dragRef.current = {
        anchorWorld: screenToWorld(s, vp, width, bodyHeight),
        scale: vp.scale,
        startX: e.x,
        startY: e.y,
        moved: false,
      };
    },
    [vp, width, bodyHeight, toSub],
  );

  const onMouseDrag = useCallback(
    (e: MouseLike) => {
      const d = dragRef.current;
      if (!d) return;
      if (e.x !== d.startX || e.y !== d.startY) d.moved = true;
      const s = toSub(e);
      setViewport(anchorViewport(d.anchorWorld, d.scale, s.x, s.y, width, bodyHeight));
    },
    [width, bodyHeight, toSub],
  );

  const onMouseUp = useCallback(
    (e: MouseLike) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d && !d.moved && (e.button ?? 0) === 0) {
        // ONE transform: screen event → canvas cell (same origin as blit).
        const { cellX, cellY } = toCell(e);
        // Legend overlay first (shared geometry with draw) — then world hit-test.
        const leg = legendHit(cellX, cellY);
        if (leg) {
          toggleLegendKey(leg.label);
          return;
        }
        const hit = hitTest(cellX, cellY);
        if (hit && hit === selected) openSelected(hit);
        else setSelected(hit);
      }
    },
    [toCell, legendHit, toggleLegendKey, hitTest, selected, openSelected],
  );

  const onMouseMove = useCallback(
    (e: MouseLike) => {
      if (dragRef.current) return;
      const { cellX, cellY } = toCell(e);
      const hit = hitTest(cellX, cellY);
      setHovered((h) => (h === hit ? h : hit));
    },
    [toCell, hitTest],
  );

  const onMouseScroll = useCallback(
    (e: MouseLike) => {
      let dir = e.scroll?.direction;
      if (!dir && typeof e.scroll?.deltaY === 'number') dir = e.scroll.deltaY < 0 ? 'up' : 'down';
      if (!dir && e.button === 4) dir = 'up';
      if (!dir && e.button === 5) dir = 'down';
      if (!dir) return;
      const s = toSub(e);
      setViewport(zoomViewportAt(vp, dir === 'up' ? 1.2 : 1 / 1.2, s.x, s.y, width, bodyHeight));
    },
    [vp, width, bodyHeight, toSub],
  );

  const rowW = Math.max(16, stageBox.width - MAP_PANEL_PAD_COLS);
  const selNode = selected ? sessionWorld?.nodes.find((n) => n.id === selected) : undefined;
  const hoverNode =
    !selected && hovered ? sessionWorld?.nodes.find((n) => n.id === hovered) : undefined;
  const showing = sessionWorld?.nodes.length ?? 0;
  const drawnLinkCount = drawnLinks.length;
  const modeLabel = modeStatusLabel(mode);
  const filterLabel = filtersShortLabel(allowedOrigins, allowedAgents);
  const linksStatus = formatLinksStatus(drawnLinkCount, loadedLinkCount);
  const lightnessLabel = lightnessStatusLabel(lightness);

  // Honest status: never claim "showing N" when the canvas cannot paint.
  const headerRight = tooSmall
    ? `too small · ${modeLabel}`
    : soft.kind === 'ready'
      ? `${showing}/${totalSessions} · ${modeLabel}`
      : soft.kind === 'loading'
        ? 'loading'
        : soft.kind;

  const infoLine = tooSmall
    ? ` terminal too small for map canvas (need ≥${minMapCanvasRows(mode)} rows; have ${rows})`
    : soft.kind === 'ready'
      ? ` showing ${showing} of ${totalSessions} · ${linksStatus} · ${modeLabel} · ${filterLabel} · ${zoomFactor.toFixed(1)}× zoom` +
        (selNode
          ? `   ${formatSelectionReadout(selNode)}`
          : hoverNode
            ? `   ${formatHoverReadout(hoverNode)}`
            : '')
      : ` ${softCopy(soft).title}`;

  const controlLine = tooSmall
    ? ' enlarge the terminal · r reload'
    : soft.kind === 'ready'
      ? ` drag pan · scroll zoom · click select · click legend = toggle · click·click / ⏎ open · [d] timeline/structure · [e] ${lightnessLabel} · [l]egend · [f]it [c]enter [r]eload`
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

  /** Canvas body: glyphs, or a short honest "too small" stack (never blank under showing-N). */
  const canvasBody = tooSmall ? (
    <box
      height={Math.max(1, rows)}
      width="100%"
      flexShrink={0}
      overflow="hidden"
      flexDirection="column"
      backgroundColor={GRAPH_BG}
    >
      <FixedClearRow
        width={rowW}
        color={t.muted}
        text={padRow('Map canvas needs more vertical space.', rowW)}
      />
      {rows >= 2 ? (
        <FixedClearRow
          width={rowW}
          color={t.muted}
          text={padRow(
            `host ${stageBox.height} · chrome ${MAP_BASE_CHROME} → canvas ${rows} (min ${minMapCanvasRows(mode)})`,
            rowW,
          )}
        />
      ) : null}
    </box>
  ) : inputActive ? (
    <box
      // Only mount the blit surface while the stage is active. Keep-mounted
      // parents are height 0 when hidden; a blit bound then never recovers on
      // some OpenTUI paths (blank canvas under showing-N at tight profiles).
      key={`map-canvas-${paintGen}-${rows}x${cols}`}
      height={Math.max(1, rows)}
      width={cols}
      flexShrink={0}
      flexGrow={0}
      overflow="hidden"
      backgroundColor={GRAPH_BG}
      renderAfter={draw}
      onMouseDown={onMouseDown}
      onMouseDrag={onMouseDrag}
      onMouseUp={onMouseUp}
      onMouseMove={onMouseMove}
      onMouseScroll={onMouseScroll}
    />
  ) : (
    <box height={Math.max(1, rows)} width={cols} flexShrink={0} backgroundColor={GRAPH_BG} />
  );

  return (
    <Panel title="Map" headerRight={headerRight} flexGrow={1} minHeight={0} active={!!inputActive}>
      {softBody ?? (
        <box flexDirection="column" flexGrow={1} width="100%" minHeight={0} overflow="hidden">
          {/*
            Canvas reclaims full residual height; legend is an overlay inside the blit
            (top-right), not a flex block under the world.
          */}
          {canvasBody}
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
