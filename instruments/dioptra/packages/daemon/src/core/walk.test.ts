import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { shouldExclude, walk } from './walk';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'daemon-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content = '# doc\n'): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// ── shouldExclude predicate ───────────────────────────────────────────────────

test('excludes node_modules/.git/.tmp/dist/build/.next/target at ANY depth', () => {
  for (const d of ['node_modules', '.git', '.tmp', 'dist', 'build', '.next', 'target']) {
    expect(shouldExclude(`${d}`, true)).toBe(true);
    expect(shouldExclude(`knowledge/${d}/x.md`, false)).toBe(true);
    expect(shouldExclude(`instruments/dioptra/${d}`, true)).toBe(true);
  }
});

test('excludes top-level .obsidian and x only', () => {
  expect(shouldExclude('.obsidian', true)).toBe(true);
  expect(shouldExclude('x', true)).toBe(true);
  // `x` is top-level-only: a nested dir literally named `x` is not excluded by that rule
  expect(shouldExclude('knowledge/x', true)).toBe(false);
});

test('PIN: .claude/worktrees/anything.md is excluded (ratified dot-prefix rule)', () => {
  expect(shouldExclude('.claude', true)).toBe(true);
  expect(shouldExclude('.claude/worktrees', true)).toBe(true);
  expect(shouldExclude('.claude/worktrees/anything.md', false)).toBe(true);
});

test('nested .obsidian dir is admitted (dot-rule exemption quirk)', () => {
  expect(shouldExclude('knowledge/.obsidian', true)).toBe(false);
  expect(shouldExclude('knowledge/.obsidian/notes.md', false)).toBe(false);
});

test('other dot-prefixed files/dirs excluded at any depth', () => {
  expect(shouldExclude('.hidden.md', false)).toBe(true);
  expect(shouldExclude('knowledge/.secret/x.md', false)).toBe(true);
  expect(shouldExclude('knowledge/.draft.md', false)).toBe(true);
});

test('projects/: only <name>/{CLAUDE,README}.md admitted', () => {
  expect(shouldExclude('projects/foo/README.md', false)).toBe(false);
  expect(shouldExclude('projects/foo/CLAUDE.md', false)).toBe(false);
  expect(shouldExclude('projects/foo/other.md', false)).toBe(true); // wrong file
  expect(shouldExclude('projects/foo/docs/README.md', false)).toBe(true); // too deep (len 4)
  expect(shouldExclude('projects/foo/src', true)).toBe(true); // dir deeper than 2 components
  expect(shouldExclude('projects/foo', true)).toBe(false); // project dir itself descended
  expect(shouldExclude('projects', true)).toBe(false);
});

test('instruments/: only <tool>/{CLAUDE,README}.md + <tool>/design/*.md admitted', () => {
  expect(shouldExclude('instruments/dioptra/README.md', false)).toBe(false);
  expect(shouldExclude('instruments/dioptra/CLAUDE.md', false)).toBe(false);
  expect(shouldExclude('instruments/dioptra/design/spec.md', false)).toBe(false);
  expect(shouldExclude('instruments/dioptra/package.json', false)).toBe(true);
  expect(shouldExclude('instruments/dioptra/src/main.rs', false)).toBe(true);
  expect(shouldExclude('instruments/dioptra/design/sub/deep.md', false)).toBe(true); // len 5
  expect(shouldExclude('instruments/dioptra/design', true)).toBe(false); // design dir descended
  expect(shouldExclude('instruments/dioptra/src', true)).toBe(false); // len-3 dir descended (files inside excluded)
  expect(shouldExclude('instruments/dioptra/src/server', true)).toBe(true); // len-4 dir pruned
});

test('normal roots are not excluded', () => {
  expect(shouldExclude('knowledge/a/b/c.md', false)).toBe(false);
  expect(shouldExclude('tasks/completed/x.md', false)).toBe(false);
  expect(shouldExclude('context/voice.md', false)).toBe(false);
});

// ── walk integration ──────────────────────────────────────────────────────────

test('walk collects indexed docs and prunes excluded subtrees', () => {
  write('knowledge/a.md');
  write('knowledge/sub/b.md');
  write('tasks/t.md');
  write('node_modules/pkg/readme.md');
  write('knowledge/dist/generated.md');
  write('.claude/worktrees/anything.md');
  write('.obsidian/config.md');
  write('x/tweet.md');
  write('projects/foo/README.md');
  write('projects/foo/notes.md');
  write('projects/foo/src/deep.md');
  write('instruments/dioptra/README.md');
  write('instruments/dioptra/design/spec.md');
  write('instruments/dioptra/src/server/index.md');
  write('nonmarkdown.txt', 'not md');

  const found = new Set(walk(root));

  expect(found.has('knowledge/a.md')).toBe(true);
  expect(found.has('knowledge/sub/b.md')).toBe(true);
  expect(found.has('tasks/t.md')).toBe(true);
  expect(found.has('projects/foo/README.md')).toBe(true);
  expect(found.has('instruments/dioptra/README.md')).toBe(true);
  expect(found.has('instruments/dioptra/design/spec.md')).toBe(true);

  // Excluded
  expect(found.has('node_modules/pkg/readme.md')).toBe(false);
  expect(found.has('knowledge/dist/generated.md')).toBe(false);
  expect(found.has('.claude/worktrees/anything.md')).toBe(false); // PIN
  expect(found.has('.obsidian/config.md')).toBe(false);
  expect(found.has('x/tweet.md')).toBe(false);
  expect(found.has('projects/foo/notes.md')).toBe(false);
  expect(found.has('projects/foo/src/deep.md')).toBe(false);
  expect(found.has('instruments/dioptra/src/server/index.md')).toBe(false);
  expect([...found].some((p) => p.endsWith('.txt'))).toBe(false);
});
