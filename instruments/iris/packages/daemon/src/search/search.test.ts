// ─────────────────────────────────────────────────────────────────────────────
// search.test.ts — the compose (weights, >0 filter, cap-50, stability) over a
// fake OrgIndex. Scoring internals are gated separately by skim.test.ts; here we
// pin the field-weight arithmetic and ordering contract of index.rs::search.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from 'bun:test';
import type { IndexedDoc, LinkResolution, OrgIndex } from '../contract.ts';
import { fuzzyMatch, search } from './index.ts';

function doc(partial: Partial<IndexedDoc> & { path: string }): IndexedDoc {
  return {
    path: partial.path,
    title: partial.title ?? '',
    docType: partial.docType ?? 'other',
    status: partial.status ?? null,
    created: partial.created ?? null,
    updated: partial.updated ?? null,
    tags: partial.tags ?? [],
    links: partial.links ?? [],
    backlinks: partial.backlinks ?? [],
  };
}

function fakeIndex(docs: IndexedDoc[]): OrgIndex {
  const map = new Map<string, IndexedDoc>();
  for (const d of docs) map.set(d.path, d);
  return {
    docs: map,
    pathMap: new Map(),
    stemMap: new Map(),
    projectMap: new Map(),
    resolve(): LinkResolution {
      return { kind: 'missing' };
    },
  };
}

describe('search compose', () => {
  test('field weights: title*3 > tag*2 > path*1 for equal base score', () => {
    // Same matchable token in different fields → same per-field fuzzy score,
    // scaled by the field weight. Non-matching fields contribute 0.
    const a = doc({ path: 'a.md', title: 'x', tags: [] }); // title → 3S
    const c = doc({ path: 'c.md', title: 'zzz', tags: ['x'] }); // tag → 2S
    const b = doc({ path: 'x', title: 'zzz', tags: [] }); // path → 1S
    const results = search(fakeIndex([a, c, b]), 'x');
    expect(results.map((d) => d.path)).toEqual(['a.md', 'c.md', 'x']);
  });

  test('total > 0 filter drops non-matching docs', () => {
    const hit = doc({ path: 'hit.md', title: 'sovereignty' });
    const miss = doc({ path: 'other.md', title: 'nothing here', tags: ['unrelated'] });
    const results = search(fakeIndex([hit, miss]), 'sovereignty');
    expect(results.map((d) => d.path)).toEqual(['hit.md']);
  });

  test('empty query yields zero results (all field scores 0 → total 0)', () => {
    // fuzzy_match(field, "") = Some(0) for every field → total 0 → filtered out.
    const d = doc({ path: 'k.md', title: 'anything', tags: ['t'] });
    expect(search(fakeIndex([d]), '')).toEqual([]);
  });

  test('query is lowercased once (case-insensitive match)', () => {
    const d = doc({ path: 'k.md', title: 'Sovereignty' });
    const results = search(fakeIndex([d]), 'SOVEREIGNTY');
    expect(results.map((x) => x.path)).toEqual(['k.md']);
  });

  test('hard cap at 50 results', () => {
    const docs = Array.from({ length: 60 }, (_, i) =>
      doc({ path: `d${String(i).padStart(2, '0')}.md`, title: 'match' }),
    );
    const results = search(fakeIndex(docs), 'match');
    expect(results.length).toBe(50);
  });

  test('stable order preserved within a score tier (insertion order)', () => {
    const docs = Array.from({ length: 5 }, (_, i) =>
      doc({ path: `t${i}.md`, title: 'match' }),
    );
    const results = search(fakeIndex(docs), 'match');
    expect(results.map((d) => d.path)).toEqual(['t0.md', 't1.md', 't2.md', 't3.md', 't4.md']);
  });

  test('tag score is the max over matching tags', () => {
    // The doc with a strong exact tag match outranks a weak one (both tags-only).
    const strong = doc({ path: 's.md', title: 'zzz', tags: ['example'] });
    const weak = doc({ path: 'w.md', title: 'zzz', tags: ['e_x_a_m_p_l_e_x'] });
    const results = search(fakeIndex([weak, strong]), 'example');
    // strong exact tag scores higher than the gappy one regardless of input order
    expect(results[0].path).toBe('s.md');
  });

  test('re-exported fuzzyMatch matches null-on-no-match contract', () => {
    expect(fuzzyMatch('abc', 'abx')).toBe(null);
    expect(fuzzyMatch('abc', 'abc')).not.toBe(null);
  });
});
