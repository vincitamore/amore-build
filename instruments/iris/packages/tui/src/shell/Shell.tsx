import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useKeyboard, useRenderer } from '@opentui/react';
import { graphSignature, layoutWorldAsync, DEFAULT_GRAPH_CONFIG, type GraphConfig, type GraphData, type LayoutMode, type WorldNode } from '../render/graph';
import type { SemanticLink } from '../render/overlay';
import { daemonUrl, ensureDaemon, isDaemonUp, resolveOrgRoot } from '../daemon';
import { docJumpInfo } from '../doc-jump';
import { listReminders } from '@amore/regula';
import { syntheticGraph, syntheticSemanticLinks } from '../graph-view/synthetic';
import { GraphView } from '../graph-view/GraphView';
import { LoadingView } from '../graph-view/LoadingView';
import { Dashboard } from '../members/Dashboard';
import { TasksMember } from '../members/TasksMember';
import { InboxMember } from '../members/InboxMember';
import { RemindersMember } from '../members/RemindersMember';
import { KnowledgeMember } from '../members/KnowledgeMember';
import { FilesMember } from '../members/FilesMember';
import { ForgeMember } from '../members/ForgeMember';
import { LucernaMember } from '../members/LucernaMember';
import { SessionsMember } from '../members/SessionsMember';
import { PeersMember } from '../members/PeersMember';
import { DocView } from '../components/DocView';
import { SearchOverlay } from '../SearchOverlay';
import { ThemePicker } from '../ThemePicker';
import { usePalette } from '../ThemeProvider';
import { dlog } from '../debug';
import type { SessionFocus } from '../speculum/status';
import { MemberBar } from './MemberBar';

const TYPE_OF: Record<string, string> = { Tasks: 'task', Inbox: 'inbox', Reminders: 'reminder', Knowledge: 'knowledge' };

// Memoized member views. Because every member is kept mounted (eager-mount), a Shell re-render (a
// timer, a poll, a nav) would otherwise re-render ALL of them — including hidden ones — and that
// ambient churn is what makes a coinciding layout mutation (opening a modal) hit OpenTUI 0.4.2's
// use-after-free. `memo` + referentially-stable props (the `useCallback`'d handlers) keep a hidden
// member from re-rendering unless ITS OWN props change, cutting the background churn to ~zero.
const MDashboard = memo(Dashboard);
const MTasks = memo(TasksMember);
const MInbox = memo(InboxMember);
const MReminders = memo(RemindersMember);
const MKnowledge = memo(KnowledgeMember);
const MFiles = memo(FilesMember);
const MForge = memo(ForgeMember);
const MLucerna = memo(LucernaMember);
const MSessions = memo(SessionsMember);
const MPeers = memo(PeersMember);
// GraphView + the global DocView are also kept-mounted and were the ACTUAL churn source (their
// child GraphConfigModal / MarkdownView re-rendered on every Shell re-render). Memoize them too so
// they go quiet unless their own props change.
const MGraphView = memo(GraphView);
const MDocView = memo(DocView);

// Digits 1-9 keep members 0..8; Sessions is letter-key only (`s`), Peers is `Shift+P`.
const MEMBERS = ['Dashboard', 'Tasks', 'Inbox', 'Reminders', 'Knowledge', 'Files', 'Forge', 'Lucerna', 'Graph', 'Sessions', 'Peers'] as const;

/**
 * Initial member index for launch presets.
 * Resolution: argv `--member <Name>` / `--member=<Name>`, else env `IRIS_MEMBER`.
 * Names match the tab bar (case-insensitive). Unknown values fall back to Dashboard (0).
 */
export function resolveInitialMemberIndex(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): number {
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--member' && argv[i + 1]) {
      name = argv[++i];
      break;
    }
    if (a.startsWith('--member=')) {
      name = a.slice('--member='.length);
      break;
    }
  }
  if (!name) {
    const fromEnv = env.IRIS_MEMBER ?? env.IRIS_TAB;
    if (fromEnv && fromEnv.trim()) name = fromEnv.trim();
  }
  if (!name) return 0;
  // Case-insensitive match; accept singular "session" as Sessions (CLI convenience).
  const needle = name.toLowerCase() === 'session' ? 'sessions' : name.toLowerCase();
  const idx = MEMBERS.findIndex((m) => m.toLowerCase() === needle);
  return idx >= 0 ? idx : 0;
}

// Layout modes the graph's `m` key cycles through, in order. See render/graph.ts for each.
const LAYOUT_MODES: LayoutMode[] = ['force', 'cluster', 'status', 'community', 'radial'];

async function fetchGraph(url: string): Promise<GraphData | null> {
  try {
    // shape=v2 (ratified daemon shape): kind:file nodes for on-disk non-md wikilink targets, forge
    // type split pipeline|dream, per-node `subtype`, worktrees excluded. An older daemon ignores the
    // param and returns the legacy shape — every downstream consumer treats the v2 fields as optional.
    const res = await fetch(`${url}/api/graph?shape=v2`);
    if (res.ok) {
      const g = (await res.json()) as GraphData;
      if (g.nodes?.length) return g;
    }
  } catch {
    // unreachable
  }
  return null;
}

// A raw /api/graph link as the daemon serializes it — only the fields the overlay reads.
interface RawSemanticLink {
  source?: string;
  target?: string;
  relation?: string;
  tier?: string;
  edgeKind?: string;
}

/**
 * The SECOND, overlay-only fetch: `/api/graph?edges=semantic` supplies the typed edges (layout +
 * signature are driven entirely by the unchanged wiki fetch). Defensive by design — a daemon that's
 * down, or too old to know the `edges` param (it would echo wiki links back), yields no `edgeKind`,
 * so we keep only genuine `edgeKind === 'semantic'` links; anything else → an empty overlay.
 */
async function fetchSemantic(url: string): Promise<SemanticLink[]> {
  try {
    const res = await fetch(`${url}/api/graph?edges=semantic`);
    if (!res.ok) return [];
    const g = (await res.json()) as { links?: RawSemanticLink[] };
    const out: SemanticLink[] = [];
    for (const l of g.links ?? []) {
      if (l.edgeKind !== 'semantic') continue; // drop wiki links an old daemon may have returned
      if (typeof l.source !== 'string' || typeof l.target !== 'string' || typeof l.relation !== 'string') continue;
      out.push({ source: l.source, target: l.target, relation: l.relation, tier: l.tier, edgeKind: 'semantic' });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The dashboard shell — a top member bar + tab navigation (Ctrl+N/P, 1-9) over the members.
 * The graph data/layout is lifted here so switching tabs doesn't reload it; the daemon is
 * ensured (spawned + supervised) once and its URL handed to the Dashboard for enrichment.
 * Pressing `t` opens the theme picker overlay (live preview); the shell owns global nav + quit.
 */
export function Shell({ onQuit }: { onQuit?: () => void }) {
  const t = usePalette();
  const [active, setActive] = useState(() => resolveInitialMemberIndex());
  // Members are ALL mounted once at boot and kept alive; switching only toggles OpenTUI's `visible`
  // (yoga display:none), never mount/unmount. This is the cure for the native use-after-free that
  // segfaulted on screen switches — the crash is in OpenTUI's renderable TEARDOWN *and* first-MOUNT,
  // so both must be kept off the switch path. Lazy first-mount (the earlier `visited` optimization)
  // still left first-visit as a tree mutation: navigating to a never-seen member mounted it, and
  // that mount coinciding with a just-closed doc's churn segfaulted. Eager-mounting every member at
  // boot (one clean commit, before any animation churn) removes mount/unmount from switching for good.
  // Mounted-but-hidden members are ~free (not laid out/drawn) and their pollers gate on inputActive.
  const [visited] = useState<Set<number>>(() => new Set(MEMBERS.map((_, i) => i)));
  const [picker, setPicker] = useState(false);
  const [capture, setCapture] = useState(false);
  const [search, setSearch] = useState(false);
  // The global DocView (opened from the graph / dashboard / search) is KEPT MOUNTED once first
  // opened and toggled via `visible` — unmounting its (often churning) markdown subtree hit the
  // OpenTUI teardown use-after-free, e.g. open a doc from the graph then navigate to a member.
  // `globalDoc` (non-null) is the "shown" flag; `docPath` is the path the mounted DocView renders.
  const [globalDoc, setGlobalDoc] = useState<string | null>(null);
  const [docPath, setDocPath] = useState<string | null>(null);
  // These callbacks are passed to the (memoized) members — keep them referentially STABLE
  // (`useCallback`, empty deps: only setters/consts inside) so a Shell re-render doesn't hand every
  // member a new function identity and defeat `React.memo`, which is what keeps hidden members quiet.
  const openDoc = useCallback((path: string) => {
    dlog('shell', `globalDoc open ${path}`);
    setDocPath(path);
    setGlobalDoc(path);
  }, []);
  // Jump from a global doc to the member that owns it, with the item focused (bump the nonce so a
  // repeat jump to the same item re-fires). Closes the doc (kept-mounted → just hides) and switches.
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const jumpToItem = useCallback((path: string) => {
    const info = docJumpInfo(path);
    if (!info) return;
    setFocusPath(path);
    setFocusNonce((k) => k + 1);
    setGlobalDoc(null);
    setCapture(false);
    const i = MEMBERS.indexOf(info.member as (typeof MEMBERS)[number]);
    if (i >= 0) setActive(i);
  }, []);
  // Session jump spine: shell owns focus + navigate-to-Sessions. The full Focus union lands with
  // exploration stages; this is the seam (`navigate` + `openSession`). No Map/Search glyph
  // callers yet — openSession is kept ready for later wiring. Consume-once jump is honored by
  // SessionsMember (it flashes until the session picker exists).
  const [sessionFocus, setSessionFocus] = useState<SessionFocus | null>(null);
  const [sessionFocusNonce, setSessionFocusNonce] = useState(0);
  const openSession = useCallback((sessionId: string, opts?: { eventId?: string | number; ts?: string }) => {
    setSessionFocus({ sessionId, eventId: opts?.eventId, ts: opts?.ts });
    setSessionFocusNonce((k) => k + 1);
    setActive(MEMBERS.indexOf('Sessions'));
  }, []);
  // Retained for Map/Search prop-wiring (no callers yet).
  void openSession;
  const [daemonReady, setDaemonReady] = useState<string | null>(null);
  // Non-null when the graph fell back to synthetic demo data (daemon unreachable, or empty index)
  // — surfaced as a muted status banner so the fallback is never silent (the stale-daemon trap).
  const [demoNotice, setDemoNotice] = useState<string | null>(null);

  // Selection mode: flip the renderer's mouse reporting OFF so the terminal's NATIVE drag-select +
  // copy works again (mouse reporting otherwise eats the selection). One global toggle covers every
  // screen — no per-surface copy code. While on, members yield the keyboard (mouse-driven).
  const renderer = useRenderer();
  const [selectMode, setSelectMode] = useState(false);
  const toggleSelect = () => {
    setSelectMode((on) => {
      const next = !on;
      try {
        (renderer as unknown as { useMouse: boolean }).useMouse = !next;
      } catch {
        // best-effort — if the renderer can't toggle, selection mode is a no-op
      }
      return next;
    });
  };

  // Overdue-reminder count for the member-bar indicator. Recomputed on mount + each minute
  // (a reminder crosses overdue on its own, with no event to trigger a re-render).
  const [overdue, setOverdue] = useState(0);
  useEffect(() => {
    const root = resolveOrgRoot();
    const ACTIVE_R = new Set(['pending', 'snoozed', 'ongoing']);
    const compute = () => {
      const now = Date.now();
      setOverdue(
        listReminders(root).filter((r) => {
          if (!ACTIVE_R.has(r.status ?? '')) return false;
          const when = r.snoozedUntil || r.remindAt;
          const ts = when ? new Date(when).getTime() : NaN;
          return !Number.isNaN(ts) && ts < now;
        }).length,
      );
    };
    compute();
    const id = setInterval(compute, 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    dlog('shell', `member -> ${MEMBERS[active]}`);
    setCapture(false); // a member left mid-edit stays mounted; don't let its stale capture gag shell nav
  }, [active]);

  const [graph, setGraph] = useState<GraphData | null>(null);
  const [semanticLinks, setSemanticLinks] = useState<SemanticLink[]>([]); // typed-edge overlay (2nd fetch)
  const [mode, setMode] = useState<LayoutMode>('force');
  const [graphCfg, setGraphCfg] = useState<GraphConfig>(DEFAULT_GRAPH_CONFIG);
  const [world, setWorld] = useState<WorldNode[] | null>(null);
  const [neutralCluster, setNeutralCluster] = useState(-1); // community mode's misc-bucket index (→ gray)
  const [layingOut, setLayingOut] = useState(false); // a relayout in flight (the PRIOR world stays rendered)
  const [loadingLabel, setLoadingLabel] = useState('Connecting to Iris daemon');
  const graphRef = useRef<GraphData | null>(null);
  graphRef.current = graph;

  // Structural signature (nodes + LINK ENDPOINTS — a rewired wikilink at constant counts must
  // invalidate too, else a reload keeps stale positions + community colors). Metadata-only
  // changes keep the signature → recolor in place, no reflow.
  const layoutSig = useMemo(() => (graph ? graphSignature(graph) : ''), [graph]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      let url = daemonUrl();
      let daemonOk = false;
      if (!(await isDaemonUp(url)) && alive) setLoadingLabel('Starting Iris daemon (building index)');
      try {
        const r = await ensureDaemon({ autoSpawn: true });
        url = r.url;
        daemonOk = true;
        if (alive) setDaemonReady(url);
      } catch {
        // no daemon reachable/spawnable → synthetic demo data, no dashboard enrichment
      }
      if (!alive) return;
      setLoadingLabel('Loading knowledge graph');
      const fetched = await fetchGraph(url);
      if (!alive) return;
      if (fetched) {
        // Real graph → the wiki fetch drives layout; a SEPARATE semantic fetch feeds the overlay.
        setGraph(fetched);
        setDemoNotice(null);
        const s = await fetchSemantic(url);
        if (alive) setSemanticLinks(s);
      } else {
        // No daemon (or empty index) → synthetic demo graph + synthetic typed edges so the overlay
        // demos offline. SURFACE the fallback — silent demo data is the stale-daemon trap (A4 fix 3).
        const demo = syntheticGraph();
        setGraph(demo);
        setSemanticLinks(syntheticSemanticLinks(demo));
        setDemoNotice(
          daemonOk
            ? 'Graph index empty — showing demo data'
            : 'Iris daemon unavailable — showing demo data (graph, search & enrichment offline)',
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Re-fetch the graph on demand (`r` in the Graph view) so node status/attention reflect the live
  // tree — the graph data was otherwise fetched once at launch and went stale. Metadata-only changes
  // recolor in place (layoutSig unchanged → no relayout); structural changes trigger a fresh layout.
  const reloadGraph = useCallback(async () => {
    const url = daemonReady ?? daemonUrl();
    const g = await fetchGraph(url);
    if (g) {
      setGraph(g);
      setSemanticLinks(await fetchSemantic(url)); // keep the typed overlay in sync with the reload
    }
  }, [daemonReady]);

  // Stable handlers for the (memoized) GraphView + global DocView — so a Shell re-render doesn't
  // hand them new function identities and re-render them (and their churn-prone modal children).
  const cycleMode = useCallback(() => setMode((m) => LAYOUT_MODES[(LAYOUT_MODES.indexOf(m) + 1) % LAYOUT_MODES.length]), []);
  const changeGraphCfg = useCallback((patch: Partial<GraphConfig>) => setGraphCfg((c) => ({ ...c, ...patch })), []);
  const onReloadGraph = useCallback(() => void reloadGraph(), [reloadGraph]);
  const closeGlobalDoc = useCallback(() => {
    dlog('shell', 'globalDoc close');
    setGlobalDoc(null);
    setCapture(false);
  }, []);
  const savedGlobalDoc = useCallback(() => setCapture(false), []);
  // Member-bar CLICK (the mouse dual of the 1-9 / Ctrl+N-P keys). Keyboard nav is gated behind the
  // open global doc in the shell key handler, but a click reaches setActive directly — which would
  // switch the member UNDER the doc (the bar highlights a member the doc still covers). Ratified
  // behavior: a click while the doc is open CLOSES it first, then switches. `setGlobalDoc(null)` is
  // a no-op when no doc is open, so this is the plain switch in that case. Keyboard path unchanged.
  const selectMember = useCallback((i: number) => {
    setGlobalDoc(null);
    setCapture(false);
    setActive(i);
  }, []);

  // Cache computed layouts by (mode, statusForce) so switching BACK to an already-run mode is
  // instant — the force sim (~seconds on the full graph) never re-runs for a layout we've seen.
  // Keyed under the structural signature: a reload that changes the node/link set clears the cache
  // (stale positions would be wrong), a metadata-only reload keeps it (positions still valid).
  const layoutCache = useRef<Map<string, { nodes: WorldNode[]; neutralCluster: number }>>(new Map());
  const cacheSig = useRef<string>('');

  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    if (cacheSig.current !== layoutSig) {
      layoutCache.current.clear();
      cacheSig.current = layoutSig;
    }
    // statusForce only affects the force layout — keying it into other modes' cache entries
    // caused a needless full relayout (and a duplicate cache entry) when stepping it from the
    // config modal while in a clustered/radial mode.
    const key = mode === 'force' ? `force:${graphCfg.statusForce}` : mode;
    const hit = layoutCache.current.get(key);
    if (hit) {
      setWorld(hit.nodes); // instant — previously computed for this (mode, statusForce)
      setNeutralCluster(hit.neutralCluster);
      setLayingOut(false);
      return;
    }
    // Cache miss: keep the PRIOR world rendered while the new layout computes — nulling it
    // swapped GraphView↔LoadingView (a mount/unmount UAF vector) and destroyed GraphView state
    // (hiddenTypes filter, an open config modal, camera). The status line shows `laying out…`.
    const signal = { aborted: false };
    setLayingOut(true);
    const iterations = g.nodes.length > 1200 ? 160 : 300;
    void layoutWorldAsync(g, { mode, statusForce: graphCfg.statusForce, signal, iterations, chunk: 4 }).then((r) => {
      if (!signal.aborted) {
        layoutCache.current.set(key, { nodes: r.nodes, neutralCluster: r.neutralCluster });
        setWorld(r.nodes);
        setNeutralCluster(r.neutralCluster);
        setLayingOut(false);
      }
    });
    return () => {
      signal.aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutSig, mode, graphCfg.statusForce]);

  // Shell owns global nav + quit; an overlay/editor owns input while open (members gated then).
  useKeyboard((key: { name?: string; sequence?: string; ctrl?: boolean }) => {
    const n = (key.name ?? '').toLowerCase();
    // Selection mode is global — works over a member OR an open doc — but never while typing
    // (capture) or in another overlay. `v` toggles; Esc also exits once in it.
    if (!capture && !picker && !search) {
      if (n === 'v') return toggleSelect();
      if (selectMode && (n === 'escape' || n === 'esc')) return toggleSelect();
    }
    if (selectMode) return; // mouse-driven; swallow other shell keys until it exits
    if (picker || capture || search || globalDoc) return;
    if (n === '/' || n === 'slash' || key.sequence === '/') return setSearch(true);
    if (n === 't') {
      dlog('shell', 'picker open'); // theme previews follow — each re-renders every member (see ThemeProvider)
      return setPicker(true);
    }
    if (n === 'q') return onQuit?.();
    // Sessions letter-key (digits 1-9 keep members 0..8; Sessions has no digit).
    // Free in the shell guard region: shell uses v t q / 1-9 ctrl+n/p; no bare `s`.
    if (n === 's') return setActive(MEMBERS.indexOf('Sessions'));
    // Peers letter-key: Shift+P (bare `p` belongs to member-level actions).
    if (key.sequence === 'P') return setActive(MEMBERS.indexOf('Peers'));
    if (key.ctrl && n === 'n') return setActive((a) => (a + 1) % MEMBERS.length);
    if (key.ctrl && n === 'p') return setActive((a) => (a - 1 + MEMBERS.length) % MEMBERS.length);
    if (/^[1-9]$/.test(n)) {
      const i = Number(n) - 1;
      if (i < MEMBERS.length) setActive(i);
    }
  });

  const navigate = useCallback((name: string) => {
    const i = MEMBERS.indexOf(name as (typeof MEMBERS)[number]);
    if (i >= 0) setActive(i);
  }, []);

  const memberActive = !picker && !search && !globalDoc && !selectMode;
  const searchType = TYPE_OF[MEMBERS[active]];

  // Render the member at `idx`. Only the ACTIVE member owns input (`on`) and reports capture — a
  // hidden-but-mounted member must not eat keys or gag shell nav.
  const renderMember = (idx: number): ReactNode => {
    const on = idx === active && memberActive;
    const cap = idx === active ? setCapture : undefined;
    switch (MEMBERS[idx]) {
      case 'Graph':
        return graph && world ? (
          <MGraphView
            graph={graph}
            world={world}
            semanticLinks={semanticLinks}
            mode={mode}
            layingOut={layingOut}
            neutralCluster={neutralCluster}
            config={graphCfg}
            onCycleMode={cycleMode}
            onSetMode={setMode}
            onConfigChange={changeGraphCfg}
            onReload={onReloadGraph}
            chromeTop={1}
            inputActive={on}
            onCapture={cap}
            onOpen={openDoc}
          />
        ) : (
          <LoadingView label={!graph ? loadingLabel : `Laying out ${graph.nodes.length} nodes`} />
        );
      case 'Tasks':
        return <MTasks inputActive={on} onCapture={cap} daemonUrl={daemonReady} focusPath={focusPath ?? undefined} focusKey={focusNonce} />;
      case 'Inbox':
        return <MInbox inputActive={on} onCapture={cap} daemonUrl={daemonReady} focusPath={focusPath ?? undefined} focusKey={focusNonce} />;
      case 'Reminders':
        return <MReminders inputActive={on} onCapture={cap} daemonUrl={daemonReady} focusPath={focusPath ?? undefined} focusKey={focusNonce} />;
      case 'Knowledge':
        return <MKnowledge inputActive={on} onCapture={cap} daemonUrl={daemonReady} />;
      case 'Files':
        return <MFiles inputActive={on} onCapture={cap} daemonUrl={daemonReady} />;
      case 'Forge':
        return <MForge inputActive={on} onCapture={cap} daemonUrl={daemonReady} />;
      case 'Lucerna':
        return <MLucerna inputActive={on} onCapture={cap} daemonUrl={daemonReady} />;
      case 'Peers':
        return <MPeers inputActive={on} onCapture={cap} daemonUrl={daemonReady} />;
      case 'Sessions':
        return (
          <MSessions
            inputActive={on}
            onCapture={cap}
            focus={sessionFocus}
            focusKey={sessionFocusNonce}
            onOpenSession={openSession}
          />
        );
      default:
        return <MDashboard active={on} daemonUrl={daemonReady} onNavigate={navigate} onOpen={openDoc} />;
    }
  };

  return (
    // Root fills the renderer buffer with width/height "100%" (idiomatic; same as network-cli's
    // AppShell). The themed bg covers the whole character grid; any window-edge margin is the
    // terminal emulator's own padding (outside the grid), not a layout gap.
    <box flexDirection="column" width="100%" height="100%" backgroundColor={t.background}>
      <MemberBar members={MEMBERS} active={active} onSelect={selectMember} overdue={overdue} />
      <box flexGrow={1} width="100%">
        {/* Every VISITED member stays mounted; `visible` (yoga display:none) picks the one shown —
            no unmount on switch, so OpenTUI's teardown-path segfault can't fire. A global doc hides
            them all and renders over the top. */}
        {[...visited]
          .sort((a, b) => a - b)
          .map((idx) => (
            <box key={idx} visible={idx === active && !globalDoc} flexGrow={1} width="100%">
              {renderMember(idx)}
            </box>
          ))}
        {/* Kept MOUNTED once first opened; `visible` toggles it (display:none) so closing a doc /
            switching members never unmounts a churning markdown subtree → no teardown UAF. `docPath`
            persists the last-opened path while hidden; `globalDoc` gates visibility + input. */}
        {docPath ? (
          <box visible={!!globalDoc} flexGrow={1} width="100%">
            <MDocView
              path={docPath}
              daemonUrl={daemonReady}
              inputActive={!!globalDoc && !picker && !selectMode}
              onEditingChange={setCapture}
              onJump={jumpToItem}
              onClose={closeGlobalDoc}
              onSaved={savedGlobalDoc}
            />
          </box>
        ) : null}
      </box>
      {demoNotice ? (
        <box flexShrink={0} backgroundColor={t.background} paddingLeft={1} paddingRight={1} flexDirection="row">
          <text fg={t.warning}>● </text>
          <text fg={t.muted}>{demoNotice}</text>
        </box>
      ) : null}
      {selectMode ? (
        <box flexShrink={0} backgroundColor={t.warning} paddingLeft={1} paddingRight={1}>
          <text fg={t.background}>◉ SELECT MODE — mouse off: drag to select, copy with your terminal (Ctrl+Shift+C), then v / esc to exit</text>
        </box>
      ) : null}
      {/* Overlays kept MOUNTED, toggled by their `visible`/`active` prop (no mount/unmount). */}
      <ThemePicker visible={picker} onClose={() => setPicker(false)} />
      <SearchOverlay
        active={search}
        daemonUrl={daemonReady}
        defaultType={searchType}
        onClose={() => setSearch(false)}
        onPick={(path) => {
          openDoc(path);
          setSearch(false);
        }}
      />
    </box>
  );
}
