import { describe, expect, test } from 'bun:test';
import {
  EDGE_TYPE_NAMES,
  edgeKey,
  parseEdgeJsonl,
  serializeEdge,
  validateEdge,
  STRUCTURAL_ASSERTED_BY,
} from './schema';

const PROVENANCE = {
  signal: 'frontmatter' as const,
  asserted_by: STRUCTURAL_ASSERTED_BY,
  ts: '2026-08-05T12:00:00.000Z',
  tier: 'structural',
  source_file: 'tasks/a.md',
  field: 'blocked-by',
};
const EVIDENCE = { quote: 'tasks/blocker.md', loc: 'tasks/a.md:blocked-by' };
const VERIFY = { src_hash: 'sha256:aa', tgt_hash: 'sha256:bb', quote_anchor: 'tasks/blocker.md' };

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'tasks/a.md',
    target: 'tasks/blocker.md',
    type: 'depends-on',
    confidence: 'asserted',
    evidence: EVIDENCE,
    provenance: PROVENANCE,
    verify_key: VERIFY,
    refines_wikilink: false,
    ...over,
  };
}

describe('taxonomy', () => {
  test('exact 15-type set (sorted)', () => {
    expect([...EDGE_TYPE_NAMES].sort()).toEqual([
      'addressed-by',
      'analogous-to',
      'builds-on',
      'contests-at-border',
      'contradicts',
      'depends-on',
      'dual-of',
      'exemplifies',
      'generalizes',
      'motivates',
      'refines',
      'resolved-by',
      'supersedes',
      'transmission-pair',
      'vice-of',
    ]);
  });
});

describe('validateEdge', () => {
  test('well-formed asserted depends-on validates', () => {
    const v = validateEdge(base());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.edge.directed).toBe(true);
      expect(v.edge.provenance.tier).toBe('structural');
      expect(v.edge.provenance.field).toBe('blocked-by');
    }
  });

  test('served tier without evidence fails', () => {
    const v = validateEdge(base({ evidence: null }));
    expect(v.ok).toBe(false);
  });

  test('unknown type fails', () => {
    const v = validateEdge(base({ type: 'similar-to' }));
    expect(v.ok).toBe(false);
  });

  test('self-edge fails', () => {
    const v = validateEdge(base({ target: 'tasks/a.md' }));
    expect(v.ok).toBe(false);
  });

  test('payload-required type at asserted needs payload', () => {
    const v = validateEdge(
      base({
        type: 'dual-of',
        source: 'knowledge/a.md',
        target: 'knowledge/b.md',
        payload: null,
      }),
    );
    expect(v.ok).toBe(false);
  });
});

describe('serialize / parse', () => {
  test('round-trip preserves structural provenance fields', () => {
    const v = validateEdge(base());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const line = serializeEdge(v.edge);
    const parsed = parseEdgeJsonl(line);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].result.ok).toBe(true);
    if (parsed[0].result.ok) {
      expect(parsed[0].result.edge.provenance.source_file).toBe('tasks/a.md');
      expect(edgeKey(parsed[0].result.edge)).toBe(edgeKey(v.edge));
    }
  });
});
