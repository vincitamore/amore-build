import { test, expect } from 'bun:test';
import { ENDPOINTS, coreEndpoints, endpointSlug, tierCounts } from './inventory';
import { CASES, casesForEndpoint, IGNORE } from './cases';

test('every core endpoint has ≥1 case', () => {
  for (const e of coreEndpoints()) {
    const cases = casesForEndpoint(e.path);
    expect(cases.length, `${e.method} ${e.path} has no case`).toBeGreaterThanOrEqual(1);
  }
});

test('every case references a real endpoint template', () => {
  const paths = new Set(ENDPOINTS.map((e) => e.path));
  for (const c of CASES) {
    expect(paths.has(c.endpoint), `case ${c.id} references unknown endpoint ${c.endpoint}`).toBe(true);
  }
});

test('every recorded case targets a core (not mutating/excluded) endpoint', () => {
  const coreSet = new Set(coreEndpoints().map((e) => e.path));
  for (const c of CASES) {
    expect(coreSet.has(c.endpoint), `case ${c.id} targets non-core ${c.endpoint}`).toBe(true);
  }
});

test('every recorded case is a GET (read-only default matrix)', () => {
  for (const c of CASES) expect(c.method, `${c.id} is not GET`).toBe('GET');
});

test('case ids are unique within each endpoint', () => {
  const seen = new Set<string>();
  for (const c of CASES) {
    const key = `${c.endpoint}::${c.id}`;
    expect(seen.has(key), `duplicate case id ${key}`).toBe(false);
    seen.add(key);
  }
});

test('endpoint slugs are unique across core (no golden-dir collisions)', () => {
  const slugs = coreEndpoints().map((e) => endpointSlug(e.path));
  expect(new Set(slugs).size).toBe(slugs.length);
});

test('endpointSlug is filesystem-safe', () => {
  expect(endpointSlug('/api/files/{*path}')).toBe('api-files-path');
  expect(endpointSlug('/api/projects/{name}/tree')).toBe('api-projects-name-tree');
  expect(endpointSlug('/api/graph')).toBe('api-graph');
  for (const e of ENDPOINTS) {
    expect(endpointSlug(e.path)).toMatch(/^[a-z0-9-]+$/);
  }
});

test('ignore lists key only known endpoint templates', () => {
  const paths = new Set(ENDPOINTS.map((e) => e.path));
  for (const key of Object.keys(IGNORE)) {
    expect(paths.has(key), `IGNORE references unknown endpoint ${key}`).toBe(true);
  }
});

test('tier counts sum to the full inventory', () => {
  const c = tierCounts();
  expect(c.core + c.inventory + c.mutating + c.excluded).toBe(ENDPOINTS.length);
  expect(c.core).toBeGreaterThan(0);
});

test('no endpoint is registered twice (method+path unique)', () => {
  const seen = new Set<string>();
  for (const e of ENDPOINTS) {
    const key = `${e.method} ${e.path}`;
    expect(seen.has(key), `duplicate registration ${key}`).toBe(false);
    seen.add(key);
  }
});
