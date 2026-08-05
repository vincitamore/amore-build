import { test, expect } from 'bun:test';
import type { CoreModule, IndexedDoc } from '../contract';
import { serializeDoc } from './serialize';
import { applyChanges, buildIndex } from './index-build';
import { shouldExclude } from './walk';
import { extractBody } from './parse';
import { startWatcher } from './watcher';

function mkDoc(over: Partial<IndexedDoc> = {}): IndexedDoc {
  return {
    path: 'knowledge/k.md',
    title: 'K',
    docType: 'knowledge',
    status: null,
    created: null,
    updated: null,
    tags: [],
    links: [],
    backlinks: [],
    ...over,
  };
}

test('bare doc: exact alphabetical key set; created/status/updated present as null', () => {
  const wire = serializeDoc(mkDoc({ excerpt: undefined }));
  expect(Object.keys(wire)).toEqual([
    'backlinks',
    'created',
    'links',
    'path',
    'status',
    'tags',
    'title',
    'type',
    'updated',
  ]);
  expect(wire.created).toBeNull();
  expect(wire.status).toBeNull();
  expect(wire.updated).toBeNull();
  expect(wire.type).toBe('knowledge');
});

test('excerpt + forge extras appear in alphabetical position; triggeredBy between title and type', () => {
  const wire = serializeDoc(
    mkDoc({
      excerpt: 'preview',
      status: 'complete',
      created: '2026-06-03',
      pipeline: 'p',
      recipe: 'custom',
      role: 'gatherer',
      layer: 0,
      goal: 'g',
      triggeredBy: 'operator',
      reviewStatus: 'reviewed',
      dreamAction: 'da',
    }),
  );
  expect(Object.keys(wire)).toEqual([
    'backlinks',
    'created',
    'dreamAction',
    'excerpt',
    'goal',
    'layer',
    'links',
    'path',
    'pipeline',
    'recipe',
    'reviewStatus',
    'role',
    'status',
    'tags',
    'title',
    'triggeredBy',
    'type',
    'updated',
  ]);
  expect((wire as unknown as Record<string, unknown>).triggeredBy).toBe('operator');
  expect(wire.layer).toBe(0);
});

test('content only present with opts.content; resolved* only when provided; sorted in', () => {
  const withContent = serializeDoc(mkDoc(), {
    content: 'body',
    resolvedBacklinks: [{ path: 'a.md', title: 'A', type: 'knowledge' }],
    resolvedOutbound: [{ target: 't' }],
  });
  expect(Object.keys(withContent)).toEqual([
    'backlinks',
    'content',
    'created',
    'links',
    'path',
    'resolvedBacklinks',
    'resolvedOutbound',
    'status',
    'tags',
    'title',
    'type',
    'updated',
  ]);
  // absent by default
  expect('content' in serializeDoc(mkDoc())).toBe(false);
  expect('resolvedOutbound' in serializeDoc(mkDoc())).toBe(false);
});

test('arrays keep their element order (only keys are alphabetized)', () => {
  const wire = serializeDoc(mkDoc({ tags: ['z', 'a', 'm'], links: ['b', 'a'], backlinks: ['y', 'x'] }));
  expect(wire.tags).toEqual(['z', 'a', 'm']);
  expect(wire.links).toEqual(['b', 'a']);
  expect(wire.backlinks).toEqual(['y', 'x']);
});

test('signature object keys are deep-sorted alphabetically (Regime B nests too)', () => {
  // Live-confirmed against a signed manifest: raw-file order is
  // algorithm, signer, timestamp, content-hash, sig — the wire serves alphabetical.
  const wire = serializeDoc(
    mkDoc({
      signature: {
        algorithm: 'Ed25519',
        signer: 'did:key:z6Mk',
        timestamp: '2026-05-03T01:18:12.831682200+00:00',
        'content-hash': 'sha256:aaf0',
        sig: 'PfGY',
      },
    }),
  );
  expect(Object.keys(wire.signature as Record<string, unknown>)).toEqual([
    'algorithm',
    'content-hash',
    'sig',
    'signer',
    'timestamp',
  ]);
  // values untouched
  expect((wire.signature as Record<string, unknown>).timestamp).toBe('2026-05-03T01:18:12.831682200+00:00');
});

test('the barrel satisfies the CoreModule surface', () => {
  const mod: CoreModule = { buildIndex, shouldExclude, serializeDoc, extractBody, applyChanges, startWatcher };
  expect(typeof mod.buildIndex).toBe('function');
  expect(typeof mod.shouldExclude).toBe('function');
  expect(typeof mod.serializeDoc).toBe('function');
  expect(typeof mod.extractBody).toBe('function');
  expect(typeof mod.applyChanges).toBe('function');
  expect(typeof mod.startWatcher).toBe('function');
});
