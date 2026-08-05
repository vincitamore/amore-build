// routes/lucerna.test.ts — Lucerna route dispatch + server wiring around GET-only guard.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonConfig, DaemonDeps, LinkResolution, OrgIndex } from '../contract.ts';
import { buildFetch } from '../server.ts';
import { lucernaRoute } from './lucerna.ts';

let org: string;
let ldir: string;
let config: DaemonConfig;

beforeEach(() => {
  org = mkdtempSync(join(tmpdir(), 'iris-lucroute-'));
  ldir = join(org, 'instruments', 'lucerna');
  config = { orgRoot: org, port: 0, startedAt: Date.now() };
});
afterEach(() => rmSync(org, { recursive: true, force: true }));

const ensureDir = () => mkdirSync(ldir, { recursive: true });
const wf = (name: string, content: string) => {
  ensureDir();
  writeFileSync(join(ldir, name), content);
};
const CORS = 'access-control-allow-origin';
const get = (path: string) => new Request(`http://localhost${path}`, { method: 'GET' });
const post = (path: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('GET reads', () => {
  test('health → 200 json + CORS', async () => {
    wf(
      'health.json',
      JSON.stringify({
        pid: 9,
        lastBeat: new Date().toISOString(),
        version: '0.1.0',
      }),
    );
    const r = await lucernaRoute(config, get('/api/lucerna/health'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get(CORS)).toBe('*');
    const b = (await r.json()) as { available: boolean; pid?: number };
    expect(b.available).toBe(true);
    expect(b.pid).toBe(9);
  });

  test('status + log?n= honored', async () => {
    ensureDir();
    const rs = await lucernaRoute(config, get('/api/lucerna/status'));
    expect(rs.status).toBe(200);
    const bs = (await rs.json()) as { available: boolean; enablement: { dreamsEnabled: boolean } };
    expect(bs.available).toBe(true);
    expect(bs.enablement.dreamsEnabled).toBe(false);

    wf('log', ['a', 'b', 'c'].join('\n'));
    const rl = await lucernaRoute(config, get('/api/lucerna/log?n=2'));
    const bl = (await rl.json()) as { lines: string[]; total: number; available: boolean };
    expect(bl.available).toBe(true);
    expect(bl.total).toBe(3);
    expect(bl.lines).toHaveLength(2);
  });

  test('missing lucerna dir → available:false reason not-installed', async () => {
    const b = (await (await lucernaRoute(config, get('/api/lucerna/health'))).json()) as {
      available: boolean;
      reason?: string;
    };
    expect(b.available).toBe(false);
    expect(b.reason).toBe('not-installed');
  });
});

describe('POST governance', () => {
  test('halt → ok + sentinel', async () => {
    ensureDir();
    const r = await lucernaRoute(config, post('/api/lucerna/halt', {}));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ available: true, ok: true });
    expect(readFileSync(join(ldir, 'halt'), 'utf8')).toBe('halted from iris');
  });

  test('wake + sleep sentinels', async () => {
    ensureDir();
    expect(await (await lucernaRoute(config, post('/api/lucerna/wake', {}))).json()).toEqual({
      available: true,
      ok: true,
    });
    expect(existsSync(join(ldir, 'wake'))).toBe(true);
    expect(await (await lucernaRoute(config, post('/api/lucerna/sleep', {}))).json()).toEqual({
      available: true,
      ok: true,
    });
    expect(existsSync(join(ldir, 'sleep'))).toBe(true);
  });

  test('halt when not installed → ok false', async () => {
    const b = (await (await lucernaRoute(config, post('/api/lucerna/halt', {}))).json()) as {
      available: boolean;
      ok: boolean;
      reason?: string;
    };
    expect(b.available).toBe(false);
    expect(b.ok).toBe(false);
    expect(b.reason).toBe('not-installed');
  });

  test('enable writes enablement file', async () => {
    ensureDir();
    const r = await lucernaRoute(
      config,
      post('/api/lucerna/enable', { dreamsEnabled: true, autoCommitLive: false }),
    );
    expect(r.status).toBe(200);
    const b = (await r.json()) as {
      ok: boolean;
      enablement: { dreamsEnabled: boolean; autoCommitLive: boolean };
    };
    expect(b.ok).toBe(true);
    expect(b.enablement).toEqual({ dreamsEnabled: true, autoCommitLive: false });
    expect(JSON.parse(readFileSync(join(ldir, 'lucerna.enable.json'), 'utf8'))).toEqual({
      dreamsEnabled: true,
      autoCommitLive: false,
    });
  });

  test('enable rejects empty body', async () => {
    ensureDir();
    const r = await lucernaRoute(config, post('/api/lucerna/enable', {}));
    expect(r.status).toBe(400);
  });
});

describe('GET notifications + pulse', () => {
  test('notifications absent → empty', async () => {
    ensureDir();
    const r = await lucernaRoute(config, get('/api/lucerna/notifications'));
    expect(r.status).toBe(200);
    const b = (await r.json()) as { available: boolean; entries: unknown[]; total: number };
    expect(b.available).toBe(true);
    expect(b.entries).toEqual([]);
    expect(b.total).toBe(0);
  });

  test('pulse shape', async () => {
    ensureDir();
    const r = await lucernaRoute(config, get('/api/lucerna/pulse'));
    expect(r.status).toBe(200);
    const b = (await r.json()) as {
      available: boolean;
      state: string;
      beatAgeSec: number | null;
      lastNotification: unknown;
    };
    expect(b.available).toBe(true);
    expect(b.state).toBe('stopped');
    expect(b).toHaveProperty('lastNotification');
  });
});

describe('method / path mismatch → 404', () => {
  test('GET on POST-only halt → 404', async () => {
    const r = await lucernaRoute(config, get('/api/lucerna/halt'));
    expect(r.status).toBe(404);
    expect(r.headers.get(CORS)).toBe('*');
  });
  test('POST on GET-only health → 404', async () => {
    expect((await lucernaRoute(config, post('/api/lucerna/health', {}))).status).toBe(404);
  });
  test('unknown subpath → 404', async () => {
    expect((await lucernaRoute(config, get('/api/lucerna/conversation'))).status).toBe(404);
  });
});

describe('server.ts dispatch', () => {
  function minimalDeps(cfg: DaemonConfig): DaemonDeps {
    const index: OrgIndex = {
      docs: new Map(),
      pathMap: new Map(),
      stemMap: new Map(),
      projectMap: new Map(),
      resolve: (): LinkResolution => ({ kind: 'missing' }),
    };
    return {
      config: cfg,
      index,
      core: { serializeDoc: () => ({}) as never, extractBody: (r) => r },
      graph: { buildGraph: () => ({}) as never, loadTypedEdges: () => [] },
      projects: { listProjects: () => [], getTree: () => null, getProjectFile: () => null },
      search: { fuzzyMatch: () => null, search: () => [] },
    };
  }

  test('lucerna GET + POST route around the GET-only guard', async () => {
    ensureDir();
    writeFileSync(
      join(ldir, 'health.json'),
      JSON.stringify({ lastBeat: new Date().toISOString(), version: '0.1.0' }),
    );
    const fetchFn = buildFetch(minimalDeps(config));

    const h = await fetchFn(get('/api/lucerna/health'));
    expect(h.status).toBe(200);
    expect(((await h.json()) as { available: boolean }).available).toBe(true);

    const halt = await fetchFn(post('/api/lucerna/halt', {}));
    expect(halt.status).toBe(200);
    expect(existsSync(join(ldir, 'halt'))).toBe(true);

    // Non-lucerna POST still blocked by GET-only guard
    expect((await fetchFn(post('/api/health', {}))).status).toBe(404);
    expect((await fetchFn(get('/api/bogus'))).status).toBe(404);
  });
});
