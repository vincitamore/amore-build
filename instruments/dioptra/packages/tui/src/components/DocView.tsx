import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readFileSync, writeFileSync } from 'node:fs';
import { useKeyboard, useRenderer } from '@opentui/react';
import { extractTitle, readDoc, writeDoc, type Frontmatter } from '@selene/regula';
import { resolveOrgRoot } from '../daemon';
import { dlog, tickRender } from '../debug';
import { usePalette, useTheme } from '../ThemeProvider';
import { codeSyntax, filetypeOf, isMarkdown } from '../md';
import { MarkdownView } from './MarkdownView';
import { copyText } from '../clipboard';
import { exportPdf, type PdfDoc } from '../pdf-export';
import { ExportModal, type ExportChoices } from './ExportModal';
import { Panel } from './Panel';
import { LinksModal, type LinkEntry } from './Modal';
import { docJumpInfo } from '../doc-jump';
import { docViewHeaderLabel, pathBaseName } from './doc-view-header';

/** Minimal shape of the TextareaRenderable ref we touch (EditBuffer + focus). */
interface TextareaHandle {
  editBuffer?: { getText(): string; setText(text: string): void };
  focus?: () => void;
}

interface DocViewProps {
  /** org-relative (or absolute, for cross-tree search hits) path of the document. */
  path: string;
  /** Daemon URL — enables the backlinks/outbound links panel (`b`). Org markdown docs only. */
  daemonUrl?: string | null;
  /** When false, ignore keyboard (a shell overlay owns it). */
  inputActive?: boolean;
  /** Esc at the root of the navigation stack. */
  onClose?: () => void;
  /** After a successful save (so the list can refresh). */
  onSaved?: () => void;
  /** Reports when an editor/modal owns input, so the shell yields global nav. */
  onEditingChange?: (busy: boolean) => void;
  /** Jump to the member that owns this doc, with the item focused — set only for the GLOBAL doc
   *  (opened from graph/dashboard/search). When set, actionable docs show a `g` hint to go act. */
  onJump?: (path: string) => void;
}

const isAbsolute = (p: string) => /^([a-zA-Z]:|\/|\\)/.test(p);
const baseName = pathBaseName;

/**
 * The one unified FILE surface — view + edit + link-navigation — every member embeds.
 * Routes by extension: `.md` renders through our custom `MarkdownView` (themed); source files
 * render through `<code>` with tree-sitter highlighting (TS/JS/Zig; plain otherwise) and
 * are read/written raw (no frontmatter). `e` edits (`<textarea>`, Ctrl+S saves), `b` opens
 * resolved links (markdown docs) and following one pushes a nav stack (Esc pops, then closes).
 */
export function DocView({ path, daemonUrl, inputActive = true, onClose, onSaved, onEditingChange, onJump }: DocViewProps) {
  const p = usePalette();
  const { themeName } = useTheme(); // the PDF export inks with the active theme's accents
  const renderer = useRenderer();
  const codeSyn = useMemo(() => codeSyntax(p), [p]);
  const root = useMemo(() => resolveOrgRoot(), []);

  const [stack, setStack] = useState<string[]>([path]);
  useEffect(() => {
    setStack([path]); // host opened a different doc
  }, [path]);
  const cur = stack[stack.length - 1];
  const abs = useMemo(() => (isAbsolute(cur) ? cur : `${root}/${cur}`), [root, cur]);
  const isMd = isMarkdown(cur);
  const ft = filetypeOf(cur);
  tickRender('DocView'); // watch this rate — it should NOT track a busy parent (e.g. Forge's tree churn)

  const [fm, setFm] = useState<Frontmatter | null>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [links, setLinks] = useState<LinkEntry[]>([]);
  // Raw resolved outbound links (target-as-written → resolved path), kept in a ref so the wikilink
  // follower can be a STABLE callback (empty-dep useCallback) — passing a fresh identity to the
  // memo-sensitive MarkdownView on every render would defeat its re-render discipline.
  const outboundRef = useRef<Array<{ resolvedPath: string; target: string }>>([]);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  const [pdfMsg, setPdfMsg] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => {
    if (!pdfMsg || pdfMsg === 'exporting PDF…') return; // hold the progress line; auto-clear the result
    const id = setTimeout(() => setPdfMsg(null), 5000);
    return () => clearTimeout(id);
  }, [pdfMsg]);
  const taRef = useRef<TextareaHandle | null>(null);

  useEffect(() => {
    try {
      dlog('docview', `read ${cur}`); // breadcrumb BEFORE the read+render — survives a native segfault
      if (isMarkdown(cur)) {
        const doc = readDoc(abs);
        setFm(doc.frontmatter);
        setBody(doc.content);
      } else {
        setBody(readFileSync(abs, 'utf8'));
        setFm(null);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'could not read file');
      setFm(null);
      setBody('');
    }
    setEditing(false);
    setDirty(false);
    setLinksOpen(false);
  }, [abs]);

  // Resolved links for the current markdown doc (org-relative only).
  useEffect(() => {
    if (!daemonUrl || isAbsolute(cur) || !isMarkdown(cur)) {
      setLinks([]);
      outboundRef.current = [];
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`${daemonUrl}/api/files/${encodeURIComponent(cur)}`);
        const j = (await res.json()) as {
          resolvedOutbound?: Array<{ resolvedPath?: string; target: string; title?: string }>;
          resolvedBacklinks?: Array<{ path: string; title?: string }>;
        };
        if (!alive) return;
        const resolved = (j.resolvedOutbound ?? []).filter((o) => o.resolvedPath) as Array<{ resolvedPath: string; target: string; title?: string }>;
        outboundRef.current = resolved.map((o) => ({ resolvedPath: o.resolvedPath, target: o.target }));
        const out: LinkEntry[] = resolved.map((o) => ({ label: o.title || o.target, path: o.resolvedPath, dir: '→' as const }));
        const back: LinkEntry[] = (j.resolvedBacklinks ?? []).map((b) => ({ label: b.title || b.path, path: b.path, dir: '←' as const }));
        setLinks([...out, ...back]);
      } catch {
        if (alive) {
          setLinks([]);
          outboundRef.current = [];
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [cur, daemonUrl]);

  // Follow a wikilink clicked in the MarkdownView: match its raw target against the daemon-resolved
  // outbound links (exact target-as-written, then stem/basename), and push the resolved path onto
  // the same nav stack `b` uses. No match (e.g. an unresolved link, or an absolute-path doc whose
  // outbound links aren't fetched) → a quiet no-op; we never invent a resolver. Stable identity
  // (reads the ref, drives the stable `setStack`) so MarkdownView isn't re-rendered per DocView tick.
  const followWikilink = useCallback((raw: string) => {
    const t = raw.trim();
    if (!t) return;
    const norm = (s: string) => s.replace(/\.md$/i, '').toLowerCase();
    const stem = (s: string) => (s.split(/[\\/]/).pop() || s).replace(/\.md$/i, '').toLowerCase();
    const ob = outboundRef.current;
    const hit =
      ob.find((o) => norm(o.target) === norm(t)) ??
      ob.find((o) => stem(o.target) === stem(t)) ??
      ob.find((o) => stem(o.resolvedPath) === stem(t));
    if (hit) {
      setLinksOpen(false);
      setStack((s) => [...s, hit.resolvedPath]);
    }
  }, []);

  // On entering edit, seed the textarea with the current body + focus it.
  useEffect(() => {
    if (editing && taRef.current?.editBuffer) {
      taRef.current.editBuffer.setText(body);
      taRef.current.focus?.();
    }
  }, [editing, body]);

  // Report when an editor/modal has focus so the shell yields global nav.
  useEffect(() => {
    onEditingChange?.(editing || linksOpen || exportOpen);
  }, [editing, linksOpen, exportOpen]);

  // Syntax HIGHLIGHTING (tree-sitter) can choke the native cell renderer on pathological input:
  // a very long single line (minified code = thousands of tokens on one physical line) or a
  // multi-MB file. When that risk is present, render PLAIN text instead — the FULL content, still
  // fully readable, still editable. We degrade the coloring, never block viewing or editing.
  // Markdown word-wraps prose, so its long-line ceiling is far higher than code's. (The earlier
  // size-gate that muted/truncated/locked large files was wrong — access is not the thing at risk.)
  const highlightSafe = useMemo(() => {
    if (body.length > 1_500_000) return false;
    let maxLine = 0;
    let start = 0;
    for (let i = 0; i <= body.length; i++) {
      if (i === body.length || body[i] === '\n') {
        if (i - start > maxLine) maxLine = i - start;
        start = i + 1;
      }
    }
    return maxLine <= (isMd ? 100_000 : 8_000);
  }, [body, isMd]);
  const canEdit = isMd ? !!fm : !error; // editing is a plain textarea — never gated on size

  // Runs AFTER the native render commits. `read X` with no following `shown X` in the debug log
  // means the native render of X (markdown/code tree-sitter) crashed — the document to inspect.
  useEffect(() => {
    if (error || editing) return;
    dlog('docview', `shown ${baseName(cur)} kind=${!highlightSafe ? 'plain' : isMd ? 'md' : 'code'} bytes=${body.length}`);
  }, [cur, body, highlightSafe, isMd, editing, error]);
  const save = () => {
    const next = taRef.current?.editBuffer?.getText() ?? body;
    try {
      if (isMd) {
        if (!fm) return;
        writeDoc(abs, fm, next.endsWith('\n') ? next : `${next}\n`);
      } else {
        writeFileSync(abs, next, 'utf8');
      }
      setBody(next);
      setEditing(false);
      setDirty(false);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed');
    }
  };

  const navigate = (target: string) => {
    setLinksOpen(false);
    setStack((s) => [...s, target]);
  };
  const back = () => {
    if (stack.length > 1) setStack((s) => s.slice(0, -1));
    else onClose?.();
  };

  useKeyboard((key: { name?: string; ctrl?: boolean }) => {
    if (!inputActive || linksOpen || exportOpen) return; // a modal owns input while open
    const n = (key.name ?? '').toLowerCase();
    if (editing) {
      if (key.ctrl && n === 's') return save();
      if (n === 'escape') return setEditing(false);
      return; // all other keys belong to the focused textarea
    }
    if (n === 'e' && canEdit) return setEditing(true);
    if (n === 'g' && jump) return onJump?.(cur); // go to the owning member with this item focused
    if (n === 'b' && links.length > 0) return setLinksOpen(true);
    // markdown copy is the MarkdownView's drag-select + `y`; for code/plain, `y` copies the native
    // drag-selection if any (content-precise — no border junk), else the whole clean body.
    if (n === 'y' && !isMd && body) {
      const sel = renderer.getSelection()?.getSelectedText() ?? '';
      const ok = copyText(sel.trim() ? sel : body);
      renderer.clearSelection();
      return setCopied(ok);
    }
    // p → open the export options modal (theme / page / opt-in frontmatter+links), then export.
    if (n === 'p' && isMd && body) return setExportOpen(true);
    if (n === 'escape') return back();
  });

  const runExport = (choices: ExportChoices) => {
    setExportOpen(false);
    setPdfMsg('exporting PDF…');
    const pdoc: PdfDoc = {
      title: extractTitle(body, abs),
      content: body,
      path: cur,
      frontmatter: fm as Record<string, unknown> | null,
      links: links.map((l) => ({ label: l.label, dir: l.dir })),
    };
    void exportPdf(pdoc, choices).then((r) => setPdfMsg(r.ok ? `✓ PDF → ${r.path}` : `PDF failed: ${r.error}`));
  };

  // Panel header: full file name (basename+ext) for copy-paste — not H1/title.
  // PDF export still uses extractTitle for document title (below in runExport).
  const headerLabel = docViewHeaderLabel(cur, { depth: stack.length - 1, editing });
  const type = isMd ? (fm?.type as string) ?? '' : ft ?? (cur.split('.').pop() ?? 'text');
  const depth = stack.length - 1;
  const linkCount = links.length;
  // Only the GLOBAL doc (Shell passes onJump) offers a jump to the owning member; and only for
  // actionable types (task/inbox/reminder). Suppressed at nav-stack depth (you followed a link away).
  const jump = onJump && depth === 0 ? docJumpInfo(cur) : null;

  // Frontmatter surface — a compact metadata strip above the body (type · status · dates + tags),
  // so the doc's structured fields are visible (and you can tell tags need editing). Markdown only.
  const fmStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const st = fm?.status as string | undefined;
  const statusColor =
    st === 'active' ? p.success : st === 'blocked' ? p.error : st === 'paused' ? p.warning : st === 'review' ? p.info : st === 'complete' ? p.muted : p.secondary;
  const tagList = isMd && fm && Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
  const hasMeta = isMd && !!fm && (!!fm.type || !!fm.status || !!fm.created || tagList.length > 0);

  if (error) {
    return (
      <Panel title={docViewHeaderLabel(cur)} flexGrow={1}>
        <text fg={p.error}>{error}</text>
        <text fg={p.muted}>esc back</text>
      </Panel>
    );
  }

  return (
    <Panel title={headerLabel} headerRight={type} flexGrow={1} active={editing}>
      {editing ? (
        <box flexDirection="column" flexGrow={1}>
          <textarea
            ref={taRef as never}
            flexGrow={1}
            backgroundColor={p.background}
            textColor={p.foreground}
            focusedBackgroundColor={p.background}
            focusedTextColor={p.foreground}
            onContentChange={() => setDirty(true)}
          />
          <box flexShrink={0}>
            <text fg={p.muted}>{`${dirty ? '✎ ' : ''}ctrl+s save · esc cancel`}</text>
          </box>
        </box>
      ) : (
        <box flexDirection="column" flexGrow={1}>
          {/* Frontmatter strip — the doc's structured fields, always visible above the body. */}
          {hasMeta ? (
            <box flexDirection="column" flexShrink={0} marginBottom={1}>
              <box flexDirection="row">
                {fm?.type ? <text fg={p.info}>{fmStr(fm.type)}</text> : null}
                {st ? <text fg={statusColor}>{`  ${st}`}</text> : null}
                {fm?.created ? <text fg={p.muted}>{`  ${fmStr(fm.created)}`}</text> : null}
                {fm?.updated && fm.updated !== fm.created ? <text fg={p.muted}>{`  ↻ ${fmStr(fm.updated)}`}</text> : null}
                {fm?.pipeline ? <text fg={p.muted}>{`  ${fmStr(fm.pipeline)}`}</text> : null}
              </box>
              {tagList.length ? <text fg={p.secondary}>{tagList.map((t) => `#${t}`).join('  ')}</text> : null}
            </box>
          ) : null}
          {/* focused only when this view is the active input — so a DocView embedded as a
              side detail pane (e.g. Forge) doesn't also capture arrow keys from a focused
              sibling list. Full-screen members pass inputActive=true → focused as before. */}
          {!highlightSafe ? (
            <scrollbox flexGrow={1} focused={inputActive}>
              <text fg={p.foreground}>{body}</text>
            </scrollbox>
          ) : isMd ? (
            // Our own markdown renderer (windowed, scrollable) — NOT OpenTUI's native `<markdown>`,
            // which segfaults the Zig renderer on content changes / long docs.
            <MarkdownView body={body} inputActive={inputActive && !linksOpen && !exportOpen} onFollowWikilink={followWikilink} />
          ) : (
            <scrollbox flexGrow={1} focused={inputActive}>
              <code content={body} filetype={ft} syntaxStyle={codeSyn} />
            </scrollbox>
          )}
          <box flexDirection="column" flexShrink={0}>
            {/* Action-surface hint: this doc lives on a member with lifecycle actions — press `g`
                to jump there with it focused, then use the listed keys. (Global doc only.) */}
            {jump ? (
              <text fg={p.primary}>{`▸ g → act on ${jump.member}:  ${jump.actions}`}</text>
            ) : null}
            <text fg={pdfMsg ? (pdfMsg.startsWith('✓') ? p.success : pdfMsg === 'exporting PDF…' ? p.info : p.error) : copied ? p.success : p.muted}>
              {pdfMsg
                ? pdfMsg
                : copied
                  ? '✓ copied to clipboard'
                  : `${canEdit ? 'e edit · ' : ''}${jump ? 'g act · ' : ''}${linkCount > 0 ? `b links (${linkCount}) · ` : ''}${isMd ? 'p pdf · ' : 'y copy · '}${!highlightSafe ? 'plain·large · ' : ''}esc ${depth > 0 ? 'back' : 'close'} · ↑↓ scroll`}
            </text>
          </box>
        </box>
      )}
      <LinksModal active={linksOpen} entries={links} onPick={navigate} onCancel={() => setLinksOpen(false)} />
      {/* Kept mounted; `active` toggles visibility — a modal MOUNT is the OpenTUI teardown crash. */}
      <ExportModal active={exportOpen} initialTheme={themeName} onExport={runExport} onCancel={() => setExportOpen(false)} />
    </Panel>
  );
}
