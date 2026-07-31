import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readDoc } from './doc';
import { normalizeYamlDates, today, localIso } from './util';
import { listTasks, updateTaskMeta } from './task';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'regula-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a hand-authored-style file (UNQUOTED dates — how the live tree is written). */
function writeHandAuthored(rel: string, fmLines: string[], body = '# Doc\n'): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, `---\n${fmLines.join('\n')}\n---\n${body}`, 'utf-8');
  return abs;
}

// ─── The unquoted-YAML-date boundary (the P0 class) ──────────────────────────

test('readDoc normalizes an unquoted YAML date to a YYYY-MM-DD string', () => {
  const abs = writeHandAuthored('tasks/t.md', ['type: task', 'status: active', 'created: 2026-05-28']);
  const doc = readDoc(abs);
  expect(typeof doc.frontmatter.created).toBe('string');
  expect(doc.frontmatter.created).toBe('2026-05-28');
});

test('readDoc keeps full ISO precision for a time-bearing unquoted timestamp', () => {
  const abs = writeHandAuthored('forge/m.md', ['type: forge', 'started: 2026-07-01 14:41:50']);
  const doc = readDoc(abs);
  expect(typeof doc.frontmatter.started).toBe('string');
  expect(String(doc.frontmatter.started)).toContain('2026-07-01T');
});

test('a write round-trip on a hand-authored file does NOT mangle the date field', () => {
  writeHandAuthored('tasks/hand.md', ['type: task', 'status: active', 'created: 2026-05-28', 'tags: [a]']);
  updateTaskMeta(root, 'hand', { addTags: ['b'] });
  const raw = readFileSync(join(root, 'tasks/hand.md'), 'utf-8');
  expect(raw).not.toContain('T00:00:00'); // the pre-fix mangle: created: 2026-05-28T00:00:00.000Z
  expect(raw).toMatch(/created: '?2026-05-28'?\r?\n/);
});

test('listTasks sorts hand-authored (unquoted-date) tasks newest first', () => {
  writeHandAuthored('tasks/older.md', ['type: task', 'status: active', 'created: 2026-05-06']);
  writeHandAuthored('tasks/newest.md', ['type: task', 'status: active', 'created: 2026-06-24']);
  writeHandAuthored('tasks/middle.md', ['type: task', 'status: active', 'created: 2026-05-27']);
  const order = listTasks(root).map((t) => t.path);
  expect(order).toEqual(['tasks/newest.md', 'tasks/middle.md', 'tasks/older.md']);
});

test('normalizeYamlDates walks arrays and nested objects', () => {
  const out = normalizeYamlDates({
    a: [new Date(Date.UTC(2026, 4, 28))],
    b: { c: new Date(Date.UTC(2026, 4, 28, 14, 30, 0)) },
    s: 'left-alone',
    n: 5,
    z: null,
  }) as Record<string, unknown>;
  expect((out.a as unknown[])[0]).toBe('2026-05-28');
  expect((out.b as Record<string, unknown>).c).toBe('2026-05-28T14:30:00.000Z');
  expect(out.s).toBe('left-alone');
  expect(out.n).toBe(5);
  expect(out.z).toBe(null);
});

// ─── Local-time stamps (the UTC-rollover P0) ──────────────────────────────────

test('today() renders the LOCAL calendar date, not UTC', () => {
  // Constructed from local components: 23:30 local on July 1 must stamp July 1 in every zone
  // (the pre-fix toISOString() rendered UTC — tomorrow's date in any western zone).
  expect(today(new Date(2026, 6, 1, 23, 30))).toBe('2026-07-01');
  expect(today(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
});

test('localIso() renders local wall-clock time', () => {
  expect(localIso(new Date(2026, 6, 1, 19, 5, 9))).toBe('2026-07-01T19:05:09');
});
