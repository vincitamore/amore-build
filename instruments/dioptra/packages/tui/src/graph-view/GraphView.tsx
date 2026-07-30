import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { RGBA } from '@opentui/core';
import { axisKeyOf, layoutWorld, renderView, DEFAULT_GRAPH_CONFIG, type FocusState, type GraphConfig, type GraphData, type LayoutMode, type WorldNode } from '../render/graph';
import { transientOrphans } from '../render/orphans';
import { dlog } from '../debug';
import { clampHops, focusSubset } from '../render/focus';
import type { EdgeFamily, SemanticLink } from '../render/overlay';
import { hiddenSubKey, subKeyOf } from '../render/subkey';
import { GraphConfigModal } from './GraphConfigModal';
import { NodeSearchModal } from './NodeSearchModal';

// Memoized so it only re-renders when its OWN props change (active/mode/config) — NOT on every
// graph hover/zoom (GraphView re-render). A modal that churns while mounted-hidden is what makes its
// open-time `visible` toggle hit OpenTUI's UAF; keeping it quiet makes the open a clean mutation.
const MConfigModal = memo(GraphConfigModal);
// Same discipline for the search overlay: memoized on its props (active/nodes/handlers), all of which
// are stable across a hover/zoom, so it never re-renders while hidden.
const MNodeSearchModal = memo(NodeSearchModal);
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
import { blitGrid, buildFamilyLegendRows, buildTypeLegendRows, drawLegend, drawFamilyLegend, legendHitAt, GRAPH_BG, type DrawBuffer, type LegendEntry, type LegendHit } from './blit';

const STATUS_BG = RGBA.fromInts(30, 34, 42);
const STATUS_FG = RGBA.fromInts(205, 211, 220);
const STATUS_DIM = RGBA.fromInts(120, 128, 140); // controls line — quieter than the info line
const HOVER_ZOOM_FACTOR = 2.5; // hover-peek enables once zoomed in ≥ this × the fit-zoom (mode-independent)
const HALO_OVER_EDGES_ZOOM = 1.8; // past this zoom, hub halos overwrite the edge web so they stay visible
const EMPTY_ORPHANS: Set<string> = new Set(); // stable empty set for the `orphans: 'all'` case (no per-render alloc)

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

/**
 * Interactive knowledge-graph view. Layout (`world`) is computed by the parent and passed in.
 * `chromeTop` is the number of screen rows consumed above this view (e.g. a shell member bar),
 * so the blit + mouse coords are offset correctly when embedded in the dashboard shell.
 */
export function GraphView({
  graph,
  world,
  semanticLinks = [],
  mode,
  layingOut = false,
  neutralCluster = -1,
  config = DEFAULT_GRAPH_CONFIG,
  onCycleMode,
  onSetMode,
  onConfigChange,
  onReload,
  onQuit,
  onOpen,
  initialSelected,
  chromeTop = 0,
  inputActive = true,
  onCapture,
}: {
  graph: GraphData;
  world: WorldNode[];
  /** Typed semantic edges (from `/api/graph?edges=semantic`) for the render-only overlay. */
  semanticLinks?: SemanticLink[];
  mode: LayoutMode;
  /** A relayout is computing (the PRIOR world is still rendered) — shown in the status line. */
  layingOut?: boolean;
  /** The community "misc" cluster index (rendered gray); -1 when none. */
  neutralCluster?: number;
  /** Render/config options (the config modal). Defaults so standalone demos need not pass it. */
  config?: GraphConfig;
  onCycleMode: () => void;
  /** Set the layout mode directly (config modal); re-lays out. */
  onSetMode?: (m: LayoutMode) => void;
  /** Patch the render/config options (config modal). */
  onConfigChange?: (patch: Partial<GraphConfig>) => void;
  /** Re-fetch the graph (`r`) so node status/attention reflect the live tree. */
  onReload?: () => void;
  onQuit?: () => void;
  /** Open the selected node's document (Enter / double-click). The node id is its path. */
  onOpen?: (path: string) => void;
  initialSelected?: string;
  chromeTop?: number;
  /** When false, the view ignores keyboard input (e.g. while a shell overlay owns it). */
  inputActive?: boolean;
  /** Report input-capture: true while the search overlay owns the keyboard (the shell suppresses its
   *  own plain-char hotkeys while a member captures), false when it releases. */
  onCapture?: (c: boolean) => void;
}) {
  const dims = useTerminalDimensions();
  const cols = Math.max(1, dims.width);
  const rows = Math.max(1, dims.height - 2 - chromeTop); // minus our 2-row status bar + chrome above
  const width = cols * 2;
  const height = rows * 4;

  const [viewport, setViewport] = useState<Viewport | null>(null);
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [showLegend, setShowLegend] = useState(true);
  const [configOpen, setConfigOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(() => new Set());
  const [hiddenFamilies, setHiddenFamilies] = useState<Set<EdgeFamily>>(() => new Set());
  // Hierarchical drill-down state (session-only, GraphView-local like the sets above). `hiddenSubs`
  // keys are `hiddenSubKey(type, sub)`; `hiddenRelations` keys are plain relation names (globally
  // unique). `expanded*` only controls which sub rows the legend inserts — pure render-time, never
  // layout: none of these enter graphSignature or a layout effect.
  const [hiddenSubs, setHiddenSubs] = useState<Set<string>>(() => new Set());
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(() => new Set());
  const [hiddenRelations, setHiddenRelations] = useState<Set<string>>(() => new Set());
  const [expandedFamilies, setExpandedFamilies] = useState<Set<EdgeFamily>>(() => new Set());

  // ── Focus / neighborhood mode ────────────────────────────────────────────────────────────────
  // `n` on a selected node enters FOCUS MODE: only the N-hop neighborhood of the seed is laid out +
  // rendered (everything else excluded from draw/hit-test/selection). `focusSeed` is the seed id (null
  // = not focused); the hop radius N is the `focusHops` config knob (1..3, default 2). The subgraph
  // layout is computed LOCALLY here (a mode switch is a legitimate reflow) — the full-graph layout the
  // shell owns is never touched, so exiting restores it exactly.
  const [focusSeed, setFocusSeed] = useState<string | null>(null);
  const focused = focusSeed !== null;
  const hops = clampHops(config.focusHops);
  // Focus-mode overlay override: null = use the focus default (ON — typed edges are part of the
  // focused view); a boolean = the user's explicit choice this session (they toggled Typed edges in
  // the config modal while focused, which must win). Reset to null on every focus enter/exit.
  const [focusOverlay, setFocusOverlay] = useState<boolean | null>(null);
  const overlayOn = focused ? focusOverlay ?? true : config.typedEdges === 'on';
  // Detect a user toggle of Typed edges (config.typedEdges changes) WHILE focused → record it as the
  // explicit override so it beats the focus default. Skip the mount fire; read `focused` from a ref so
  // the effect keys ONLY on config.typedEdges (a focus enter must not be read as a toggle).
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const typedInit = useRef(true);
  useEffect(() => {
    if (typedInit.current) {
      typedInit.current = false;
      return;
    }
    if (focusedRef.current) setFocusOverlay(config.typedEdges === 'on');
  }, [config.typedEdges]);
  const enterFocus = (seed: string) => {
    dlog('graph', `focus enter seed=${seed}`);
    setFocusSeed(seed);
    setSelected(seed); // seed stays selected on enter
    setFocusOverlay(null); // → focus default (overlay on)
  };
  const exitFocus = () => {
    dlog('graph', 'focus exit');
    setFocusSeed(null);
    setFocusOverlay(null);
  };

  // The focused subgraph + its own force layout, or null when not focused. The neighborhood spans BOTH
  // wiki and typed edges (the overlay is part of the focused view) — the scope is fixed here, NOT keyed
  // on the overlay draw toggle, so flipping the overlay within focus mode stays render-only (no reflow),
  // per the no-reflow-within-a-mode doctrine; a typed-edge-only neighbor stays a member even if its edge
  // isn't drawn. The layout is synchronous (the neighborhood is bounded by N≤3 hops — small); a large
  // 3-hop hub neighborhood caps its iterations so a heavy hub doesn't jank the render.
  const focusView = useMemo(() => {
    if (focusSeed === null) return null;
    const subset = focusSubset(graph, semanticLinks, focusSeed, hops, true);
    const iterations = subset.nodes.length > 400 ? 150 : 300;
    const layout = layoutWorld({ nodes: subset.nodes, links: subset.links }, { mode, statusForce: config.statusForce, iterations });
    return {
      graph: { nodes: subset.nodes, links: subset.links } as GraphData,
      world: layout.nodes,
      neutralCluster: layout.neutralCluster,
      semanticLinks: subset.semanticLinks,
    };
  }, [focusSeed, hops, graph, semanticLinks, mode, config.statusForce]);

  // Effective view: the focused subgraph when focused, else the full graph/world/overlay from props.
  // Everything downstream (adjacency, legend, renderView, hit-test, status) reads these, so focus mode
  // is a clean swap of the render inputs — no branching in the draw path.
  const viewGraph = focusView ? focusView.graph : graph;
  const viewWorld = focusView ? focusView.world : world;
  const viewSemantic = focusView ? focusView.semanticLinks : semanticLinks;
  const viewNeutral = focusView ? focusView.neutralCluster : neutralCluster;

  // Transient-orphan filter (render-only): the zero-link nodes under archive/dream/handle/completed
  // paths to hide when `orphans: 'hide-transient'` (default). Memoized on the graph so the one set
  // feeds the render gate, the selection guard, and the status count. `all` → the stable empty set
  // (every orphan shown). Layout + graphSignature never see it, so toggling never reflows. DISABLED in
  // focus mode: the neighborhood is already a curated connected subset (its nodes have links by
  // construction), and the filter would wrongly hide a disconnected seed.
  const transientHidden = useMemo(() => transientOrphans(graph), [graph]);
  const orphansHidden = !focused && config.orphans === 'hide-transient' ? transientHidden : EMPTY_ORPHANS;
  const hiddenOrphanCount = orphansHidden.size;
  const dragRef = useRef<DragState | null>(null);
  // Reset pan/zoom when the layout MODE changes — each mode's world coordinates span a different
  // range (force ~±150, radial ~±400), so a viewport panned in one mode frames empty space in
  // another. Null → auto-fit whichever world is current (render-time reset, no flash frame).
  const lastMode = useRef(mode);
  if (lastMode.current !== mode) {
    lastMode.current = mode;
    if (viewport) setViewport(null);
  }
  // Reset pan/zoom when focus mode is entered/exited — the subgraph world spans a different range than
  // the full graph, so a viewport framed in one would frame empty space in the other. Same render-time
  // reset as the mode change; null → auto-fit whichever world is current.
  const lastFocus = useRef(focusSeed);
  if (lastFocus.current !== focusSeed) {
    lastFocus.current = focusSeed;
    if (viewport) setViewport(null);
  }
  const toggleType = useCallback((ty: string) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(ty)) next.delete(ty);
      else next.add(ty);
      return next;
    });
  }, []);
  const toggleFamily = useCallback((f: EdgeFamily) => {
    setHiddenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }, []);
  // Drill-down toggles. Sub visibility keys on `type+sub`; relation visibility on the (unique) relation
  // name. Expand/collapse are separate from visibility — a sub row can be toggled while its parent is
  // expanded, and collapsing a parent hides its sub rows without changing what's hidden.
  const toggleSub = useCallback((type: string, sub: string) => {
    const key = hiddenSubKey(type, sub);
    setHiddenSubs((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleTypeExpand = useCallback((type: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);
  const toggleRelation = useCallback((rel: string) => {
    setHiddenRelations((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);
  const toggleFamilyExpand = useCallback((f: EdgeFamily) => {
    setExpandedFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }, []);
  // Stable handlers for the (memoized) config modal — so it never re-renders on a graph hover/zoom.
  const closeConfig = useCallback(() => setConfigOpen(false), []);
  const modalSetMode = useCallback((m: LayoutMode) => onSetMode?.(m), [onSetMode]);
  const modalChange = useCallback((patch: Partial<GraphConfig>) => onConfigChange?.(patch), [onConfigChange]);

  // Stable handlers for the (memoized) search overlay — same discipline. Both close paths release the
  // shell's input capture. `pickSearch` seeds focus mode on the chosen node: it first un-hides the
  // node's type / subcategory if a legend toggle is currently hiding it (so the seed is visible in the
  // subgraph), then selects + enters focus (which auto-fits the viewport). The focus-enter is inlined
  // rather than calling `enterFocus` so this handler depends only on the (stable) graph + setters.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    onCapture?.(false);
  }, [onCapture]);
  const pickSearch = useCallback(
    (id: string) => {
      setSearchOpen(false);
      onCapture?.(false);
      const nd = graph.nodes.find((nn) => nn.id === id);
      const ty = nd?.type ?? 'other';
      const sub = nd ? subKeyOf(nd) : null;
      setHiddenTypes((prev) => {
        if (!prev.has(ty)) return prev;
        const next = new Set(prev);
        next.delete(ty);
        return next;
      });
      if (sub !== null) {
        const k = hiddenSubKey(ty, sub);
        setHiddenSubs((prev) => {
          if (!prev.has(k)) return prev;
          const next = new Set(prev);
          next.delete(k);
          return next;
        });
      }
      setSelected(id);
      dlog('graph', `search focus seed=${id}`);
      setFocusSeed(id);
      setFocusOverlay(null); // → focus default (overlay on)
    },
    [graph, onCapture]
  );
  // If input focus leaves this member (member switch, a global shell overlay) while the search is
  // open, close it and release capture — a hidden-but-open overlay would otherwise hold the shell's
  // hotkey suppression.
  useEffect(() => {
    if (!inputActive && searchOpen) {
      setSearchOpen(false);
      onCapture?.(false);
    }
  }, [inputActive, searchOpen, onCapture]);

  // Selection guard: clear the selection when the selected node just became hidden — a hidden node is
  // neither positioned nor hit-testable, so a stale selection points at nothing on screen (and Enter
  // would still try to open it). Hide paths: the orphan filter toggling on while an orphan is selected,
  // hiding the selected node's TYPE, or hiding its SUBcategory via the drill-down.
  useEffect(() => {
    if (!selected) return;
    const nd = viewGraph.nodes.find((n) => n.id === selected);
    const ty = nd?.type ?? 'other';
    const sub = nd ? subKeyOf(nd) : null;
    const subHidden = sub !== null && hiddenSubs.has(hiddenSubKey(ty, sub));
    if (orphansHidden.has(selected) || hiddenTypes.has(ty) || subHidden) setSelected(null);
  }, [selected, orphansHidden, hiddenTypes, hiddenSubs, viewGraph]);

  const adjacency = useMemo(() => {
    const adj = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let s = adj.get(a);
      if (!s) adj.set(a, (s = new Set()));
      s.add(b);
    };
    for (const l of viewGraph.links) {
      add(l.source, l.target);
      add(l.target, l.source);
    }
    return adj;
  }, [viewGraph]);

  // The hierarchical node-TYPE legend (parents + expanded subcategory rows) — a VIEW of the render's
  // own color function: nodes are painted from their laid-out `world.cluster` index, so the legend
  // resolves each type's color through a representative node's world cluster (subs inherit it), never a
  // parallel palette or a re-derived key space. The build is pure (blit.ts) so it's unit-tested.
  const clusterById = useMemo(() => new Map(viewWorld.map((w) => [w.id, w.cluster])), [viewWorld]);
  const legend = useMemo<LegendEntry[]>(
    () => buildTypeLegendRows(viewGraph.nodes, clusterById, viewNeutral, hiddenTypes, hiddenSubs, expandedTypes),
    [viewGraph, clusterById, viewNeutral, hiddenTypes, hiddenSubs, expandedTypes]
  );

  const vp = useMemo(() => viewport ?? fitViewport(viewWorld, width, height), [viewport, viewWorld, width, height]);
  const fitScale = useMemo(() => fitViewport(viewWorld, width, height).scale, [viewWorld, width, height]);
  const zoomFactor = fitScale > 0 ? vp.scale / fitScale : 1;
  // Once zoomed in past this, hub halos overwrite the braille edges (they're otherwise lost under
  // the web) — at that scale the node-size signal matters more than the local edges.
  const haloOverEdges = config.emphasizeHubs && zoomFactor >= HALO_OVER_EDGES_ZOOM;

  const focusId = selected ?? hovered;
  const focus = useMemo<FocusState | undefined>(
    () => (focusId ? { selected: focusId, neighbors: adjacency.get(focusId) ?? new Set() } : undefined),
    [focusId, adjacency]
  );
  const { grid, nodes, typedFamilies, typedVisible } = useMemo(
    () =>
      renderView(
        viewGraph,
        viewWorld,
        vp,
        {
          cols,
          rows,
          mode,
          hiddenTypes,
          hiddenSubs,
          hiddenIds: orphansHidden,
          neutralCluster: viewNeutral,
          attention: config.attention,
          recencyFade: config.recencyFade,
          emphasizeHubs: config.emphasizeHubs,
          haloOverEdges,
          overlay: overlayOn,
          semanticLinks: viewSemantic,
          hiddenFamilies,
          hiddenRelations,
        },
        focus
      ),
    [viewGraph, viewWorld, vp, cols, rows, mode, hiddenTypes, hiddenSubs, orphansHidden, viewNeutral, config.attention, config.recencyFade, config.emphasizeHubs, haloOverEdges, overlayOn, viewSemantic, hiddenFamilies, hiddenRelations, focus]
  );

  // The hierarchical typed-edge FAMILY legend (a VIEW of the render's own family stats — same color
  // function, so swatch and edge can't drift). Parent per family present in the data; an expanded
  // family drills into its individual relations. Pure build (blit.ts), unit-tested.
  const familyLegend = useMemo<LegendEntry[]>(
    () => buildFamilyLegendRows(typedFamilies ?? [], expandedFamilies),
    [typedFamilies, expandedFamilies]
  );

  const gridRef = useRef(grid);
  gridRef.current = grid;
  const draw = useCallback(
    (buffer: DrawBuffer) => {
      blitGrid(buffer, gridRef.current, 0, chromeTop, cols, rows);
      if (showLegend) drawLegend(buffer, legend, cols, rows, chromeTop);
      // The family legend (top-left) only shows while the overlay is on and there are typed edges.
      if (overlayOn && familyLegend.length) drawFamilyLegend(buffer, familyLegend, cols, rows, chromeTop);
    },
    [cols, rows, chromeTop, showLegend, legend, overlayOn, familyLegend]
  );

  /** Nearest node to a graph-local cell, within a small radius; null if empty space. */
  const hitTest = useCallback(
    (cellX: number, cellY: number): string | null => {
      const sx = cellX * 2 + 1;
      const sy = cellY * 4 + 2;
      let best: string | null = null;
      let bestD = Infinity;
      for (const node of nodes) {
        const d = (node.x - sx) ** 2 + (node.y - sy) ** 2;
        if (d < bestD) {
          bestD = d;
          best = node.id;
        }
      }
      return best && bestD <= 36 ? best : null;
    },
    [nodes]
  );

  // Which type-legend action a screen cell maps to (expand a parent, toggle a parent, toggle a sub), or
  // null. Delegates to the shared pure `legendHitAt` that draw uses, so click zones match the paint
  // exactly (top-right block, same row clamp as the draw loop).
  const legendHit = useCallback(
    (ex: number, ey: number): LegendHit | null =>
      showLegend ? legendHitAt(legend, cols, rows, chromeTop, ex, ey, 'right') : null,
    [showLegend, legend, cols, rows, chromeTop]
  );

  // Which family-legend action a screen cell maps to (mirror, top-LEFT block). Same shared geometry.
  const familyLegendHit = useCallback(
    (ex: number, ey: number): LegendHit | null =>
      overlayOn && familyLegend.length > 0 ? legendHitAt(familyLegend, cols, rows, chromeTop, ex, ey, 'left') : null,
    [overlayOn, familyLegend, cols, rows, chromeTop]
  );

  // Screen cell → graph sub-pixel center (accounting for chrome above).
  const sub = useCallback((e: MouseLike) => ({ x: e.x * 2 + 1, y: (e.y - chromeTop) * 4 + 2 }), [chromeTop]);

  // Only doc/file nodes back an openable document; placeholder (unresolved wikilink) and cluster/tag
  // nodes have no file, so opening their id into DocView would 404. Returns the path to open, or null.
  const openTarget = useCallback(
    (id: string): string | null => {
      const nd = viewGraph.nodes.find((n) => n.id === id);
      return nd && (nd.kind === 'doc' || nd.kind === 'file') ? id : null;
    },
    [viewGraph]
  );

  useKeyboard((key: { name?: string; sequence?: string }) => {
    if (!inputActive || configOpen || searchOpen) return; // the config/search overlay owns keys while open
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    const seq = key.sequence ?? '';
    if (n === 'o') return setConfigOpen(true);
    if (n === 's') {
      setSearchOpen(true);
      onCapture?.(true);
      return;
    }
    if (n === 'q') return onQuit?.();
    if ((n === 'return' || n === 'enter') && selected) {
      const p = openTarget(selected);
      return p ? onOpen?.(p) : undefined;
    }
    // `n` toggles focus/neighborhood mode: enter on the selected (or hovered) node, exit if already
    // focused. Esc also exits focus (before its clear-selection / quit behavior).
    if (n === 'n') {
      if (focused) return exitFocus();
      const seed = selected ?? hovered;
      return seed ? enterFocus(seed) : undefined;
    }
    if (n === 'escape') {
      if (focused) return exitFocus();
      return selected ? setSelected(null) : onQuit?.();
    }
    if (n === 'left') setViewport(panViewport(vp, -3, 0));
    else if (n === 'right') setViewport(panViewport(vp, 3, 0));
    else if (n === 'up') setViewport(panViewport(vp, 0, -2));
    else if (n === 'down') setViewport(panViewport(vp, 0, 2));
    else if (n === '=' || n === '+' || seq === '+' || seq === '=') setViewport(zoomViewport(vp, 1.25));
    else if (n === '-' || n === '_' || seq === '-') setViewport(zoomViewport(vp, 0.8));
    else if (n === 'f' || n === '0') setViewport(null);
    else if (n === 'l') setShowLegend((s) => !s);
    else if (n === 'm') onCycleMode();
    else if (n === 'r') onReload?.();
    else if (n === 'c') {
      const id = selected ?? hovered;
      const target = id ? viewWorld.find((w) => w.id === id) : undefined;
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
    [vp, width, height, sub]
  );

  const onMouseDrag = useCallback(
    (e: MouseLike) => {
      const d = dragRef.current;
      if (!d) return;
      if (e.x !== d.startX || e.y !== d.startY) d.moved = true;
      const s = sub(e);
      setViewport(anchorViewport(d.anchorWorld, d.scale, s.x, s.y, width, height));
    },
    [width, height, sub]
  );

  const onMouseUp = useCallback(
    (e: MouseLike) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (d && !d.moved && (e.button ?? 0) === 0) {
        // Family legend (top-left): caret zone expands, row body toggles the family, a sub row toggles
        // that relation.
        const famHit = familyLegendHit(e.x, e.y);
        if (famHit) {
          if (famHit.kind === 'expand') return toggleFamilyExpand(famHit.key as EdgeFamily);
          if (famHit.kind === 'toggle-parent') return toggleFamily(famHit.key as EdgeFamily);
          return toggleRelation(famHit.sub);
        }
        // Type legend (top-right): caret zone expands, row body toggles the type, a sub row toggles it.
        const tyHit = legendHit(e.x, e.y);
        if (tyHit) {
          if (tyHit.kind === 'expand') return toggleTypeExpand(tyHit.key);
          if (tyHit.kind === 'toggle-parent') return toggleType(tyHit.key);
          return toggleSub(tyHit.parent, tyHit.sub);
        }
        const hit = hitTest(e.x, e.y - chromeTop);
        if (hit && hit === selected) {
          const p = openTarget(hit); // click an already-selected node → open it (file-backed only)
          if (p) onOpen?.(p);
        } else setSelected(hit);
      }
    },
    [familyLegendHit, toggleFamily, toggleFamilyExpand, toggleRelation, legendHit, toggleType, toggleTypeExpand, toggleSub, hitTest, chromeTop, selected, onOpen, openTarget]
  );

  const onMouseMove = useCallback(
    (e: MouseLike) => {
      if (dragRef.current) return;
      if (zoomFactor < HOVER_ZOOM_FACTOR) {
        setHovered((h) => (h === null ? h : null));
        return;
      }
      const hit = hitTest(e.x, e.y - chromeTop);
      setHovered((h) => (h === hit ? h : hit));
    },
    [hitTest, zoomFactor, chromeTop]
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
    [vp, width, height, sub]
  );

  const sel = selected ? viewGraph.nodes.find((nd) => nd.id === selected) : undefined;
  const selDeg = selected ? (adjacency.get(selected)?.size ?? 0) : 0;
  const selBucket = sel ? axisKeyOf(sel, mode) : '';
  // Hidden segments — quiet at zero, and when nonzero the leading unit reads bare while a second unit
  // reads with a `+` prefix (`2 types +3 subs hidden`, `1 family +2 relations hidden`). The node side
  // covers type + sub hides, the edge side family + relation hides.
  const hiddenSeg = (units: { n: number; one: string; many: string }[]): string => {
    const nz = units.filter((u) => u.n > 0);
    if (nz.length === 0) return '';
    return nz.map((u, i) => `${i > 0 ? '+' : ''}${u.n} ${u.n === 1 ? u.one : u.many}`).join(' ') + ' hidden';
  };
  const hiddenNodeSeg = hiddenSeg([
    { n: hiddenTypes.size, one: 'type', many: 'types' },
    { n: hiddenSubs.size, one: 'sub', many: 'subs' },
  ]);
  const hiddenEdgeSeg = hiddenSeg([
    { n: hiddenFamilies.size, one: 'family', many: 'families' },
    { n: hiddenRelations.size, one: 'relation', many: 'relations' },
  ]);
  // Overlay flags — surface only NON-default states so the info line stays quiet by default.
  const flags = [
    config.attention ? '' : 'attn:off',
    config.recencyFade ? 'recency' : '',
    config.emphasizeHubs ? 'hubs' : '',
    config.statusForce !== DEFAULT_GRAPH_CONFIG.statusForce ? `sf:${config.statusForce.toFixed(2)}` : '',
  ].filter(Boolean);

  // For clustered modes, show how many groups the layout produced (esp. useful for `community`,
  // whose count is discovered — so the color palette size is legible at a glance).
  const groupCount = mode === 'cluster' || mode === 'status' || mode === 'community' ? new Set(viewWorld.map((w) => w.cluster)).size : 0;
  const modeLabel = layingOut ? `${mode} · laying out…` : groupCount ? `${mode} (${groupCount})` : mode;

  // When the overlay is on, surface the visible typed-edge count — or `no typed edges` if there are no
  // typed edges in view (empty semantic fetch: daemon down / old daemon, or no typed edges in the
  // focused neighborhood).
  const typedStatus = overlayOn ? (viewSemantic.length === 0 ? ' · no typed edges' : ` · typed ${typedVisible ?? 0}`) : '';
  // Surface the transient-orphan hiding so it's never a silent cap (∮): `orphans -N` when the filter
  // hides >0 nodes. Quiet otherwise (nothing hidden, or the `all` knob shows every orphan).
  const orphanStatus = hiddenOrphanCount > 0 ? ` · orphans -${hiddenOrphanCount}` : '';
  // Focus mode leads the info line so the scoped view is never mistaken for the full graph (∮): the
  // node/link counts below are already the subgraph's (viewGraph swaps in when focused).
  const focusStatus = focused ? ` focus ${hops}-hop ·` : '';

  // Row 1 = live info (counts · mode · zoom · overlays · hidden · selection). Row 2 = controls.
  const infoLine =
    focusStatus +
    ` ${viewGraph.nodes.length} nodes · ${viewGraph.links.length} links · ${modeLabel} · ${zoomFactor.toFixed(1)}× zoom` +
    (flags.length ? ` · ${flags.join(' ')}` : '') +
    typedStatus +
    orphanStatus +
    (hiddenNodeSeg ? ` · ${hiddenNodeSeg}` : '') +
    (hiddenEdgeSeg ? ` · ${hiddenEdgeSeg}` : '') +
    (sel ? `   ◉ ${sel.label ?? sel.id}${sel.status ? ` [${sel.status}]` : ''} · ${selBucket} · ${selDeg} links` : '');
  const controlLine =
    ' drag pan · scroll zoom · click select · click·click / ⏎ open · click legend = toggle · caret = drill' +
    ' · [o]ptions [s]earch [m]ode [r]eload [f]it [c]enter [l]egend' +
    (focused ? ' · [n/esc] exit focus' : ' · [n] focus neighborhood');

  return (
    <box flexDirection="column" flexGrow={1} width="100%">
      <box
        flexGrow={1}
        width="100%"
        backgroundColor={GRAPH_BG}
        renderAfter={draw}
        onMouseDown={onMouseDown}
        onMouseDrag={onMouseDrag}
        onMouseUp={onMouseUp}
        onMouseMove={onMouseMove}
        onMouseScroll={onMouseScroll}
      />
      <box width="100%" height={1} backgroundColor={STATUS_BG}>
        <text fg={STATUS_FG}>{infoLine}</text>
      </box>
      <box width="100%" height={1} backgroundColor={GRAPH_BG}>
        <text fg={STATUS_DIM}>{controlLine}</text>
      </box>
      <MConfigModal active={configOpen} mode={mode} config={config} onSetMode={modalSetMode} onChange={modalChange} onClose={closeConfig} />
      <MNodeSearchModal active={searchOpen} nodes={graph.nodes} onPick={pickSearch} onClose={closeSearch} />
    </box>
  );
}
