import { join } from 'path';
import { existsSync, mkdirSync, readdirSync } from 'fs';
import { readDoc, tryReadDoc, writeDoc } from './doc';
import { extractTitle, relPath, slugify, today } from './util';
import { RegulaError } from './errors';
import type { Frontmatter } from './schema';

export interface CreateKnowledgeInput {
  title: string;
  content: string;
  folder?: string;
  tags?: string[];
}

/** Create a knowledge article under knowledge/[folder]/. */
export function createKnowledge(
  orgRoot: string,
  input: CreateKnowledgeInput
): { path: string; slug: string } {
  const slug = slugify(input.title);
  if (!slug) throw new RegulaError('USAGE', 'Knowledge title produced an empty slug');
  const dir = input.folder ? join(orgRoot, 'knowledge', input.folder) : join(orgRoot, 'knowledge');
  const filePath = join(dir, `${slug}.md`);
  if (existsSync(filePath)) {
    throw new RegulaError('EXISTS', `Knowledge article already exists: ${relPath(orgRoot, filePath)}`);
  }
  mkdirSync(dir, { recursive: true });

  // No `title:` field — the knowledge schema (AGENTS.md) has none, and title is derived from the H1
  // everywhere it's read (regula extractTitle + the daemon's legacy parse), so it was dead frontmatter.
  const frontmatter: Frontmatter = {
    type: 'knowledge',
    created: today(),
    updated: today(),
    tags: input.tags ?? [],
  };
  writeDoc(filePath, frontmatter, `# ${input.title}\n\n${input.content}\n`);
  return { path: relPath(orgRoot, filePath), slug };
}

export interface UpdateKnowledgeInput {
  content?: string;
  append?: string;
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
}

/** Update a knowledge article (by org-relative path). Always stamps `updated`. */
export function updateKnowledge(
  orgRoot: string,
  ref: string,
  changes: UpdateKnowledgeInput
): { path: string } {
  const filePath = join(orgRoot, ref);
  const doc = readDoc(filePath); // throws NOT_FOUND if absent
  // Climb over examen: refuse to update a non-knowledge doc as knowledge.
  if (doc.frontmatter.type !== 'knowledge') {
    throw new RegulaError('USAGE', `Not a knowledge article (type: ${String(doc.frontmatter.type)}): ${ref}`);
  }
  const fm = doc.frontmatter;
  fm.updated = today();

  if (changes.tags) fm.tags = changes.tags;
  if (changes.addTags) fm.tags = [...new Set([...(fm.tags ?? []), ...changes.addTags])];
  if (changes.removeTags) fm.tags = (fm.tags ?? []).filter((t) => !changes.removeTags!.includes(t));

  let content = doc.content;
  if (changes.content !== undefined) content = changes.content;
  if (changes.append) content = `${content}\n\n${changes.append}`;

  writeDoc(filePath, fm, content);
  return { path: relPath(orgRoot, filePath) };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export interface KnowledgeListItem {
  path: string;
  title: string;
  tags: string[];
  updated?: string;
  created?: string;
}

/** List knowledge articles under knowledge/[folder]/ (recursive), most-recently-updated first. */
export function listKnowledge(orgRoot: string, opts: { folder?: string } = {}): KnowledgeListItem[] {
  const base = opts.folder ? join(orgRoot, 'knowledge', opts.folder) : join(orgRoot, 'knowledge');
  if (!existsSync(base)) return [];
  const items: KnowledgeListItem[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const doc = tryReadDoc(abs); // skip a malformed file rather than break the whole listing
        if (!doc || doc.frontmatter.type !== 'knowledge') continue;
        items.push({
          path: relPath(orgRoot, abs),
          title: extractTitle(doc.content, abs),
          tags: doc.frontmatter.tags ?? [],
          updated: doc.frontmatter.updated,
          created: doc.frontmatter.created,
        });
      }
    }
  };
  walk(base);
  return items.sort((a, b) =>
    String(b.updated ?? b.created ?? '').localeCompare(String(a.updated ?? a.created ?? ''))
  );
}

export interface KnowledgeDetail {
  path: string;
  title: string;
  frontmatter: Frontmatter;
  content: string;
}

/** Read one knowledge article (by path). */
export function getKnowledge(orgRoot: string, ref: string): KnowledgeDetail {
  const filePath = join(orgRoot, ref);
  const doc = readDoc(filePath);
  if (doc.frontmatter.type !== 'knowledge') {
    throw new RegulaError('USAGE', `Not a knowledge article (type: ${String(doc.frontmatter.type)}): ${ref}`);
  }
  return {
    path: relPath(orgRoot, filePath),
    title: extractTitle(doc.content, filePath),
    frontmatter: doc.frontmatter,
    content: doc.content,
  };
}
