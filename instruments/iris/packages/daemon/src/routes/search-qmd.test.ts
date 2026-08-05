import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DaemonDeps,
  IndexedDoc,
  LinkResolution,
  OrgIndex,
  WireDoc,
} from '../contract.ts';
import { searchModule } from '../search/index.ts';
import { buildFetch } from '../server.ts';
import { MISSING_Q_BODY } from './search.ts';

function mkDoc(p: Partial<IndexedDoc> & { path: string }): IndexedDoc {
  return {
    path: p.path,
    title: p.title ?? p.path,
    docType: p.docType ?? 'other',
    status: p.status ?? null,
    created: p.created ?? null,
    updated: p.updated ?? null,
    tags: p.tags ?? [],
    links: p.links ?? [],
    backlinks: p.backlinks ?? [],
    excerpt: p.excerpt,
  };
}

function fakeSerializeDoc(doc: IndexedDoc): WireDoc {
  return {
    backlinks: doc.backlinks,
    created: doc.created,
    links: doc.links,
    path: doc.path,
    status: doc.status,
    tags: doc.tags,
    title: doc.title,
    type: doc.docType,
    updated: doc.updated,
  };
}

let tmp: string;
let orgRoot: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let qmdCalls: Array<{ mode: string; q: string }> = [];

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'iris-search-qmd-'));
  orgRoot = join(tmp, 'org');
  mkdirSync(orgRoot, { recursive: true });
  writeFileSync(join(orgRoot, 'knowledge-a.md'), '# A\n');

  const docs = [
    mkDoc({ path: 'knowledge/a.md', title: 'Article A', docType: 'knowledge', tags: ['auth'] }),
    mkDoc({ path: 'tasks/t.md', title: 'Task T', docType: 'task', status: 'active' }),
  ];
  const map = new Map(docs.map((d) => [d.path, d]));
  const index: OrgIndex = {
    docs: map,
    pathMap: new Map(),
    stemMap: new Map(),
    projectMap: new Map(),
    resolve(): LinkResolution {
      return { kind: 'missing' };
    },
  };

  const deps: DaemonDeps = {
    config: { orgRoot, port: 0, startedAt: Date.now() },
    index,
    core: { serializeDoc: fakeSerializeDoc, extractBody: (s) => s },
    graph: {
      buildGraph: () => ({
        nodes: [],
        links: [],
        scope: { kind: 'workspace', groupBy: 'type', nodeCount: 0, linkCount: 0 },
        clusters: [],
      }),
      loadTypedEdges: () => [],
    },
    projects: {
      listProjects: () => [],
      getTree: () => null,
      getProjectFile: () => null,
    },
    search: searchModule,
    qmd: {
      search: async (_root, query, mode, _limit) => {
        qmdCalls.push({ mode, q: query });
        if (mode === 'lex' && query === 'missing-backend') {
          return {
            available: false,
            reason: 'not-installed',
            backend: 'qmd',
            mode,
            query,
            items: [],
          };
        }
        return {
          available: true,
          backend: 'qmd',
          mode,
          query,
          items: [{ path: 'knowledge/a.md', title: 'Article A', score: 0.88, snippet: 'auth bits' }],
        };
      },
      status: async () => ({ state: 'ready-lex', available: true }),
      refresh: null,
    },
  };

  server = Bun.serve({ port: 0, fetch: buildFetch(deps) });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/search modes', () => {
  test('missing q → 400 exact body (byte-compatible)', async () => {
    const r = await fetch(`${baseUrl}/api/search`);
    expect(r.status).toBe(400);
    expect(await r.text()).toBe(MISSING_Q_BODY);
  });

  test('mode=index default is fuzzy envelope without backend key', async () => {
    const r = await fetch(`${baseUrl}/api/search?q=Article`);
    const b = (await r.json()) as Record<string, unknown>;
    expect(r.status).toBe(200);
    expect(b.query).toBe('Article');
    expect(Array.isArray(b.items)).toBe(true);
    expect(b.backend).toBeUndefined();
    expect(b.available).toBeUndefined();
    expect(Object.keys(b).sort()).toEqual(['count', 'items', 'query', 'total'].sort());
  });

  test('mode=lex proxies qmd and adds backend', async () => {
    qmdCalls = [];
    const r = await fetch(`${baseUrl}/api/search?q=auth&mode=lex&limit=10`);
    const b = (await r.json()) as {
      available: boolean;
      backend: string;
      mode: string;
      items: Array<{ path: string; snippet?: string; score?: number }>;
    };
    expect(r.status).toBe(200);
    expect(b.available).toBe(true);
    expect(b.backend).toBe('qmd');
    expect(b.mode).toBe('lex');
    expect(b.items[0]!.path).toBe('knowledge/a.md');
    expect(b.items[0]!.snippet).toBe('auth bits');
    expect(qmdCalls).toEqual([{ mode: 'lex', q: 'auth' }]);
  });

  test('mode=lex available:false is HTTP 200 with reason', async () => {
    const r = await fetch(`${baseUrl}/api/search?q=missing-backend&mode=lex`);
    const b = (await r.json()) as {
      available: boolean;
      reason: string;
      items: unknown[];
      count: number;
    };
    expect(r.status).toBe(200);
    expect(b.available).toBe(false);
    expect(b.reason).toBe('not-installed');
    expect(b.items).toEqual([]);
    expect(b.count).toBe(0);
  });

  test('mode=query and mode=vec reach qmd', async () => {
    qmdCalls = [];
    await fetch(`${baseUrl}/api/search?q=x&mode=vec`);
    await fetch(`${baseUrl}/api/search?q=y&mode=query`);
    expect(qmdCalls.map((c) => c.mode)).toEqual(['vec', 'query']);
  });
});

describe('GET /api/status qmd block', () => {
  test('includes qmd status from module', async () => {
    const r = await fetch(`${baseUrl}/api/status`);
    const b = (await r.json()) as { qmd: { state: string; available: boolean } };
    expect(b.qmd.state).toBe('ready-lex');
    expect(b.qmd.available).toBe(true);
  });
});
