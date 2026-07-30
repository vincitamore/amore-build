import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import type { Frontmatter } from './schema';
import { RegulaError } from './errors';
import { normalizeYamlDates } from './util';

export interface OrgDocument {
  /** Absolute path on disk. */
  path: string;
  /** Parsed YAML frontmatter. */
  frontmatter: Frontmatter;
  /** Body content with the frontmatter block stripped. */
  content: string;
}

/**
 * Read + parse an org document. Throws RegulaError('NOT_FOUND') if absent, or
 * RegulaError('INVALID') if the YAML frontmatter is malformed (the raw js-yaml
 * exception is wrapped so the failure names the offending file legibly).
 */
export function readDoc(filePath: string): OrgDocument {
  if (!existsSync(filePath)) {
    throw new RegulaError('NOT_FOUND', `File not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  let parsed: matter.GrayMatterFile<string>;
  try {
    // Pass an options object so gray-matter SKIPS its content cache (it caches only when called
    // with no options). The cache is doubly unsafe here: (1) it returns the SAME data reference for
    // identical content, so a verb mutating one doc's frontmatter poisons another's; (2) it caches
    // the file object BEFORE parsing, so when YAML throws the cached entry has empty data and the
    // NEXT read of that content returns empty frontmatter WITHOUT throwing (a malformed file would
    // read as blank instead of erroring). Fresh parse every call sidesteps both.
    parsed = matter(raw, {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RegulaError('INVALID', `Malformed frontmatter in ${filePath}: ${msg}`);
  }
  // normalizeYamlDates rebuilds the whole structure (Date → schema string), which also keeps
  // the returned frontmatter independent of gray-matter's internals — verbs mutate it freely.
  return { path: filePath, frontmatter: normalizeYamlDates(parsed.data) as Frontmatter, content: parsed.content };
}

/**
 * Like {@link readDoc} but returns null instead of throwing. For directory listings
 * that must tolerate a single malformed or half-written file without dropping the
 * whole batch — structural correctness: one corrupt member can't break the lister.
 */
export function tryReadDoc(filePath: string): OrgDocument | null {
  try {
    return readDoc(filePath);
  } catch {
    return null;
  }
}

/**
 * Serialize frontmatter + body and write to disk (gray-matter / js-yaml — the same
 * stringifier examen used, so diffs stay clean across the examen → regula cutover).
 */
export function writeDoc(filePath: string, frontmatter: Frontmatter, content: string): void {
  // Defense-in-depth at the write boundary: any Date that reaches here (a caller bypassing
  // readDoc, or a raw gray-matter parse) would serialize as a full ISO timestamp — normalize
  // to the schema's date strings so the invariant holds regardless of caller.
  const output = matter.stringify(content, normalizeYamlDates(frontmatter) as Record<string, unknown>);
  writeFileSync(filePath, output, 'utf-8');
}

/**
 * Delete an org document by org-relative path. Destructive + irreversible — callers
 * (CLI/TUI) must confirm first. Throws NOT_FOUND if absent.
 */
export function deleteDoc(orgRoot: string, ref: string): { path: string } {
  const filePath = join(orgRoot, ref);
  if (!existsSync(filePath)) {
    throw new RegulaError('NOT_FOUND', `File not found: ${ref}`);
  }
  unlinkSync(filePath);
  return { path: ref };
}
