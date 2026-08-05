import { basename, join, resolve as resolvePath } from 'path';
import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { readDoc, tryReadDoc, writeDoc } from './doc';
import { localIso, relPath, slugify, today } from './util';
import { RegulaError } from './errors';
import {
  INBOX_TYPES,
  INBOX_TERMINAL_STATUSES,
  LIFECYCLED_INBOX_TYPES,
  inboxFolder,
  type Frontmatter,
  type InboxStatus,
  type InboxType,
} from './schema';

// ─── Capture ───────────────────────────────────────────────────────────────

export interface CaptureInput {
  content: string;
  title?: string;
  source?: string;
  tags?: string[];
  /** ISO timestamp source (injectable for tests); defaults to now. */
  nowIso?: string;
}

/** Quick-capture into inbox/captures/ (timestamped filename; no lifecycle — triage-to-empty). */
export function captureInbox(orgRoot: string, input: CaptureInput): { path: string } {
  // Local stamp, not toISOString(): a 7pm capture should carry today's date, not UTC-tomorrow's.
  const iso = input.nowIso ?? localIso();
  const stamp = iso.replace(/[:.]/g, '-').slice(0, 19);
  const titleSlug = input.title ? `-${slugify(input.title)}` : '';
  const dir = join(orgRoot, 'inbox', 'captures');
  const filePath = join(dir, `${stamp}${titleSlug}.md`);
  mkdirSync(dir, { recursive: true });
  if (existsSync(filePath)) {
    throw new RegulaError('EXISTS', `Capture already exists: ${relPath(orgRoot, filePath)}`);
  }
  // Climb over examen: source defaults to a valid schema value ('capture'), not 'mcp'.
  const frontmatter: Frontmatter = {
    type: 'inbox',
    created: today(),
    source: input.source ?? 'capture',
    tags: input.tags ?? [],
  };
  const title = input.title ?? `Capture ${stamp}`;
  writeDoc(filePath, frontmatter, `# ${title}\n\n${input.content}\n`);
  return { path: relPath(orgRoot, filePath) };
}

// ─── List ──────────────────────────────────────────────────────────────────

export interface InboxListItem {
  path: string;
  type: string;
  title: string;
  status?: string;
  source?: string;
  created?: string;
  resolved: boolean;
  tags: string[];
}

function inboxTitle(content: string, filePath: string): string {
  const h1 = content.match(/^#\s+(.+)$/m);
  return h1 ? h1[1].trim() : basename(filePath, '.md');
}

function readItem(orgRoot: string, filePath: string, type: string, resolved: boolean): InboxListItem | null {
  const doc = tryReadDoc(filePath); // skip a malformed file rather than break the whole listing
  if (!doc) return null;
  const fm = doc.frontmatter;
  return {
    path: relPath(orgRoot, filePath),
    type,
    title: inboxTitle(doc.content, filePath),
    status: fm.status,
    source: fm.source as string | undefined,
    created: fm.created,
    resolved,
    tags: fm.tags ?? [],
  };
}

/**
 * List inbox items, newest first. By DEFAULT returns only the OPEN queue —
 * the top level of each inbox/<type>/ — and excludes inbox/<type>/resolved/.
 *
 * A recursive scan would include resolved/ items too; the skip-list excludes
 * them deliberately. The open queue is what orientation counts read.
 */
export function listInbox(
  orgRoot: string,
  opts: { includeResolved?: boolean; type?: InboxType } = {}
): InboxListItem[] {
  const inboxRoot = join(orgRoot, 'inbox');
  if (!existsSync(inboxRoot)) return [];
  const types = opts.type ? [opts.type] : INBOX_TYPES;
  const items: InboxListItem[] = [];

  for (const t of types) {
    const dir = join(inboxRoot, t);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'resolved' && opts.includeResolved) {
          const rdir = join(dir, 'resolved');
          for (const f of readdirSync(rdir)) {
            if (f.endsWith('.md')) {
              const item = readItem(orgRoot, join(rdir, f), t, true);
              if (item) items.push(item);
            }
          }
        }
        continue; // skip resolved/ (unless included above) and any other subdir
      }
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const item = readItem(orgRoot, join(dir, entry.name), t, false);
        if (item) items.push(item);
      }
    }
  }
  return items.sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
}

export interface InboxDetail {
  path: string;
  type: string;
  title: string;
  frontmatter: Frontmatter;
  content: string;
}

/** Read one inbox item (by org-relative path — inbox items have no cross-type slug lookup). */
export function getInbox(orgRoot: string, ref: string): InboxDetail {
  const filePath = join(orgRoot, ref);
  const doc = readDoc(filePath); // throws NOT_FOUND
  if (doc.frontmatter.type !== 'inbox') {
    throw new RegulaError('USAGE', `Not an inbox item (type: ${String(doc.frontmatter.type)}): ${ref}`);
  }
  const segments = relPath(orgRoot, filePath).split('/');
  const type = segments[1] ?? 'captures'; // inbox/<type>/...
  return {
    path: relPath(orgRoot, filePath),
    type,
    title: inboxTitle(doc.content, filePath),
    frontmatter: doc.frontmatter,
    content: doc.content,
  };
}

// ─── Resolve (the lifecycle flip — examen has no such verb) ──────────────────

export interface ResolveInboxInput {
  /** Terminal status; defaults to 'resolved'. */
  status?: (typeof INBOX_TERMINAL_STATUSES)[number];
  /** One-line resolution (should carry a wikilink to where it landed). */
  resolution?: string;
  /** Resolution date (the date the resolving work shipped); defaults to today. */
  resolvedDate?: string;
}

export interface ResolveInboxResult {
  from: string;
  to: string;
  oldPath: string;
  newPath: string;
}

/**
 * Resolve a lifecycle'd inbox item (ideas/decisions/investigations): set the terminal
 * status + `resolved` date + one-line `resolution`, and move it to inbox/<type>/resolved/.
 * Implements the inbox lifecycle discipline — which examen never had.
 */
export function resolveInbox(
  orgRoot: string,
  ref: string,
  input: ResolveInboxInput = {}
): ResolveInboxResult {
  const status: InboxStatus = input.status ?? 'resolved';
  if (!(INBOX_TERMINAL_STATUSES as readonly string[]).includes(status)) {
    throw new RegulaError('USAGE', `Not a terminal inbox status: ${status}`);
  }
  const filePath = join(orgRoot, ref);
  const doc = readDoc(filePath); // throws NOT_FOUND
  if (doc.frontmatter.type !== 'inbox') {
    throw new RegulaError('USAGE', `Not an inbox item (type: ${String(doc.frontmatter.type)}): ${ref}`);
  }
  const segments = relPath(orgRoot, filePath).split('/');
  const type = segments[1] as InboxType; // inbox/<type>/...
  if (!(LIFECYCLED_INBOX_TYPES as readonly string[]).includes(type)) {
    throw new RegulaError(
      'USAGE',
      `Inbox type '${type}' is not lifecycle'd — only ideas/decisions/investigations resolve`
    );
  }

  const from = String(doc.frontmatter.status ?? 'open');

  // Conflict check BEFORE any write (see setTaskStatus). An item already in resolved/ is a
  // legitimate re-resolve (new status/resolution note) — patch in place, no move.
  const targetDir = join(orgRoot, inboxFolder(type, status));
  const targetPath = join(targetDir, basename(filePath));
  const moving = resolvePath(targetPath) !== resolvePath(filePath);
  if (moving && existsSync(targetPath)) {
    throw new RegulaError('CONFLICT', `Move target already exists: ${relPath(orgRoot, targetPath)}`);
  }

  doc.frontmatter.status = status;
  doc.frontmatter.resolved = input.resolvedDate ?? today();
  if (input.resolution !== undefined) doc.frontmatter.resolution = input.resolution;
  writeDoc(filePath, doc.frontmatter, doc.content);

  if (moving) {
    mkdirSync(targetDir, { recursive: true });
    renameSync(filePath, targetPath);
  }

  return {
    from,
    to: status,
    oldPath: relPath(orgRoot, filePath),
    newPath: relPath(orgRoot, moving ? targetPath : filePath),
  };
}

// ─── Triage / archive (file moves within / out of inbox) ─────────────────────

export interface MoveInboxResult {
  oldPath: string;
  newPath: string;
}

/** Triage: move an inbox item from its current subtype folder to another (inbox/<target>/). */
export function moveInbox(orgRoot: string, ref: string, targetType: InboxType): MoveInboxResult {
  if (!(INBOX_TYPES as readonly string[]).includes(targetType)) {
    throw new RegulaError('USAGE', `Not an inbox type: ${targetType}`);
  }
  const filePath = join(orgRoot, ref);
  const doc = readDoc(filePath); // throws NOT_FOUND
  if (doc.frontmatter.type !== 'inbox') {
    throw new RegulaError('USAGE', `Not an inbox item (type: ${String(doc.frontmatter.type)}): ${ref}`);
  }
  const targetDir = join(orgRoot, 'inbox', targetType);
  const targetPath = join(targetDir, basename(filePath));
  if (targetPath === filePath) {
    return { oldPath: relPath(orgRoot, filePath), newPath: relPath(orgRoot, filePath) }; // already there
  }
  mkdirSync(targetDir, { recursive: true });
  if (existsSync(targetPath)) {
    throw new RegulaError('CONFLICT', `Move target already exists: ${relPath(orgRoot, targetPath)}`);
  }
  renameSync(filePath, targetPath);
  return { oldPath: relPath(orgRoot, filePath), newPath: relPath(orgRoot, targetPath) };
}

/** Archive an inbox item out of the queue to archive/inbox/<type>/ (provenance preserved). */
export function archiveInbox(orgRoot: string, ref: string): MoveInboxResult {
  const filePath = join(orgRoot, ref);
  if (!existsSync(filePath)) {
    throw new RegulaError('NOT_FOUND', `File not found: ${ref}`);
  }
  const segments = relPath(orgRoot, filePath).split('/');
  // Refuse a path outside inbox/<type>/ — without this, an arbitrary ref (e.g. tasks/foo.md) would be
  // shoveled into archive/inbox/<segments[1]> under a bogus type. Archive is an inbox-only verb.
  if (segments[0] !== 'inbox' || !(INBOX_TYPES as readonly string[]).includes(segments[1] ?? '')) {
    throw new RegulaError('USAGE', `Not an inbox item — archive only accepts inbox/<type>/… paths: ${ref}`);
  }
  const type = segments[1]; // inbox/<type>/...
  const targetDir = join(orgRoot, 'archive', 'inbox', type);
  const targetPath = join(targetDir, basename(filePath));
  mkdirSync(targetDir, { recursive: true });
  if (existsSync(targetPath)) {
    throw new RegulaError('CONFLICT', `Archive target already exists: ${relPath(orgRoot, targetPath)}`);
  }
  renameSync(filePath, targetPath);
  return { oldPath: relPath(orgRoot, filePath), newPath: relPath(orgRoot, targetPath) };
}
