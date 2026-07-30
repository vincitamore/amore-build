import { test, expect } from 'bun:test';
import { diffJson } from './diff';
import { compareToGolden } from './replay';
import type { GoldenRecord } from './manifest';

test('identical objects produce no diffs', () => {
  const a = { x: 1, y: { z: [1, 2, 3] }, s: 'hi' };
  const b = { s: 'hi', y: { z: [1, 2, 3] }, x: 1 }; // key order irrelevant
  expect(diffJson(a, b)).toEqual([]);
});

test('nested value divergence is reported at its dot-path', () => {
  const d = diffJson({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({ path: 'a.b.c', kind: 'value', golden: 1, target: 2 });
});

test('missing and extra keys are distinguished', () => {
  const d = diffJson({ keep: 1, gone: 2 }, { keep: 1, added: 3 });
  const byKind = Object.fromEntries(d.map((x) => [x.kind, x.path]));
  expect(byKind.missing).toBe('gone');
  expect(byKind.extra).toBe('added');
});

test('array length mismatch is one diff at the array path, then element diffs', () => {
  const d = diffJson({ items: [1, 2, 3] }, { items: [1, 9] });
  const len = d.find((x) => x.kind === 'length');
  expect(len).toMatchObject({ path: 'items', golden: 3, target: 2 });
  const val = d.find((x) => x.kind === 'value');
  expect(val).toMatchObject({ path: 'items.1', golden: 2, target: 9 });
});

test('array order is significant', () => {
  const d = diffJson([1, 2, 3], [3, 2, 1]);
  expect(d.map((x) => x.path).sort()).toEqual(['0', '2']);
});

test('type mismatch short-circuits recursion', () => {
  const d = diffJson({ a: { nested: true } }, { a: 'string' });
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({ path: 'a', kind: 'type' });
});

test('null vs object is a type diff, not a crash', () => {
  const d = diffJson({ a: null }, { a: { x: 1 } });
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({ path: 'a', kind: 'type', golden: null });
});

test('exact ignore path suppresses a leaf divergence', () => {
  const d = diffJson({ ts: 'A', keep: 1 }, { ts: 'B', keep: 1 }, { ignore: ['ts'] });
  expect(d).toEqual([]);
});

test('ignore path suppresses a whole subtree', () => {
  const d = diffJson(
    { server: { uptime: 1, lastIndexed: 'A' }, docs: 5 },
    { server: { uptime: 99, lastIndexed: 'B' }, docs: 5 },
    { ignore: ['server.uptime', 'server.lastIndexed'] },
  );
  expect(d).toEqual([]);
});

test('a real regression survives while its sibling ignore is honored', () => {
  const d = diffJson(
    { server: { uptime: 1 }, docs: 5 },
    { server: { uptime: 99 }, docs: 6 },
    { ignore: ['server.uptime'] },
  );
  expect(d).toHaveLength(1);
  expect(d[0]).toMatchObject({ path: 'docs', kind: 'value', golden: 5, target: 6 });
});

test('wildcard ignore segment matches any array index', () => {
  const d = diffJson(
    { items: [{ score: 0.1, id: 'a' }, { score: 0.2, id: 'b' }] },
    { items: [{ score: 0.9, id: 'a' }, { score: 0.8, id: 'b' }] },
    { ignore: ['items.*.score'] },
  );
  expect(d).toEqual([]);
});

// ── compareToGolden: status, bodyKind, non-JSON bodies ──────────────────────

function golden(over: Partial<GoldenRecord>): GoldenRecord {
  return {
    case: { id: 'x', endpoint: '/e', method: 'GET', path: '/e', desc: '' },
    request: { method: 'GET', path: '/e' },
    status: 200,
    contentType: 'application/json',
    bodyKind: 'json',
    body: { ok: true },
    bodyHash: '',
    ...over,
  };
}

test('compareToGolden flags a status divergence', () => {
  const g = golden({ status: 200 });
  const d = compareToGolden(g, { status: 404, contentType: 'application/json', bodyKind: 'json', body: { ok: true } }, []);
  expect(d.some((x) => x.path === '__status')).toBe(true);
});

test('compareToGolden flags a bodyKind divergence and stops', () => {
  const g = golden({ bodyKind: 'json', body: { ok: true } });
  const d = compareToGolden(g, { status: 200, contentType: 'text/plain', bodyKind: 'raw', body: 'hi' }, []);
  expect(d).toHaveLength(1);
  expect(d[0].path).toBe('__bodyKind');
});

test('compareToGolden diffs raw (non-JSON) bodies by exact string', () => {
  const g = golden({ bodyKind: 'raw', contentType: 'image/svg+xml', body: '<svg>a</svg>' });
  const same = compareToGolden(g, { status: 200, contentType: 'image/svg+xml', bodyKind: 'raw', body: '<svg>a</svg>' }, []);
  expect(same).toEqual([]);
  const diff = compareToGolden(g, { status: 200, contentType: 'image/svg+xml', bodyKind: 'raw', body: '<svg>b</svg>' }, []);
  expect(diff).toHaveLength(1);
  expect(diff[0].path).toBe('__body');
});

test('compareToGolden applies the endpoint ignore list to JSON bodies', () => {
  const g = golden({ body: { timestamp: 'A', status: 'ok' } });
  const d = compareToGolden(
    g,
    { status: 200, contentType: 'application/json', bodyKind: 'json', body: { timestamp: 'B', status: 'ok' } },
    ['timestamp'],
  );
  expect(d).toEqual([]);
});
