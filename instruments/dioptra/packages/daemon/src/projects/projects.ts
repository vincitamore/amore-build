// ─────────────────────────────────────────────────────────────────────────────
// projects/projects.ts — the ProjectsModule surface (list / tree / file).
//
// Ports src-tauri/src/server/projects.rs (spec §9–11). All three read the disk
// directly under an org-root traversal guard (no index involvement). Exclusion
// lists, language map, and binary-extension set are copied verbatim from the
// Rust source. Regime A output — key order is struct-declaration order,
// reproduced with ordered object literals + spread-omitted optionals.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TreeEntry, ProjectFileWire } from '../contract.ts';

// ── UTF-8 byte-order comparison (Rust str/OsStr `cmp` order) ───────────────────

const ENC = new TextEncoder();
function byteCompare(a: string, b: string): number {
  if (a === b) return 0;
  const ba = ENC.encode(a);
  const bb = ENC.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

// ── Exclusion lists (verbatim from projects.rs) ───────────────────────────────

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.obsidian',
  'dist',
  'build',
  'target',
  '__pycache__',
  '.next',
  '.turbo',
  '.cargo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.svelte-kit',
  '.nuxt',
  '.output',
  'vendor',
  '.vercel',
]);

const EXCLUDED_FILES = new Set(['.DS_Store', 'Thumbs.db', '.env', '.env.local']);

/** Extra top-level exclusions when browsing the org root as a project. */
const ORG_ROOT_EXCLUDED_DIRS = new Set([
  'projects',
  'scratchpad',
  'archive',
  'tags',
  'screenshots',
  'x',
]);

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'bmp', 'webp', 'svg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z',
  'exe', 'dll', 'so', 'dylib',
  'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'mp3', 'mp4', 'wav', 'avi', 'mkv', 'flac',
  'db', 'sqlite', 'sqlite3',
  'wasm', 'map',
]);

/** `detect_language` — extension → language id, else null (unknown). */
function detectLanguage(filename: string): string | null {
  const ext = filename.slice(filename.lastIndexOf('.') + 1);
  switch (ext) {
    case 'rs': return 'rust';
    case 'ts': return 'typescript';
    case 'tsx': return 'typescriptJsx';
    case 'js': return 'javascript';
    case 'jsx': return 'javascriptJsx';
    case 'py': return 'python';
    case 'pas': case 'pp': case 'lpr': case 'lfm': case 'dpr': case 'dfm': case 'inc':
      return 'pascal';
    case 'lpi': return 'xml';
    case 'json': return 'json';
    case 'md': case 'markdown': return 'markdown';
    case 'css': return 'css';
    case 'scss': case 'sass': return 'css';
    case 'html': case 'htm': return 'html';
    case 'toml': return 'toml';
    case 'yaml': case 'yml': return 'yaml';
    case 'sql': return 'sql';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'ps1': return 'powershell';
    case 'xml': case 'svg': return 'xml';
    case 'go': return 'go';
    case 'java': return 'java';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': return 'cpp';
    case 'lua': return 'lua';
    case 'rb': return 'ruby';
    case 'php': return 'php';
    case 'swift': return 'swift';
    case 'kt': case 'kts': return 'kotlin';
    case 'dart': return 'dart';
    case 'lock': return 'json';
    default: return null;
  }
}

function isBinaryExtension(filename: string): boolean {
  const ext = filename.slice(filename.lastIndexOf('.') + 1);
  return BINARY_EXTENSIONS.has(ext);
}

function shouldExcludeEntry(name: string, isDir: boolean): boolean {
  return isDir ? EXCLUDED_DIRS.has(name) : EXCLUDED_FILES.has(name);
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function orgRootName(orgRoot: string): string {
  const base = path.basename(orgRoot);
  return base.length > 0 ? base : 'claude-org';
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a project name to its dir. Org-root name → org root; else
 * `<orgRoot>/projects/<name>` (must be a directory). null when unresolvable.
 */
function resolveProjectDir(orgRoot: string, name: string): string | null {
  if (name === orgRootName(orgRoot)) return orgRoot;
  const dir = path.join(orgRoot, 'projects', name);
  return isDirectory(dir) ? dir : null;
}

/** Component-aware "is `child` at or under `parent`" (both realpath'd). */
function isUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(withSep);
}

// ── list_projects ─────────────────────────────────────────────────────────────

export function listProjects(orgRoot: string): { name: string; hasReadme: boolean; hasClaude: boolean }[] {
  const projects: { name: string; hasReadme: boolean; hasClaude: boolean }[] = [];

  // The org root itself as a virtual project.
  projects.push({
    name: orgRootName(orgRoot),
    hasReadme: existsFile(path.join(orgRoot, 'README.md')),
    hasClaude: existsFile(path.join(orgRoot, 'CLAUDE.md')),
  });

  // Immediate subdirectories of projects/, excluding dot-prefixed names.
  const projectsDir = path.join(orgRoot, 'projects');
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    if (name.startsWith('.')) continue;
    const dir = path.join(projectsDir, name);
    projects.push({
      name,
      hasReadme: existsFile(path.join(dir, 'README.md')),
      hasClaude: existsFile(path.join(dir, 'CLAUDE.md')),
    });
  }

  projects.sort((a, b) => byteCompare(a.name, b.name));
  return projects;
}

// ── get_tree ──────────────────────────────────────────────────────────────────

/** Recursive tree build with dirs-first byte-name sort, exclusions, pruning. */
function buildTree(dir: string, projectRoot: string, isOrgRoot: boolean): TreeEntry[] {
  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Sort: directories first, then byte-lexicographic by name.
  dirEntries.sort((a, b) => {
    const aDir = a.isDirectory();
    const bDir = b.isDirectory();
    if (aDir && !bDir) return -1;
    if (!aDir && bDir) return 1;
    return byteCompare(a.name, b.name);
  });

  const entries: TreeEntry[] = [];
  for (const entry of dirEntries) {
    const name = entry.name;
    const isDir = entry.isDirectory();

    if (shouldExcludeEntry(name, isDir)) continue;
    if (name.startsWith('.')) continue;
    if (isOrgRoot && isDir && ORG_ROOT_EXCLUDED_DIRS.has(name)) continue;

    const fullPath = path.join(dir, name);
    const relativePath = path.relative(projectRoot, fullPath).split(path.sep).join('/');

    if (isDir) {
      const children = buildTree(fullPath, projectRoot, isOrgRoot);
      if (children.length === 0) continue; // prune empty dirs
      entries.push({ name, path: relativePath, isDir: true, children });
    } else {
      if (isBinaryExtension(name)) continue; // binary files skipped entirely
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        size = 0;
      }
      const language = detectLanguage(name);
      entries.push({
        name,
        path: relativePath,
        isDir: false,
        size,
        ...(language !== null ? { language } : {}),
      });
    }
  }

  return entries;
}

export function getTree(orgRoot: string, name: string): TreeEntry[] | null | 'forbidden' {
  const projectDir = resolveProjectDir(orgRoot, name);
  if (projectDir === null) return null; // 404
  if (!isDirectory(projectDir)) return null;

  // Traversal guard — canonicalized project dir must stay under org root.
  const canonicalOrg = fs.realpathSync(orgRoot);
  let canonicalProject: string;
  try {
    canonicalProject = fs.realpathSync(projectDir);
  } catch {
    return null; // 404
  }
  if (!isUnder(canonicalProject, canonicalOrg)) return 'forbidden';

  const isOrg = name === orgRootName(orgRoot);
  return buildTree(projectDir, projectDir, isOrg);
}

// ── get_file ──────────────────────────────────────────────────────────────────

export function getProjectFile(
  orgRoot: string,
  name: string,
  filePath: string,
): ProjectFileWire | null | 'forbidden' {
  const projectDir = resolveProjectDir(orgRoot, name);
  if (projectDir === null) return null; // 404

  const fullPath = path.join(projectDir, filePath);

  const canonicalOrg = fs.realpathSync(orgRoot);
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(fullPath);
  } catch {
    return null; // 404 — file doesn't exist
  }
  if (!isUnder(canonicalPath, canonicalOrg)) return 'forbidden';

  let content: string;
  let size: number;
  try {
    if (!fs.statSync(canonicalPath).isFile()) return null; // not a regular file
    content = fs.readFileSync(canonicalPath, 'utf8');
    size = fs.statSync(canonicalPath).size;
  } catch {
    return null;
  }

  const filename = path.basename(canonicalPath);
  const language = detectLanguage(filename); // null when unknown — PRESENT, not omitted

  // path echoes the request param verbatim (not canonicalized).
  return { path: filePath, content, language, size };
}
