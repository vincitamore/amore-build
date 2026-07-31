// ─────────────────────────────────────────────────────────────────────────────
// core/walk.ts — the full-org-root recursive walk + the legacy `should_exclude`
// filter replica (src-tauri/src/server/index.rs).
//
// Excluded at ANY depth: node_modules / .git / .tmp / dist / build / .next / target.
// Top-level only: `.obsidian`, `x`. `projects/` admits ONLY projects/<name>/{CLAUDE,
// README}.md (depth-3 files; dirs deeper than 2 components pruned). `instruments/`
// admits ONLY instruments/<tool>/{CLAUDE,README}.md + instruments/<tool>/design/*.md
// (dirs deeper than 3 components pruned). Any dot-prefixed file/dir is excluded
// EXCEPT the name `.obsidian`.
//
// Divergence from the literal Rust code (intentional, outcome-identical): legacy
// checks the dot-prefix rule on `path.file_name()` (the LAST component only),
// relying on walkdir's `filter_entry` to prune each ancestor dir at its own visit.
// As a standalone predicate we check EVERY component, so a deep path under a dot-dir
// — e.g. `.claude/worktrees/anything.md` — is excluded directly. This is the
// ratified `.claude/**` exclusion and is pinned by an explicit test. It matches
// legacy walk OUTCOMES exactly: no legacy-indexed doc has a non-last dot-component
// other than `.obsidian` (which stays exempt), because legacy would have pruned its
// ancestor. `.obsidian` nested under another dir is still admitted (the exact quirk
// legacy's `name != ".obsidian"` exemption produces).
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const EXCLUDED_ANYWHERE = new Set(['node_modules', '.git', '.tmp', 'dist', 'build', '.next', 'target']);
const EXCLUDED_TOP = new Set(['.obsidian', 'x']);

/**
 * Legacy `should_exclude(relPath, isDir)`. `relPath` is org-relative with forward
 * slashes; `isDir` distinguishes the projects/instruments depth-pruning rules
 * (which legacy derives from `path.is_dir()`/`path.is_file()`).
 */
export function shouldExclude(relPath: string, isDir: boolean): boolean {
  const components = relPath.split('/').filter((c) => c.length > 0);
  if (components.length === 0) return false; // the org root itself is never excluded

  for (const comp of components) {
    if (EXCLUDED_ANYWHERE.has(comp)) return true;
  }

  const first = components[0];
  if (EXCLUDED_TOP.has(first)) return true;

  if (first === 'projects') {
    if (!isDir) {
      if (components.length === 3) {
        const fname = components[components.length - 1];
        if (fname === 'CLAUDE.md' || fname === 'README.md') return false;
      }
      return true;
    }
    if (components.length > 2) return true;
  }

  if (first === 'instruments') {
    if (!isDir) {
      const fname = components[components.length - 1];
      if (components.length === 3 && (fname === 'CLAUDE.md' || fname === 'README.md')) return false;
      if (components.length === 4 && components[2] === 'design') return false;
      return true;
    }
    if (components.length > 3) return true;
  }

  // Dot-prefixed component anywhere (except `.obsidian`) → excluded.
  for (const comp of components) {
    if (comp.startsWith('.') && comp !== '.obsidian') return true;
  }

  return false;
}

/**
 * Recursively collect every indexed `.md` file under `orgRoot`. Returns
 * org-relative, forward-slash paths in walk order. Directories excluded by
 * `shouldExclude` are pruned (not descended); symlinks are skipped
 * (legacy `WalkDir::follow_links(false)`); unreadable dirs are silently skipped
 * (legacy `filter_map(|e| e.ok())`).
 */
export function walk(orgRoot: string): string[] {
  const out: string[] = [];
  const recurse = (absDir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const rel = relDir === '' ? ent.name : `${relDir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (!shouldExclude(rel, true)) recurse(join(absDir, ent.name), rel);
      } else if (ent.isFile()) {
        if (ent.name.endsWith('.md') && !shouldExclude(rel, false)) out.push(rel);
      }
    }
  };
  recurse(orgRoot, '');
  return out;
}
