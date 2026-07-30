import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listProjects, getTree, getProjectFile } from './projects.ts';
import type { TreeEntry } from '../contract.ts';

// A real on-disk fixture: parent/{secret.txt, org/...}. `org` is the org root
// (basename deterministically 'org'); secret.txt is a sibling OUTSIDE org for
// the traversal-guard test.
let parent: string;
let org: string;

function write(rel: string, content: string) {
  const full = path.join(org, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function mkdir(rel: string) {
  fs.mkdirSync(path.join(org, rel), { recursive: true });
}

beforeAll(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dioptra-proj-'));
  org = path.join(parent, 'org');
  fs.mkdirSync(org, { recursive: true });
  fs.writeFileSync(path.join(parent, 'secret.txt'), 'top secret\n');

  write('README.md', '# Org\n'); // org root hasReadme=true, hasClaude=false
  write('context/voice.md', 'v\n');
  write('scratchpad/s.md', 's\n'); // excluded when browsing org root
  write('projects/.hidden/r.md', 'r\n'); // dot dir → excluded from list

  write('projects/Zeta/README.md', '# Z\n');
  write('projects/alpha/CLAUDE.md', '# a\n');

  write('projects/beta/README.md', '# Beta\n'); // 7 bytes
  write('projects/beta/CLAUDE.md', '# claude\n');
  write('projects/beta/notes', 'notes\n'); // no extension → language unknown
  write('projects/beta/mb.txt', 'café\n'); // 6 bytes, 5 chars (é is 2 bytes)
  write('projects/beta/src/index.ts', 'export const x = 1;\n');
  write('projects/beta/src/util.py', 'x = 1\n');
  write('projects/beta/src/logo.svg', '<svg/>'); // binary ext → skipped
  write('projects/beta/node_modules/pkg.js', '1'); // excluded dir
  write('projects/beta/target/out.rs', '1'); // excluded dir
  write('projects/beta/.git/config', '1'); // dot + excluded dir
  write('projects/beta/emptyish/.DS_Store', '1'); // only-excluded-file → pruned
  mkdir('projects/beta/empty'); // truly empty → pruned
});

afterAll(() => fs.rmSync(parent, { recursive: true, force: true }));

// ── listProjects ────────────────────────────────────────────────────────────────

describe('listProjects', () => {
  test('org root + project subdirs, byte-sorted (uppercase before lowercase)', () => {
    const list = listProjects(org);
    expect(list).toEqual([
      { name: 'Zeta', hasReadme: true, hasClaude: false },
      { name: 'alpha', hasReadme: false, hasClaude: true },
      { name: 'beta', hasReadme: true, hasClaude: true },
      { name: 'org', hasReadme: true, hasClaude: false },
    ]);
    expect(Object.keys(list[0])).toEqual(['name', 'hasReadme', 'hasClaude']);
  });

  test('dot-prefixed project dirs excluded', () => {
    expect(listProjects(org).some((p) => p.name === '.hidden')).toBe(false);
  });
});

// ── getTree ──────────────────────────────────────────────────────────────────────

describe('getTree', () => {
  const names = (entries: TreeEntry[]) => entries.map((e) => e.name);

  test('dirs-first byte-sort, exclusions, binary skip, empty-dir prune', () => {
    const tree = getTree(org, 'beta') as TreeEntry[];
    expect(names(tree)).toEqual(['src', 'CLAUDE.md', 'README.md', 'mb.txt', 'notes']);
    // no excluded / pruned dirs anywhere at top level
    for (const bad of ['node_modules', 'target', '.git', 'empty', 'emptyish']) {
      expect(names(tree)).not.toContain(bad);
    }
    const src = tree.find((e) => e.name === 'src')!;
    expect(src.isDir).toBe(true);
    expect(Object.keys(src)).toEqual(['name', 'path', 'isDir', 'children']); // dir key order
    expect(names(src.children!)).toEqual(['index.ts', 'util.py']); // logo.svg skipped
  });

  test('file entry fields: path project-relative /, language map, size present', () => {
    const tree = getTree(org, 'beta') as TreeEntry[];
    const src = tree.find((e) => e.name === 'src')!;
    const index = src.children!.find((e) => e.name === 'index.ts')!;
    expect(index).toMatchObject({ name: 'index.ts', path: 'src/index.ts', isDir: false, language: 'typescript' });
    expect(Object.keys(index)).toEqual(['name', 'path', 'isDir', 'size', 'language']); // file key order
    expect(index.size).toBeGreaterThan(0);
    expect(src.children!.find((e) => e.name === 'util.py')!.language).toBe('python');
    expect(tree.find((e) => e.name === 'README.md')!.language).toBe('markdown');
  });

  test('unknown-extension file omits language (present-omission, unlike file-read)', () => {
    const tree = getTree(org, 'beta') as TreeEntry[];
    const notes = tree.find((e) => e.name === 'notes')!;
    expect(Object.keys(notes)).toEqual(['name', 'path', 'isDir', 'size']); // no language key
    expect('language' in notes).toBe(false);
  });

  test('org-root-as-project excludes projects/scratchpad; keeps normal top-level', () => {
    const tree = getTree(org, 'org') as TreeEntry[];
    const nm = tree.map((e) => e.name);
    expect(nm).not.toContain('projects');
    expect(nm).not.toContain('scratchpad');
    expect(nm).toContain('context');
    expect(nm).toContain('README.md');
  });

  test('missing project → null', () => {
    expect(getTree(org, 'nonexistent')).toBeNull();
  });
});

// ── getProjectFile ────────────────────────────────────────────────────────────────

describe('getProjectFile', () => {
  test('full raw content, language, byte-length size, verbatim path echo', () => {
    const f = getProjectFile(org, 'beta', 'README.md');
    expect(f).toEqual({ path: 'README.md', content: '# Beta\n', language: 'markdown', size: 7 });
    expect(Object.keys(f as object)).toEqual(['path', 'content', 'language', 'size']);
  });

  test('unknown extension → language null (PRESENT, not omitted); size is byte length', () => {
    const f = getProjectFile(org, 'beta', 'mb.txt') as { language: string | null; size: number; content: string };
    expect(f.language).toBeNull();
    expect('language' in (f as object)).toBe(true);
    expect(f.content).toBe('café\n');
    expect(f.size).toBe(6); // byte length, not string length (5)
  });

  test('missing file → null; unresolved project → null', () => {
    expect(getProjectFile(org, 'beta', 'nope.md')).toBeNull();
    expect(getProjectFile(org, 'nonexistent', 'x.md')).toBeNull();
  });

  test('traversal escaping org root → forbidden', () => {
    // beta = org/projects/beta; ../../../secret.txt resolves to parent/secret.txt (outside org).
    expect(getProjectFile(org, 'beta', '../../../secret.txt')).toBe('forbidden');
  });

  test('.. that stays under org root is allowed (guard is org-root, not project)', () => {
    // ../alpha/CLAUDE.md from beta stays under org → served, not forbidden.
    const f = getProjectFile(org, 'beta', '../alpha/CLAUDE.md');
    expect(f).not.toBe('forbidden');
    expect((f as { content: string }).content).toBe('# a\n');
  });
});
