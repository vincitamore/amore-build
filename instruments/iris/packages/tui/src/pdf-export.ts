import { marked } from 'marked';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_THEME, THEMES, type ColorKey } from './theme';

/**
 * Export a markdown document to a styled, page-break-aware PDF via a headless browser.
 *
 * The pipeline mirrors the Tauri ForgeView's styled print (title + metadata panel + TOC + prose +
 * backlinks) but is self-contained: `marked` renders the markdown to HTML, we wrap it in a print
 * stylesheet, and headless Edge/Chrome (`--print-to-pdf`) paginates it. Page breaks are handled by
 * native CSS paged-media rules (`break-inside/after: avoid`, `orphans`/`widows`) — the browser's
 * print engine honours them, so headings never strand at a page bottom and code blocks / tables /
 * figures don't split, with no manual height measurement.
 */

export interface PdfDoc {
  title: string;
  /** Markdown body (frontmatter already stripped). */
  content: string;
  /** org-relative path (shown in metadata). */
  path: string;
  /** Document frontmatter (type/status/tags/created + forge fields), for the metadata panel. */
  frontmatter?: Record<string, unknown> | null;
  /** Resolved outbound/backlinks to list at the end, if available. */
  links?: { label: string; dir: '→' | '←' }[];
}

export interface PdfOptions {
  /** Theme id whose accent colors ink the print (defaults to Horizon, the TUI default). */
  theme?: string;
  pageSize?: 'letter' | 'a4';
  /** Frontmatter metadata panel — OFF by default (internal; opt-in for personal-use exports). */
  includeMetadata?: boolean;
  /** Table of contents — ON by default (not leaky). */
  includeToc?: boolean;
  /** Backlinks/links section — OFF by default (internal org refs; opt-in). */
  includeLinks?: boolean;
  /** Absolute output path; defaults to ~/Downloads/<slug>.pdf (or tmp if no Downloads). */
  outPath?: string;
}

export interface PdfResult {
  ok: boolean;
  path?: string;
  error?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Print-friendly GROUND — white paper + dark ink, ALWAYS, for readability whatever the theme. The
// chosen theme supplies only the accent inks (title/headings, links, status, table headers), so a
// dark TUI theme still prints crisp. Mirrors the Tauri styled-print (theme accents on white).
const NEUTRAL = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  border: '#d7d9de',
  muted: '#6b7280',
  selection: '#f3f4f6', // code / table-header fill
} as const;

/** The chosen theme's accent hex colors (defaults to Horizon, the TUI default). */
export function themeColors(name?: string): Record<ColorKey, string> {
  return (THEMES[name ?? DEFAULT_THEME] ?? THEMES[DEFAULT_THEME]).colors;
}

function statusInk(c: Record<ColorKey, string>): Record<string, string> {
  return { active: c.success, complete: NEUTRAL.muted, blocked: c.error, paused: c.warning, review: c.info, incubating: c.secondary };
}

function printCss(pageSize: 'letter' | 'a4', c: Record<ColorKey, string>): string {
  return `
  @page { size: ${pageSize}; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: ${NEUTRAL.background}; }
  body {
    color: ${NEUTRAL.foreground};
    font-family: 'Georgia', 'Iowan Old Style', 'Palatino Linotype', serif;
    font-size: 11pt;
    line-height: 1.55;
    padding: 0.75in;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  code, pre { font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, 'Courier New', monospace; }

  .doc-title {
    font-size: 21pt; font-weight: 700; color: ${c.primary};
    border-bottom: 2px solid ${NEUTRAL.border}; padding-bottom: 0.35rem; margin: 0 0 1rem 0;
    break-after: avoid; line-height: 1.2;
  }

  .meta { border: 1px solid ${NEUTRAL.border}; border-radius: 3px; padding: 0.6rem 0.8rem; margin-bottom: 1.25rem; break-inside: avoid; }
  .meta-row { display: flex; gap: 1rem; padding: 0.12rem 0; font-size: 9.5pt; font-family: 'JetBrains Mono', Consolas, monospace; }
  .meta-label { color: ${NEUTRAL.muted}; min-width: 6.5em; flex-shrink: 0; font-weight: 700; }
  .meta-value { color: ${NEUTRAL.foreground}; }
  .tags { color: ${c.secondary}; }

  .toc { border: 1px solid ${NEUTRAL.border}; border-radius: 3px; padding: 0.6rem 0.8rem; margin-bottom: 1.5rem; break-inside: avoid; }
  .toc-title { font-weight: 700; font-size: 10pt; color: ${c.primary}; margin-bottom: 0.4rem; letter-spacing: 0.03em; text-transform: uppercase; }
  .toc ul { list-style: none; padding: 0; margin: 0; }
  .toc li { font-size: 9.5pt; line-height: 1.7; }
  .toc a { color: ${NEUTRAL.foreground}; text-decoration: none; }
  .toc .lvl-2 { padding-left: 1.4em; }
  .toc .lvl-3 { padding-left: 2.8em; color: ${NEUTRAL.muted}; }

  .content { font-size: 11pt; line-height: 1.6; }
  .content h1 { font-size: 16pt; color: ${c.primary}; border-bottom: 1px solid ${NEUTRAL.border}; padding-bottom: 0.25rem; margin: 1.6rem 0 0.7rem; break-after: avoid; }
  .content h2 { font-size: 13.5pt; color: ${c.primary}; margin: 1.3rem 0 0.5rem; break-after: avoid; }
  .content h3 { font-size: 11.5pt; color: ${c.secondary}; margin: 1.05rem 0 0.4rem; break-after: avoid; }
  .content h4, .content h5, .content h6 { font-size: 11pt; color: ${c.secondary}; margin: 0.9rem 0 0.35rem; break-after: avoid; }
  .content p { margin: 0.7rem 0; orphans: 3; widows: 3; }
  .content ul, .content ol { margin: 0.5rem 0; padding-left: 1.5em; }
  .content li { margin: 0.2rem 0; }
  .content li > ul, .content li > ol { margin: 0.2rem 0; }
  .content a { color: ${c.info}; text-decoration: none; }
  .content a::after { content: none !important; }
  .content strong { font-weight: 700; }
  .content hr { border: none; border-top: 1px solid ${NEUTRAL.border}; margin: 1.2rem 0; }

  .content code { font-size: 9.5pt; background: ${NEUTRAL.selection}; color: ${c.secondary}; padding: 0.08em 0.32em; border-radius: 2px; }
  .content pre { font-size: 9pt; line-height: 1.42; background: ${NEUTRAL.selection}; border: 1px solid ${NEUTRAL.border}; border-radius: 3px; padding: 0.7rem 0.8rem; margin: 0.9rem 0; white-space: pre-wrap; word-wrap: break-word; overflow: hidden; break-inside: avoid; }
  .content pre code { background: transparent; padding: 0; font-size: inherit; color: ${NEUTRAL.foreground}; }

  .content table { width: 100%; border-collapse: collapse; border: 1px solid ${NEUTRAL.border}; margin: 0.9rem 0; font-size: 9.5pt; table-layout: fixed; word-wrap: break-word; break-inside: avoid; }
  .content th { background: ${NEUTRAL.selection}; color: ${c.primary}; font-weight: 700; padding: 0.35rem 0.5rem; border: 1px solid ${NEUTRAL.border}; text-align: left; }
  .content td { padding: 0.35rem 0.5rem; border: 1px solid ${NEUTRAL.border}; vertical-align: top; }

  .content blockquote { border-left: 3px solid ${c.primary}; padding: 0.1rem 0 0.1rem 1rem; margin: 0.9rem 0; color: ${NEUTRAL.muted}; font-style: italic; break-inside: avoid; }

  .content img { max-width: 100%; max-height: 5.5in; height: auto; border: 1px solid ${NEUTRAL.border}; border-radius: 2px; display: block; margin: 0.9rem auto; }

  .backlinks { border-top: 1px solid ${NEUTRAL.border}; padding-top: 0.9rem; margin-top: 2rem; break-before: avoid; }
  .backlinks-title { font-size: 10pt; color: ${c.secondary}; margin: 0 0 0.4rem; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; }
  .backlinks ul { list-style: none; padding: 0; margin: 0; }
  .backlinks li { font-size: 9.5pt; line-height: 1.6; color: ${NEUTRAL.foreground}; }
  .backlinks .dir { color: ${c.info}; margin-right: 0.4em; }
  `;
}

interface Heading {
  level: number;
  text: string;
  slug: string;
}

function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2].trim(), slug: slugify(m[2]) });
  }
  return out;
}

function tocHtml(headings: Heading[]): string {
  if (headings.length < 2) return ''; // a TOC of one heading is noise
  const items = headings
    .map((h) => `<li class="lvl-${h.level}"><a href="#${h.slug}">${esc(h.text)}</a></li>`)
    .join('\n');
  return `<div class="toc"><div class="toc-title">Contents</div><ul>${items}</ul></div>`;
}

function metadataHtml(doc: PdfDoc, c: Record<ColorKey, string>): string {
  const fm = doc.frontmatter ?? {};
  const sink = statusInk(c);
  const str = (v: unknown) => (v == null ? undefined : typeof v === 'string' ? v : String(v));
  const rows: [string, string | undefined][] = [
    ['Type', str(fm.type)],
    ['Status', str(fm.status)],
    ['Path', doc.path],
    ['Created', str(fm.created)],
    ['Updated', str(fm.updated)],
    ['Pipeline', str(fm.pipeline)],
    ['Recipe', str(fm.recipe)],
    ['Goal', str(fm.goal)],
    ['Role', str(fm.role)],
    ['Triggered By', str(fm['triggered-by'])],
  ];
  const html = rows
    .filter(([, v]) => v)
    .map(([label, v]) => {
      const ink = label === 'Status' ? sink[String(v)] : undefined;
      const valStyle = ink ? ` style="color:${ink};font-weight:700"` : '';
      return `<div class="meta-row"><span class="meta-label">${esc(label)}</span><span class="meta-value"${valStyle}>${esc(String(v))}</span></div>`;
    })
    .join('\n');
  const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : [];
  const tagRow = tags.length
    ? `<div class="meta-row"><span class="meta-label">Tags</span><span class="meta-value tags">${esc(tags.map((t) => `#${t}`).join('  '))}</span></div>`
    : '';
  if (!html && !tagRow) return '';
  return `<div class="meta">${html}${tagRow}</div>`;
}

function backlinksHtml(doc: PdfDoc): string {
  if (!doc.links || doc.links.length === 0) return '';
  const items = doc.links.map((l) => `<li><span class="dir">${l.dir}</span>${esc(l.label)}</li>`).join('\n');
  return `<div class="backlinks"><div class="backlinks-title">Links (${doc.links.length})</div><ul>${items}</ul></div>`;
}

/**
 * Convert `[[wikilink]]` / `[[target|label]]` cross-references to plain readable text — a PDF can't
 * navigate them and the raw target is an internal org path, so this is a scrub (always on): a shared
 * PDF never leaks `[[knowledge/…]]` paths, and even for personal use plain text reads better.
 */
function scrubWikilinks(md: string): string {
  return md.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) =>
    label ? label.trim() : (target.trim().split('/').pop() ?? target).replace(/\.md$/, ''),
  );
}

/** Render markdown → HTML (wikilinks scrubbed), then add slug ids to h1–h3 so TOC anchors resolve. */
function contentHtml(md: string): string {
  const raw = marked.parse(scrubWikilinks(md), { gfm: true, breaks: false, async: false }) as string;
  return raw.replace(/<h([1-3])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => `<h${lvl} id="${slugify(inner)}">${inner}</h${lvl}>`);
}

export function buildHtml(doc: PdfDoc, opts: PdfOptions = {}): string {
  const pageSize = opts.pageSize ?? 'letter';
  const c = themeColors(opts.theme);
  const headings = parseHeadings(doc.content);
  // Shareable by DEFAULT: the frontmatter panel + backlinks are internal-org surfaces, so they're
  // OPT-IN (the export modal turns them on for personal-use exports). The TOC isn't leaky → on.
  const meta = opts.includeMetadata ? metadataHtml(doc, c) : '';
  const toc = opts.includeToc === false ? '' : tocHtml(headings);
  const back = opts.includeLinks ? backlinksHtml(doc) : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(doc.title)}</title>
<style>${printCss(pageSize, c)}</style></head>
<body>
<h1 class="doc-title">${esc(doc.title)}</h1>
${meta}
${toc}
<div class="content">${contentHtml(doc.content)}</div>
${back}
</body></html>`;
}

/** Locate a Chromium-family browser for headless printing. `$IRIS_BROWSER` overrides. */
export function locateBrowser(): string | null {
  const env = process.env.IRIS_BROWSER;
  if (env && existsSync(env)) return env;
  const candidates =
    process.platform === 'win32'
      ? [
          `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
          `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function defaultOutPath(title: string): string {
  const slug = slugify(title) || 'document';
  const downloads = join(homedir(), 'Downloads');
  const dir = existsSync(downloads) ? downloads : tmpdir();
  return join(dir, `${slug}.pdf`);
}

/**
 * Generate the styled PDF. Writes the HTML to a temp file and drives headless Edge/Chrome
 * `--print-to-pdf`. Resolves with the output path, or an error the caller can surface.
 */
export function exportPdf(doc: PdfDoc, opts: PdfOptions = {}): Promise<PdfResult> {
  return new Promise((resolve) => {
    const browser = locateBrowser();
    if (!browser) {
      resolve({ ok: false, error: 'no Chrome/Edge found (set $IRIS_BROWSER)' });
      return;
    }
    const outPath = opts.outPath ?? defaultOutPath(doc.title);
    let htmlPath: string;
    let userDataDir: string;
    let tmpDir: string | null = null;
    // Each export stages a temp dir holding the HTML AND a full browser profile (multiple MB) —
    // it must be removed on every terminal path or %TEMP% bloats per export. The browser can
    // briefly hold the profile after exit/kill on Windows, so a failed remove retries once.
    const cleanup = () => {
      const d = tmpDir;
      if (!d) return;
      tmpDir = null;
      const rm = () => {
        try {
          rmSync(d, { recursive: true, force: true });
          return true;
        } catch {
          return false;
        }
      };
      if (!rm()) setTimeout(rm, 1000);
    };
    try {
      const dir = mkdtempSync(join(tmpdir(), 'iris-pdf-'));
      tmpDir = dir;
      htmlPath = join(dir, 'doc.html');
      userDataDir = join(dir, 'profile'); // a DEDICATED profile — else Edge/Chrome defers to the
      writeFileSync(htmlPath, buildHtml(doc, opts), 'utf8'); // already-running instance and prints nothing
    } catch (e) {
      cleanup();
      resolve({ ok: false, error: e instanceof Error ? e.message : 'could not stage HTML' });
      return;
    }
    const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;
    const args = [
      '--headless=new',
      '--disable-gpu',
      // A fresh profile each run means every run is a "first run"; without these, Edge/Chrome does
      // first-run setup that intermittently races the print → the first couple presses fail.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      `--user-data-dir=${userDataDir}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${outPath}`,
      fileUrl,
    ];
    let settled = false;
    const done = (r: PdfResult) => {
      if (settled) return;
      settled = true;
      cleanup(); // every terminal path settles here — the temp HTML + profile never outlive the export
      resolve(r);
    };
    const child = spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    const tail = () => stderr.trim().split('\n').slice(-2).join(' ').slice(-200);
    const timer = setTimeout(() => {
      try {
        // Kill the TREE — Edge spawns helpers (crashpad) that child.kill() leaves alive, and a
        // surviving helper holds the profile dir open indefinitely (observed live: a zombie pair
        // from a timed-out morning export pinned its temp profile all day). The 1s cleanup retry
        // covers the async kill racing the rmSync.
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
        } else {
          child.kill();
        }
      } catch {
        // already gone
      }
      done(existsSync(outPath) ? { ok: true, path: outPath } : { ok: false, error: `print timed out${stderr ? ` — ${tail()}` : ''}` });
    }, 30_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, error: e.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      // The PDF can lag the process exit slightly (flush) — poll briefly before declaring failure,
      // rather than reporting a spurious miss on a cold run.
      let tries = 0;
      const check = () => {
        if (existsSync(outPath)) return done({ ok: true, path: outPath });
        if (++tries >= 15) return done({ ok: false, error: `browser exited ${code} without a PDF${stderr ? ` — ${tail()}` : ''}` });
        setTimeout(check, 200);
      };
      check();
    });
  });
}
