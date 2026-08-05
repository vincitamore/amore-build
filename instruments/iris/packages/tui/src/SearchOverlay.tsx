import { useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboard } from '@opentui/react';
import { usePalette } from './ThemeProvider';
import { useStableDimensions } from './use-stable-dimensions';

interface SearchResult {
  path: string;
  title: string;
  folder: string;
  score?: number;
  snippet?: string;
  status?: string;
  type?: string;
}

/** UI modes map to API modes: fuzzy→index, content→lex, semantic→query. */
export type SearchUiMode = 'fuzzy' | 'content' | 'semantic';

const UI_MODES: SearchUiMode[] = ['fuzzy', 'content', 'semantic'];

function apiMode(ui: SearchUiMode): 'index' | 'lex' | 'query' {
  if (ui === 'content') return 'lex';
  if (ui === 'semantic') return 'query';
  return 'index';
}

function modeLabel(ui: SearchUiMode): string {
  if (ui === 'content') return 'content (BM25)';
  if (ui === 'semantic') return 'semantic (hybrid)';
  return 'fuzzy index (local)';
}

function folderOf(path: string): string {
  return path.split('/').slice(0, -1).join('/') || '(root)';
}

const SECTIONS = ['knowledge', 'tasks', 'inbox', 'reminders', 'forge', 'archive', 'projects', 'context'];

/** Which category a result is from — its org section. */
function categoryOf(path: string): string {
  const lower = path.replace(/\\/g, '/').toLowerCase();
  const sec = SECTIONS.find((s) => lower.includes(`/${s}/`) || lower.startsWith(`${s}/`));
  return sec ? sec[0].toUpperCase() + sec.slice(1) : 'Other';
}

/** Subcategory within a category — task status, inbox type, knowledge folder, etc. */
function subcategoryOf(r: SearchResult): string {
  const segs = r.path.replace(/\\/g, '/').toLowerCase().split('/');
  const secIdx = segs.findIndex((s) => SECTIONS.includes(s));
  if (secIdx < 0) return r.type ?? r.status ?? '·';
  const section = segs[secIdx];
  const next = segs[secIdx + 1];
  const nextIsFile = secIdx + 1 >= segs.length - 1; // the segment after the section is the filename
  if (section === 'tasks') {
    if (nextIsFile) return r.status || 'active'; // tasks/ root holds active + blocked
    return next; // completed / paused / review / backlog / incubating
  }
  if (nextIsFile) return r.status ?? '·';
  return next; // inbox type · knowledge folder · archive subtree · …
}

/**
 * Global search palette (`/` from any member). Modes: fuzzy (index), content (lex),
 * semantic (hybrid query). ↑↓ moves, Tab cycles mode, Enter searches (then opens
 * the selection), Esc closes. Picking a result hands the path up for the shell
 * to open in a DocView.
 */
export function SearchOverlay({
  active = true,
  daemonUrl,
  defaultType,
  onPick,
  onClose,
}: {
  active?: boolean;
  daemonUrl?: string | null;
  defaultType?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const t = usePalette();
  // Coalesced dims: a resize burst (phone SSH) must not churn the row renderables while the
  // native buffer reallocates — see use-stable-dimensions.ts. listRows only changes after settle.
  const dims = useStableDimensions();
  const inputRef = useRef<{ value?: string } | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState('type a query · ⏎ search · tab mode');
  const [sel, setSel] = useState(0);
  const [uiMode, setUiMode] = useState<SearchUiMode>('fuzzy');

  // Kept MOUNTED (Shell toggles `active`); reset to a blank search each time it's shown.
  useEffect(() => {
    if (!active) return;
    setQuery('');
    setResults([]);
    setSel(0);
    setStatus('type a query · ⏎ search · tab mode');
    if (inputRef.current) inputRef.current.value = '';
  }, [active]);

  useEffect(() => {
    if (!active) return; // hidden — don't fetch
    if (!query.trim()) {
      setResults([]);
      setStatus('type a query · ⏎ search · tab mode');
      return;
    }
    if (!daemonUrl) {
      setStatus('search needs the daemon (start it / open the graph once)');
      return;
    }
    let alive = true;
    setStatus('searching…');
    void (async () => {
      try {
        const url = new URL(`${daemonUrl}/api/search`);
        url.searchParams.set('q', query);
        const mode = apiMode(uiMode);
        if (mode !== 'index') url.searchParams.set('mode', mode);
        if (defaultType) url.searchParams.set('type', defaultType);
        url.searchParams.set('limit', '40');
        const res = await fetch(url);
        const j = (await res.json()) as {
          items?: Array<{ path: string; title: string; score?: number; snippet?: string; status?: string; type?: string }>;
          available?: boolean;
          reason?: string;
        };
        if (!alive) return;
        if (j.available === false) {
          setResults([]);
          setSel(0);
          setStatus(j.reason ? j.reason : 'search backend unavailable');
          return;
        }
        const items: SearchResult[] = (j.items ?? []).map((x) => ({
          path: x.path,
          title: x.title || x.path.split('/').pop() || x.path,
          folder: folderOf(x.path),
          score: x.score,
          snippet: x.snippet,
          status: x.status,
          type: x.type,
        }));
        setResults(items);
        setSel(0);
        setStatus(items.length ? `${items.length} results` : 'no matches');
      } catch {
        if (alive) setStatus('search failed');
      }
    })();
    return () => {
      alive = false;
    };
  }, [active, query, daemonUrl, defaultType, uiMode]);

  // Group results by category → subcategory, preserving rank throughout: the top result's
  // category leads, and within it the top result's subcategory leads. `sel` indexes here.
  const grouped = useMemo(() => {
    const cats: string[] = [];
    const byCat = new Map<string, SearchResult[]>();
    for (const r of results) {
      const c = categoryOf(r.path);
      let arr = byCat.get(c);
      if (!arr) {
        byCat.set(c, (arr = []));
        cats.push(c);
      }
      arr.push(r);
    }
    const out: { result: SearchResult; cat: string; sub: string; firstOfCat: boolean; firstOfSub: boolean }[] = [];
    for (const cat of cats) {
      const subs: string[] = [];
      const bySub = new Map<string, SearchResult[]>();
      for (const r of byCat.get(cat) ?? []) {
        const s = subcategoryOf(r);
        let arr = bySub.get(s);
        if (!arr) {
          bySub.set(s, (arr = []));
          subs.push(s);
        }
        arr.push(r);
      }
      let firstCat = true;
      for (const sub of subs) {
        let firstSub = true;
        for (const r of bySub.get(sub) ?? []) {
          out.push({ result: r, cat, sub, firstOfCat: firstCat, firstOfSub: firstSub });
          firstCat = false;
          firstSub = false;
        }
      }
    }
    return out;
  }, [results]);

  useKeyboard((key: { name?: string; ctrl?: boolean }) => {
    if (!active) return; // mounted-but-hidden
    const n = (key.name ?? '').toLowerCase();
    if (n === 'escape') return onClose();
    if (n === 'tab') {
      setUiMode((cur) => {
        const i = UI_MODES.indexOf(cur);
        return UI_MODES[(i + 1) % UI_MODES.length]!;
      });
      return;
    }
    if (n === 'up') return setSel((s) => Math.max(0, s - 1));
    if (n === 'down') return setSel((s) => Math.min(grouped.length - 1, s + 1));
    if (n === 'return' || n === 'enter') {
      const v = inputRef.current?.value ?? '';
      if (v.trim() !== query.trim()) return setQuery(v);
      const r = grouped[sel]?.result;
      if (r) return onPick(r.path);
      return;
    }
  });

  const width = Math.min(dims.width - 4, 110);
  const left = Math.max(0, Math.floor((dims.width - width) / 2));
  const height = Math.max(8, dims.height - 4);
  const top = 1;
  const listRows = Math.max(2, height - 6);

  // Display rows = category + subcategory headers interleaved with results; cursor (sel) is a result index.
  type DRow =
    | { kind: 'cat'; cat: string }
    | { kind: 'sub'; sub: string }
    | { kind: 'result'; r: SearchResult; gi: number };
  const display: DRow[] = [];
  grouped.forEach((g, gi) => {
    if (g.firstOfCat) display.push({ kind: 'cat', cat: g.cat });
    if (g.firstOfSub) display.push({ kind: 'sub', sub: g.sub });
    display.push({ kind: 'result', r: g.result, gi });
  });
  const curDisplay = Math.max(0, display.findIndex((d) => d.kind === 'result' && d.gi === sel));
  const dOffset = Math.max(0, Math.min(curDisplay - Math.floor(listRows / 2), Math.max(0, display.length - listRows)));
  const shown = display.slice(dOffset, dOffset + listRows);

  const modeHint = modeLabel(uiMode);

  return (
    <box
      visible={active}
      position="absolute"
      left={left}
      top={top}
      width={width}
      height={height}
      zIndex={200}
      border
      borderStyle="rounded"
      borderColor={t.borderActive}
      backgroundColor={t.background}
      title=" Search "
      titleAlignment="center"
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <input
        ref={inputRef as never}
        focused={active}
        placeholder={defaultType ? `search ${defaultType}s + knowledge…` : 'search…'}
        backgroundColor={t.background}
        textColor={t.foreground}
      />
      {/* Status + mode: always paint opaque background so prior glyphs clear (stale-cell craft). */}
      <box flexShrink={0} backgroundColor={t.background}>
        <text fg={t.muted}>{`${status}  ·  ${modeHint}  ·  tab cycles mode`}</text>
      </box>

      <box flexDirection="column" flexGrow={1} backgroundColor={t.background}>
        {/* FIXED ROW SLOTS: a constant `listRows` count of boxes keyed by slot index. */}
        {Array.from({ length: listRows }, (_, vi) => {
          const d = shown[vi];
          let main = ' ';
          let mainFg = t.background;
          let right = '';
          let bg = t.background;
          let onOver: (() => void) | undefined;
          let onDown: (() => void) | undefined;
          if (d?.kind === 'cat') {
            main = d.cat.toUpperCase();
            mainFg = t.primary;
          } else if (d?.kind === 'sub') {
            main = `  ${d.sub}`;
            mainFg = t.secondary;
          } else if (d?.kind === 'result') {
            const hi = d.gi === sel;
            const gi = d.gi;
            const path = d.r.path;
            main = `${hi ? '    › ' : '      '}${d.r.title.slice(0, Math.max(8, width - 30))}`;
            mainFg = hi ? t.primary : t.foreground;
            right = d.r.score != null ? `${Math.round(d.r.score * 100)}%` : '';
            bg = hi ? t.selection : t.background;
            onOver = () => setSel(gi);
            onDown = () => onPick(path);
          }
          return (
            <box
              key={vi}
              flexDirection="row"
              backgroundColor={bg}
              onMouseOver={onOver}
              onMouseDown={onDown}
            >
              <text fg={mainFg}>{main}</text>
              <box flexGrow={1} backgroundColor={bg} />
              {right ? <text fg={t.muted}>{right}</text> : <text fg={t.background}>{' '}</text>}
            </box>
          );
        })}
      </box>
    </box>
  );
}
