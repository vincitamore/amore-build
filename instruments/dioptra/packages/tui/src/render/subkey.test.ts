import { test, expect } from 'bun:test';
import { subKeyOf, hiddenSubKey, ROOT_SUB } from './subkey';
import type { GraphNode } from './graph';

const node = (p: Partial<GraphNode> & { id: string }): GraphNode => p;

test('task/reminder drill into their status; a missing status is null', () => {
  expect(subKeyOf(node({ id: 'tasks/x.md', type: 'task', status: 'blocked' }))).toBe('blocked');
  expect(subKeyOf(node({ id: 'r.md', type: 'reminder', status: 'pending' }))).toBe('pending');
  expect(subKeyOf(node({ id: 'tasks/x.md', type: 'task' }))).toBeNull();
});

test('inbox drills into its second path segment; a flat inbox item is null', () => {
  expect(subKeyOf(node({ id: 'inbox/decisions/foo.md', type: 'inbox' }))).toBe('decisions');
  expect(subKeyOf(node({ id: 'inbox/capture.md', type: 'inbox' }))).toBeNull(); // only 2 segments
});

test('other doc/file types drill into the first sub-folder when nested', () => {
  expect(subKeyOf(node({ id: 'knowledge/architecture/x.md', type: 'knowledge' }))).toBe('architecture');
  expect(subKeyOf(node({ id: 'forge/output/run/y.md', type: 'forge' }))).toBe('output');
});

test('a root-level file of an other type returns the ROOT_SUB marker (legend gates it)', () => {
  expect(subKeyOf(node({ id: 'knowledge/README.md', type: 'knowledge' }))).toBe(ROOT_SUB);
  expect(subKeyOf(node({ id: 'CLAUDE.md', type: 'other' }))).toBe(ROOT_SUB); // single segment
});

test('placeholder/cluster kinds and the tag type never drill', () => {
  expect(subKeyOf(node({ id: 'x', type: 'knowledge', kind: 'placeholder' }))).toBeNull();
  expect(subKeyOf(node({ id: 'x', type: 'knowledge', kind: 'cluster' }))).toBeNull();
  expect(subKeyOf(node({ id: 'tags/react', type: 'tag' }))).toBeNull();
});

test('hiddenSubKey is collision-safe: no two distinct (type,sub) pairs alias', () => {
  expect(hiddenSubKey('task', 'blocked')).toBe('task blocked');
  // the space separator can't be produced inside a type name or a sub, so a/bc vs ab/c never collide
  expect(hiddenSubKey('a', 'b')).not.toBe(hiddenSubKey('a b', ''));
  expect(hiddenSubKey('knowledge', ROOT_SUB)).toBe(`knowledge ${ROOT_SUB}`);
});
