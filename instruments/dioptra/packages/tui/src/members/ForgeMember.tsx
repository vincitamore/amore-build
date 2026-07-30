import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import {
  forgePipelineDirs,
  listForge,
  listForgePipelineDetails,
  markDreamActed,
  markPipelineReviewed,
  resolveProposal,
  type ForgeListItem,
} from '@selene/regula';
import { resolveOrgRoot } from '../daemon';
import { usePalette } from '../ThemeProvider';
import type { Palette } from '../theme';
import { useStableDimensions } from '../use-stable-dimensions';
import { dlog, tickRender } from '../debug';
import { Panel } from '../components/Panel';
import { DocView } from '../components/DocView';
import { useFlash } from '../components/use-flash';
import { useRefreshOnActive } from '../use-refresh-on-active';
import { buildForgeData, pipelineAgentCount, pipelineDate, pipelineLayerCount, type Pipeline } from '../forge/forge-data';
import { flattenForge, forgeTabs, rowOpenPath, type ForgeRow, type ForgeSection } from '../forge/forge-rows';

const SECTIONS: ForgeSection[] = ['pipelines', 'dreams', 'recipes', 'proposals'];
const SECTION_LABEL: Record<ForgeSection, string> = { pipelines: 'Pipelines', dreams: 'Dreams', recipes: 'Recipes', proposals: 'Proposals' };

type SortMode = 'recent' | 'type' | 'agents' | 'name';
const SORT_MODES: SortMode[] = ['recent', 'type', 'agents', 'name'];

function recipeColor(p: Palette, recipe?: string) {
  switch (recipe) {
    case 'gather-synthesize':
    case 'substrate-health':
      return p.success;
    case 'assay':
    case 'dream-digest':
      return p.info;
    case 'deep-review':
    case 'self-orient':
      return p.secondary;
    case 'knowledge-consolidation':
    case 'intent-learning':
      return p.warning;
    default:
      return p.muted;
  }
}
function statusColor(p: Palette, status?: string) {
  switch (status) {
    case 'complete':
    case 'acted':
    case 'reviewed':
    case 'applied':
      return p.success;
    case 'pending':
    case 'partial':
      return p.warning;
    case 'failed':
    case 'rejected':
      return p.error;
    case 'running':
      return p.info;
    default:
      return p.muted;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(1, n - 1))}…`;
}

const isDreamPending = (p: Pipeline) => p.triggeredBy === 'dream' && p.reviewStatus === 'pending' && !!p.manifest;

type Seg = { text: string; fg: Palette[keyof Palette] };

// Build a row's display as a single line that CANNOT wrap, with a UNIFORM child structure: always
// exactly two right-side segments (`a`, `b`), each possibly EMPTY. Never a variable child count.
// Why uniform: a varying number of right `<text>` children (recipe/counts/handle/output/status)
// mounts/unmounts native text renderables on every expand — a use-after-free that segfaulted the
// renderer non-deterministically. Empty-but-present keeps the renderable set constant (content +
// color change only), matching the proven-stable TreeView. `main` is truncated to leave room for
// the right segments so the line never wraps (a wrapped row desyncs the fixed-slot windowing).
function rowDisplay(row: ForgeRow, p: Palette, contentW: number): { main: string; mainFg: Palette[keyof Palette]; a: Seg; b: Seg } {
  const indent = '  '.repeat(row.depth);
  let rawMain = '';
  let mainFg: Palette[keyof Palette] = p.foreground;
  let a: Seg = { text: '', fg: p.muted };
  let b: Seg = { text: '', fg: p.muted };
  switch (row.kind) {
    case 'group':
      rawMain = `${indent}${row.collapsed ? '▸' : '▾'} ${row.label}`;
      mainFg = p.secondary;
      break;
    case 'pipeline': {
      const pl = row.pipeline;
      const dream = pl.triggeredBy === 'dream' ? '☽ ' : '';
      rawMain = `${indent}${row.expanded ? '▾' : '▸'} ${dream}${pl.goal || pl.name}`;
      a = { text: pl.recipe || '', fg: recipeColor(p, pl.recipe) };
      b = { text: `${pipelineLayerCount(pl)}L·${pipelineAgentCount(pl)}a${isDreamPending(pl) ? ' ●' : ''}`, fg: p.muted };
      break;
    }
    case 'manifest':
      rawMain = `${indent}↳ View manifest`;
      mainFg = p.info;
      break;
    case 'layer':
      rawMain = `${indent}${row.label}`;
      mainFg = p.muted;
      break;
    case 'note':
      rawMain = `${indent}${row.text}`;
      mainFg = p.muted;
      break;
    case 'agent':
      rawMain = `${indent}${row.last ? '└─' : '├─'} ${row.agent.concern}`;
      a = { text: row.agent.handle ? 'handle' : '', fg: p.info };
      b = { text: row.agent.output ? 'output' : '', fg: p.secondary };
      break;
    case 'artifact': {
      const it = row.item;
      rawMain = `${indent}${row.icon} ${it.dreamAction || it.title}`;
      b = { text: it.status || '', fg: statusColor(p, it.status) };
      break;
    }
  }
  const rightLen = a.text.length + (b.text ? b.text.length + (a.text ? 1 : 0) : 0);
  const mainMax = Math.max(4, contentW - rightLen - 1);
  return { main: truncate(rawMain, mainMax), mainFg, a, b };
}

function rowActionsHint(row: ForgeRow | undefined): string {
  if (!row) return '↑↓ navigate · [ ] section';
  switch (row.kind) {
    case 'group':
      return `enter ${row.collapsed ? 'expand' : 'collapse'}`;
    case 'pipeline':
      return `enter ${row.expanded ? 'collapse' : 'expand'}${isDreamPending(row.pipeline) ? ' · m reviewed' : ''}`;
    case 'agent':
      return `enter ${row.agent.output ? 'output' : 'open'}${row.agent.handle ? ' · h handle' : ''}`;
    case 'manifest':
      return 'enter open manifest';
    case 'artifact': {
      const it = row.item;
      if (it.path.startsWith('forge/proposals/') && (it.status === 'pending' || !it.status)) return 'enter open · a apply · r reject · s stale';
      if (it.path.startsWith('forge/dreams/') && it.status === 'pending') return 'enter open · a mark acted';
      return 'enter open';
    }
    case 'layer':
    case 'note':
      return '↑↓ navigate';
  }
}

/**
 * Forge member — the one screen whose web version isn't a flat list. Section tabs
 * (Pipelines/Dreams/Recipes/Proposals) over a windowed, collapsible pipeline tree (left)
 * + a DocView detail pane (right, side-by-side when wide enough, mode-switched when narrow).
 * Pipelines reconstruct from manifests + handle/output pairs; shape (layers/agents) shows on
 * the collapsed card via the manifest frontmatter (no lazy load). Heavy handles/outputs load
 * per-pipeline on expand. Lifecycle actions (mark acted/reviewed, apply/reject/stale) go
 * through atomic regula verbs. Mouse + keyboard co-equal; fixed-slot rows (native-safe).
 */
export function ForgeMember({
  inputActive,
  onCapture,
  daemonUrl,
}: {
  inputActive?: boolean;
  onCapture?: (b: boolean) => void;
  daemonUrl?: string | null;
}) {
  const p = usePalette();
  const root = useMemo(() => resolveOrgRoot(), []);
  const dims = useStableDimensions();
  const [light, setLight] = useState<ForgeListItem[]>([]);
  const [details, setDetails] = useState<Map<string, ForgeListItem[]>>(() => new Map());
  const [artifactDirs, setArtifactDirs] = useState<Set<string>>(() => new Set());
  const [nonce, setNonce] = useState(0);
  const [section, setSection] = useState<ForgeSection>('pipelines');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [loadedPath, setLoadedPath] = useState<string | null>(null); // debounced detailPath fed to DocView
  const [focus, setFocus] = useState<'tree' | 'detail'>('tree');
  const [docEditing, setDocEditing] = useState(false);
  const [flash, setFlash] = useFlash();
  const lastToggle = useRef(0);
  const hoverFlush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverPending = useRef<number | null>(null);

  useEffect(() => {
    setLight(listForge(root));
    setArtifactDirs(new Set(forgePipelineDirs(root)));
  }, [root, nonce]);
  useEffect(() => () => { if (hoverFlush.current) clearTimeout(hoverFlush.current); }, []);
  useEffect(() => {
    onCapture?.(docEditing);
  }, [docEditing, onCapture]);
  useEffect(() => () => onCapture?.(false), [onCapture]);

  // Debounce the detail-pane document: flicking output↔handle (or fast cursor-selects) must not
  // re-read + re-render the markdown/tree-sitter content on every keypress — that rapid native
  // churn is what segfaulted. Only the settled selection loads.
  useEffect(() => {
    if (detailPath === loadedPath) return;
    const id = setTimeout(() => {
      dlog('forge', `detail -> ${detailPath ?? '(none)'}`);
      setLoadedPath(detailPath);
    }, 130);
    return () => clearTimeout(id);
  }, [detailPath, loadedPath]);

  const data = useMemo(() => {
    const all = [...light];
    for (const d of details.values()) all.push(...d);
    return buildForgeData(all);
  }, [light, details]);
  const tabs = useMemo(() => forgeTabs(data), [data]);
  // Annotate each pipeline with whether it has real artifacts on disk (→ the manifest-only
  // partition), then sort. `recent`/`type` use pipelineDate (created → started → completed), so
  // recent custom runs (which carry started/completed, not created) sort to the top, not the bottom.
  const sortedData = useMemo(() => {
    const sortPipes = (arr: Pipeline[]) => {
      const c = arr.map((p) => {
        p.hasArtifacts = artifactDirs.has(p.name) || p.layers.size > 0;
        return p;
      });
      switch (sortMode) {
        case 'type':
          c.sort((a, b) => (a.recipe || '').localeCompare(b.recipe || '') || pipelineDate(b).localeCompare(pipelineDate(a)));
          break;
        case 'agents':
          c.sort((a, b) => pipelineAgentCount(b) - pipelineAgentCount(a));
          break;
        case 'name':
          c.sort((a, b) => a.name.localeCompare(b.name));
          break;
        default:
          c.sort((a, b) => pipelineDate(b).localeCompare(pipelineDate(a)));
      }
      return c;
    };
    return { ...data, pipelines: sortPipes(data.pipelines), dreamPipelines: sortPipes(data.dreamPipelines) };
  }, [data, sortMode, artifactDirs]);
  const rows = useMemo(() => flattenForge(section, sortedData, { expanded, toggled, loading: new Set() }), [section, sortedData, expanded, toggled]);
  tickRender('ForgeMember');

  useEffect(() => {
    setCursor((c) => Math.max(0, Math.min(c, rows.length - 1)));
  }, [rows.length]);

  const treeFocus = !!inputActive && focus === 'tree';
  const split = dims.width >= 84;
  const leftW = split ? Math.min(52, Math.max(34, Math.floor(dims.width * 0.44))) : dims.width;
  const reserve = 7; // tabs + footer + panel chrome
  const visible = Math.max(1, dims.height - reserve);
  let offset = 0;
  if (rows.length > visible) offset = Math.max(0, Math.min(cursor - Math.floor(visible / 2), rows.length - visible));
  const shown = rows.slice(offset, offset + visible);
  const cur = hovered ?? cursor;

  const reload = () => setNonce((x) => x + 1);
  useRefreshOnActive(inputActive, reload); // keep-mounted: re-read forge on return (dreams/proposals land on disk)
  const act = (fn: () => void, msg: string, moved = false) => {
    try {
      fn();
      setFlash(msg);
      if (moved) setDetailPath(null);
      reload();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : 'action failed');
    }
  };

  // Coalesce mouse-hover highlight updates. enableMouseMovement reports moves fast enough that a
  // setHovered per row-crossing churns ForgeMember's render (each re-renders the fixed-slot tree),
  // which compounds the native renderer's instability. Trailing-throttle to ~one render / 90ms:
  // the highlight still tracks the cursor, it just stops re-rendering on every move sample.
  const hoverTo = (i: number) => {
    hoverPending.current = i;
    if (hoverFlush.current) return;
    hoverFlush.current = setTimeout(() => {
      hoverFlush.current = null;
      setHovered(hoverPending.current);
    }, 90);
  };
  const clearHover = () => {
    hoverPending.current = null;
    if (hoverFlush.current) {
      clearTimeout(hoverFlush.current);
      hoverFlush.current = null;
    }
    setHovered((h) => (h === null ? h : null));
  };
  const move = (d: number) => {
    clearHover();
    setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + d)));
  };
  const throttled = (fn: () => void) => {
    const now = Date.now();
    if (now - lastToggle.current < 70) return; // native-renderer churn guard
    lastToggle.current = now;
    fn();
  };
  const toggleGroup = (id: string) =>
    throttled(() => setToggled((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    }));
  const toggleExpand = (name: string) =>
    throttled(() => {
      dlog('forge', `${expanded.has(name) ? 'collapse' : 'expand'} ${name}`);
      if (!expanded.has(name) && !details.has(name)) {
        try {
          const d = listForgePipelineDetails(root, name);
          dlog('forge', `loaded ${name} details=${d.length}`);
          setDetails((m) => new Map(m).set(name, d));
        } catch {
          // a malformed artifact won't break the expand
        }
      }
      setExpanded((prev) => {
        const n = new Set(prev);
        if (n.has(name)) n.delete(name);
        else n.add(name);
        return n;
      });
    });
  const activate = (row: ForgeRow | undefined) => {
    if (!row) return;
    if (row.kind === 'group') return toggleGroup(row.id);
    if (row.kind === 'pipeline') return toggleExpand(row.pipeline.name);
    const path = rowOpenPath(row);
    if (path) {
      // Open AND focus the detail pane, so the doc behaves like a full-screen DocView (e edit,
      // y copy, ↑↓ scroll) instead of needing a separate tab to reach it. Esc/tab returns to tree.
      setDetailPath(path);
      setFocus('detail');
    }
  };
  const cycleSection = (d: number) => {
    const i = SECTIONS.indexOf(section);
    setSection(SECTIONS[(i + d + SECTIONS.length) % SECTIONS.length]);
    setCursor(0);
  };

  useKeyboard((key: { name?: string; sequence?: string; ctrl?: boolean }) => {
    if (!inputActive) return;
    const n = (key.name ?? '').toLowerCase().replace('arrow', '');
    if (focus === 'detail') {
      // DocView owns the rest (scroll/edit/esc→tree). Don't steal tab while it's editing —
      // the textarea needs it, and onEditingChange has already suppressed shell nav.
      if (n === 'tab' && !docEditing) return setFocus('tree');
      return;
    }
    // tree focus
    if (n === 'up' || n === 'k') return move(-1);
    if (n === 'down' || n === 'j') return move(1);
    if (n === 'pageup') return move(-visible);
    if (n === 'pagedown') return move(visible);
    if (n === 'home') return move(-rows.length);
    if (n === 'end') return move(rows.length);
    if (key.sequence === '[') return cycleSection(-1);
    if (key.sequence === ']') return cycleSection(1);
    if (n === 'o') return setSortMode((m) => SORT_MODES[(SORT_MODES.indexOf(m) + 1) % SORT_MODES.length]);
    if (n === 'tab') {
      if (detailPath) setFocus('detail');
      return;
    }
    // Act on the HIGHLIGHTED row (`cur` = hovered ?? cursor), so the row the hint describes and the
    // row a single-key action hits are the same one the user is pointing at — mouse or keyboard.
    const row = rows[cur];
    if (n === 'left') {
      if (row?.kind === 'pipeline' && row.expanded) return toggleExpand(row.pipeline.name);
      if (row?.kind === 'group' && !row.collapsed) return toggleGroup(row.id);
      return;
    }
    if (n === 'right') {
      if (row?.kind === 'pipeline' && !row.expanded) return toggleExpand(row.pipeline.name);
      if (row?.kind === 'group' && row.collapsed) return toggleGroup(row.id);
      return;
    }
    if (n === 'return' || n === 'enter' || n === 'space') return activate(row);
    // lifecycle actions (context-dependent on the focused row)
    if (n === 'm' && row?.kind === 'pipeline' && isDreamPending(row.pipeline)) {
      return act(() => markPipelineReviewed(root, row.pipeline.manifest!.path), 'reviewed ✓');
    }
    if (row?.kind === 'agent' && n === 'h' && row.agent.handle) {
      setDetailPath(row.agent.handle.path);
      return setFocus('detail');
    }
    if (row?.kind === 'artifact') {
      const it = row.item;
      const isProp = it.path.startsWith('forge/proposals/');
      const isDream = it.path.startsWith('forge/dreams/');
      const propPending = isProp && (it.status === 'pending' || !it.status);
      if (isDream && it.status === 'pending' && n === 'a') return act(() => markDreamActed(root, it.path), 'acted ✓');
      if (propPending && n === 'a') return act(() => resolveProposal(root, it.path, 'applied'), 'applied ✓', true);
      if (propPending && n === 'r') return act(() => resolveProposal(root, it.path, 'rejected'), 'rejected ✓', true);
      if (propPending && n === 's') return act(() => resolveProposal(root, it.path, 'stale'), 'stale ✓', true);
    }
  });

  const onScroll = (e: { scroll?: { direction?: string }; button?: number }) => {
    let dir = e.scroll?.direction;
    if (!dir && e.button === 4) dir = 'up';
    if (!dir && e.button === 5) dir = 'down';
    if (dir === 'up') move(-3);
    else if (dir === 'down') move(3);
  };

  const tree = (
    <Panel
      title={`Forge · ${SECTION_LABEL[section]}`}
      headerRight={`${tabs.find((t) => t.key === section)?.count ?? 0}`}
      width={split ? leftW : undefined}
      flexGrow={split ? undefined : 1}
      active={treeFocus}
    >
      <box flexDirection="column" flexGrow={1} onMouseScroll={onScroll} onMouseOut={clearHover}>
        {Array.from({ length: visible }, (_, vi) => {
          const r = shown[vi];
          const i = offset + vi;
          const hi = !!r && i === cur;
          const empty = rows.length === 0 && vi === 0;
          const d = r ? rowDisplay(r, p, (split ? leftW : dims.width) - 4) : null;
          return (
            <box
              key={`slot-${vi}`}
              flexDirection="row"
              backgroundColor={hi ? p.selection : p.background}
              onMouseOver={r ? () => hoverTo(i) : undefined}
              onMouseDown={
                r
                  ? () => {
                      clearHover();
                      setCursor(i);
                      activate(r);
                    }
                  : undefined
              }
            >
              {/* UNIFORM 4-child structure on every slot — never a variable child count (the
                  use-after-free that segfaulted on expand). Empty segments render empty strings. */}
              <text fg={d ? d.mainFg : empty ? p.muted : p.background}>{d ? d.main : empty ? '  (empty)' : ' '}</text>
              <box flexGrow={1} />
              <text fg={d ? d.a.fg : p.background}>{d ? d.a.text : ''}</text>
              <text fg={d ? d.b.fg : p.background}>{d && d.b.text ? (d.a.text ? ' ' : '') + d.b.text : ''}</text>
            </box>
          );
        })}
      </box>
    </Panel>
  );

  // MEMOIZE the detail pane. It was recreated on every ForgeMember render — so each hover / cursor
  // move / expand (12–63/s) re-rendered the mounted <markdown>, re-processing a 19KB doc dozens of
  // times/sec through the native renderer → the opentui.dll recursion segfault. Now it re-renders
  // only when its real inputs change (the selected doc, focus, input ownership), not on tree churn.
  const onDetailClose = useCallback(() => setFocus('tree'), []);
  const onDetailSaved = useCallback(() => {
    setFocus('tree');
    setNonce((x) => x + 1);
  }, []);
  const detailActive = !!inputActive && focus === 'detail';
  const detail = useMemo(
    () =>
      loadedPath ? (
        <DocView
          path={loadedPath}
          daemonUrl={daemonUrl}
          inputActive={detailActive}
          onEditingChange={setDocEditing}
          onClose={onDetailClose}
          onSaved={onDetailSaved}
        />
      ) : (
        <Panel title="Detail" flexGrow={1}>
          <text fg={p.muted}>Select an artifact (enter) to view it here.</text>
          <text fg={p.muted}>Pipelines expand to their layer → agent tree.</text>
        </Panel>
      ),
    [loadedPath, daemonUrl, detailActive, onDetailClose, onDetailSaved, p.muted],
  );

  const footer = flash
    ? `${flash}`
    : focus === 'detail'
      ? 'tab/esc → tree · e edit · y copy · ↑↓ scroll'
      : `${rowActionsHint(rows[cur])} · enter opens+focuses · [ ] section · o sort:${sortMode}`;

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Section tabs (clickable + [ ] keys) */}
      <box flexShrink={0} flexDirection="row" paddingLeft={1}>
        {tabs.map((tab) => (
          <box
            key={tab.key}
            marginRight={2}
            onMouseDown={() => {
              setSection(tab.key);
              setCursor(0);
            }}
          >
            <text fg={section === tab.key ? p.primary : p.muted}>
              {`${tab.label} ${tab.count}`}
              {tab.alert > 0 ? <span fg={p.warning}>{` ·${tab.alert} new`}</span> : null}
            </text>
          </box>
        ))}
      </box>

      {/* Body: side-by-side when wide; mode-switch when narrow */}
      {split ? (
        <box flexDirection="row" flexGrow={1}>
          {tree}
          <box flexGrow={1}>{detail}</box>
        </box>
      ) : focus === 'detail' && loadedPath ? (
        detail
      ) : (
        tree
      )}

      {/* Footer */}
      <box flexShrink={0} paddingLeft={1}>
        <text fg={flash ? p.success : p.muted}>{footer}</text>
      </box>
    </box>
  );
}
