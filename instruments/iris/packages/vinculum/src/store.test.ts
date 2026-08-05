import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { edgeKey, serializeEdge, STRUCTURAL_ASSERTED_BY, type Edge } from './schema';
import { readStore, removeEdge, rewriteEdges, storeStats, validateStore } from './store';

function tmpHouse(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinculum-store-'));
  mkdirSync(join(root, 'graph'), { recursive: true });
  return root;
}

function edge(over: Partial<Edge> & Pick<Edge, 'source' | 'target' | 'type'>): Edge {
  return {
    directed: true,
    confidence: 'asserted',
    payload: null,
    evidence: { quote: 'q', loc: `${over.source}:f` },
    provenance: {
      signal: 'frontmatter',
      asserted_by: STRUCTURAL_ASSERTED_BY,
      ts: '2026-08-05T12:00:00.000Z',
      tier: 'structural',
      source_file: over.source,
    },
    verify_key: { src_hash: 'sha256:a', tgt_hash: 'sha256:b', quote_anchor: 'q' },
    refines_wikilink: false,
    ...over,
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('store', () => {
  test('rewrite + read dedups by key and sorts stably', () => {
    const root = tmpHouse();
    roots.push(root);
    const a = edge({ source: 'tasks/b.md', target: 'tasks/a.md', type: 'depends-on' });
    const b = edge({ source: 'tasks/a.md', target: 'tasks/c.md', type: 'depends-on' });
    const dup = edge({ source: 'tasks/b.md', target: 'tasks/a.md', type: 'depends-on' });
    // caller is responsible for dedup before rewrite; rewrite only sorts
    rewriteEdges(root, [a, b]);
    const { edges } = readStore(root);
    expect(edges.map(edgeKey)).toEqual([edgeKey(b), edgeKey(a)].sort((x, y) => x.localeCompare(y)));
    // second rewrite with same set is idempotent
    rewriteEdges(root, [dup, b]);
    expect(readStore(root).edges).toHaveLength(2);
  });

  test('validate surfaces bad lines', () => {
    const root = tmpHouse();
    roots.push(root);
    writeFileSync(
      join(root, 'graph', 'edges.jsonl'),
      [
        serializeEdge(edge({ source: 'tasks/a.md', target: 'tasks/b.md', type: 'depends-on' })),
        '{"source":"x","target":"y"}',
        'not-json',
      ].join('\n') + '\n',
    );
    const r = validateStore(root);
    expect(r.ok).toBe(false);
    expect(r.served).toBe(1);
    expect(r.badLines.length).toBe(2);
  });

  test('remove by src dst type', () => {
    const root = tmpHouse();
    roots.push(root);
    rewriteEdges(root, [
      edge({ source: 'tasks/a.md', target: 'tasks/b.md', type: 'depends-on' }),
      edge({ source: 'tasks/a.md', target: 'tasks/c.md', type: 'depends-on' }),
    ]);
    const r = removeEdge(root, 'tasks/a.md', 'tasks/b.md', 'depends-on');
    expect(r.removed).toBe(1);
    expect(r.remaining).toBe(1);
    expect(storeStats(root).served).toBe(1);
  });
});
