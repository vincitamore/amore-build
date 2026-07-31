// ─────────────────────────────────────────────────────────────────────────────
// routes.test.ts — the route layer over a FAKE DaemonDeps. Starts a real Bun
// server on an ephemeral port (buildFetch over the fakes) and drives it with
// fetch: status codes (incl. 404/403/400 with exact body text), envelope shapes,
// filter composition, CORS-on-errors, and the get_file resolved-backlink/outbound
// shapes. Disk-touching routes (get_file, assets) run against a temp org root.
// ─────────────────────────────────────────────────────────────────────────────

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DaemonDeps,
  GraphParams,
  GraphResponse,
  IndexedDoc,
  LinkResolution,
  OrgIndex,
  ProjectFileWire,
  TreeEntry,
  WireDoc,
} from '../contract.ts';
import { searchModule } from '../search/index.ts';
import { buildFetch } from '../server.ts';
import { MISSING_Q_BODY } from './search.ts';

// ── Fakes ────────────────────────────────────────────────────────────────────

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

function fakeSerializeDoc(
  doc: IndexedDoc,
  opts?: { content?: string; resolvedBacklinks?: unknown; resolvedOutbound?: unknown },
): WireDoc {
  const w: Record<string, unknown> = {
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
  if (doc.excerpt !== undefined) w.excerpt = doc.excerpt;
  if (opts?.content !== undefined) w.content = opts.content;
  if (opts?.resolvedBacklinks !== undefined) w.resolvedBacklinks = opts.resolvedBacklinks;
  if (opts?.resolvedOutbound !== undefined) w.resolvedOutbound = opts.resolvedOutbound;
  return w as unknown as WireDoc;
}

function fakeExtractBody(raw: string): string {
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end !== -1) {
      const nl = raw.indexOf('\n', end + 1);
      return nl !== -1 ? raw.slice(nl + 1) : '';
    }
  }
  return raw;
}

const FIXED_GRAPH: GraphResponse = {
  nodes: [],
  links: [],
  scope: { kind: 'workspace', groupBy: 'type', nodeCount: 0, linkCount: 0 },
  clusters: [],
};
let lastGraphParams: GraphParams | null = null;

let tmp: string;
let orgRoot: string;
let deps: DaemonDeps;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'iris-daemon-test-'));
  orgRoot = join(tmp, 'org');
  mkdirSync(orgRoot, { recursive: true });
  mkdirSync(join(orgRoot, 'context'), { recursive: true });
  mkdirSync(join(orgRoot, 'public'), { recursive: true });
  writeFileSync(join(tmp, 'secret.txt'), 'top secret');
  writeFileSync(
    join(orgRoot, 'context', 'voice.md'),
    '---\ntitle: Voice\n---\n# Voice\n\nThis is the body prose.\n',
  );
  writeFileSync(join(orgRoot, 'public', 'logo.svg'), '<svg>logo</svg>');

  const docs: IndexedDoc[] = [
    mkDoc({
      path: 'context/voice.md',
      title: 'Voice',
      docType: 'other',
      updated: '2026-05-01',
      tags: ['t1'],
      links: ['knowledge/a', 'skill://x', 'knowledge/a'], // dup + scheme
      backlinks: ['knowledge/a.md', 'missing/b.md'], // one indexed, one not
    }),
    mkDoc({ path: 'knowledge/a.md', title: 'Article A', docType: 'knowledge', updated: '2026-06-01', tags: ['t1', 't2'] }),
    mkDoc({ path: 'tasks/t.md', title: 'Task T', docType: 'task', status: 'active', updated: '2026-06-02', tags: ['t2'] }),
    mkDoc({ path: 'archive/old.md', title: 'Old', docType: 'archive', status: 'complete', updated: '2026-04-01' }),
    mkDoc({ path: 'inbox/decisions/resolved/r.md', title: 'Resolved', docType: 'inbox', status: 'resolved', updated: '2026-03-01' }),
  ];
  const map = new Map<string, IndexedDoc>();
  for (const d of docs) map.set(d.path, d);

  const index: OrgIndex = {
    docs: map,
    pathMap: new Map(),
    stemMap: new Map(),
    projectMap: new Map(),
    resolve(target: string): LinkResolution {
      if (/^[a-z][a-z0-9+.-]*:\/\//.test(target)) return { kind: 'skip' };
      if (map.has(target)) return { kind: 'resolved', path: target };
      if (map.has(target + '.md')) return { kind: 'resolved', path: target + '.md' };
      return { kind: 'missing' };
    },
  };

  deps = {
    config: { orgRoot, port: 0, startedAt: Date.now() - 5000 },
    index,
    core: { serializeDoc: fakeSerializeDoc, extractBody: fakeExtractBody },
    graph: {
      buildGraph(_index, params): GraphResponse {
        lastGraphParams = params;
        return FIXED_GRAPH;
      },
      loadTypedEdges: () => [],
    },
    projects: {
      listProjects: () => [{ name: 'demo', hasReadme: true, hasClaude: true }],
      getTree(_root, name): TreeEntry[] | null | 'forbidden' {
        if (name === 'missing') return null;
        if (name === 'evil') return 'forbidden';
        return [{ name: 'README.md', path: 'README.md', isDir: false, size: 10, language: 'markdown' }];
      },
      getProjectFile(_root, name): ProjectFileWire | null | 'forbidden' {
        if (name === 'missing') return null;
        if (name === 'evil') return 'forbidden';
        return { path: 'README.md', content: '# hi', language: null, size: 4 };
      },
    },
    search: searchModule,
  };

  server = Bun.serve({ port: 0, fetch: buildFetch(deps) });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  rmSync(tmp, { recursive: true, force: true });
});

const CORS_ORIGIN = 'access-control-allow-origin';
const CORS_VARY = 'vary';

// ── health ───────────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  test('shape + CORS', async () => {
    const r = await fetch(`${baseUrl}/api/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(r.headers.get(CORS_ORIGIN)).toBe('*');
    expect(r.headers.get(CORS_VARY)).toBe(
      'origin, access-control-request-method, access-control-request-headers',
    );
    const body = await r.json() as any;
    expect(body.status).toBe('ok');
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}\+00:00$/);
  });
});

// ── status ───────────────────────────────────────────────────────────────────
describe('GET /api/status', () => {
  test('counts exclude archive/resolved; total includes all', async () => {
    const r = await fetch(`${baseUrl}/api/status`);
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b.documents.total).toBe(5); // all docs
    // byType excludes archive/old.md and inbox/.../resolved/r.md
    expect(b.documents.byType).toEqual({ other: 1, knowledge: 1, task: 1 });
    // byStatus: only non-null status, excluding archive/resolved → just task 'active'
    expect(b.documents.byStatus).toEqual({ active: 1 });
    expect(b.server.connectedClients).toBe(1);
    expect(typeof b.server.uptime).toBe('number');
    expect(b.server.uptime).toBeGreaterThanOrEqual(4);
    // tags over ALL docs: t1 x2, t2 x2 → sorted count-desc then name-asc
    expect(b.tags.total).toBe(2);
    expect(b.tags.top).toEqual([{ tag: 't1', count: 2 }, { tag: 't2', count: 2 }]);
    // recent: updated string-desc, take 5
    expect(b.recent.map((x: { path: string }) => x.path)).toEqual([
      'tasks/t.md',
      'knowledge/a.md',
      'context/voice.md',
      'archive/old.md',
      'inbox/decisions/resolved/r.md',
    ]);
    expect(b.recent[0]).toEqual({ path: 'tasks/t.md', title: 'Task T', type: 'task', updated: '2026-06-02' });
  });
});

// ── launch-presets ─────────────────────────────────────────────────────────
describe('GET /api/launch-presets', () => {
  test('fixed agent preset, key order, backslash cwd, CR input', async () => {
    const r = await fetch(`${baseUrl}/api/launch-presets`);
    const text = await r.text();
    const b = JSON.parse(text);
    expect(b).toHaveLength(1);
    expect(Object.keys(b[0])).toEqual(['id', 'name', 'icon', 'description', 'cwd', 'initial_input']);
    expect(b[0].id).toBe('agent');
    expect(b[0].icon).toBe('✵');
    expect(b[0].initial_input).toBe('claude --system-prompt "."\r');
    expect(b[0].cwd.includes('/')).toBe(false); // pure backslashes
  });
});

// ── files list ───────────────────────────────────────────────────────────────
describe('GET /api/files', () => {
  test('no filter: all docs, count matches', async () => {
    const b = await (await fetch(`${baseUrl}/api/files`)).json() as any;
    expect(b.count).toBe(5);
    expect(b.items).toHaveLength(5);
    // Regime-A envelope key order
    expect(Object.keys(b)).toEqual(['count', 'items']);
  });
  test('type filter (exact derived type)', async () => {
    const b = await (await fetch(`${baseUrl}/api/files?type=knowledge`)).json() as any;
    expect(b.count).toBe(1);
    expect(b.items[0].path).toBe('knowledge/a.md');
  });
  test('prefix + exclude_prefix compose (AND)', async () => {
    const b = await (
      await fetch(`${baseUrl}/api/files?prefix=knowledge/&exclude_prefix=knowledge/z`)
    ).json() as any;
    expect(b.count).toBe(1);
  });
  test('unknown query params ignored', async () => {
    const b = await (await fetch(`${baseUrl}/api/files?tag=x&folder=y&bogus=1`)).json() as any;
    expect(b.count).toBe(5);
  });
});

// ── files get ────────────────────────────────────────────────────────────────
describe('GET /api/files/{*path}', () => {
  test('unindexed → 404 empty with CORS', async () => {
    const r = await fetch(`${baseUrl}/api/files/context/__nope__.md`);
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toBe(null);
    expect(r.headers.get(CORS_ORIGIN)).toBe('*');
    expect(await r.text()).toBe('');
  });
  test('indexed → content + resolved backlinks/outbound', async () => {
    const b = await (await fetch(`${baseUrl}/api/files/context/voice.md`)).json() as any;
    expect(b.path).toBe('context/voice.md');
    expect(b.content).toContain('This is the body prose.');
    expect(b.content).not.toContain('title: Voice'); // frontmatter stripped
    // resolvedBacklinks: only the indexed backlink resolves
    expect(b.resolvedBacklinks).toEqual([
      { path: 'knowledge/a.md', title: 'Article A', type: 'knowledge' },
    ]);
    // resolvedOutbound: distinct, first-seen; scheme → bare {target}; dup dropped
    expect(b.resolvedOutbound).toEqual([
      { resolvedPath: 'knowledge/a.md', target: 'knowledge/a', title: 'Article A', type: 'knowledge' },
      { target: 'skill://x' },
    ]);
  });
});

// ── assets ───────────────────────────────────────────────────────────────────
describe('GET /api/assets/{*path}', () => {
  test('200 with mime + cache-control', async () => {
    const r = await fetch(`${baseUrl}/api/assets/public/logo.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/svg+xml');
    expect(r.headers.get('cache-control')).toBe('private, max-age=300');
    expect(await r.text()).toBe('<svg>logo</svg>');
  });
  test('missing → 404', async () => {
    const r = await fetch(`${baseUrl}/api/assets/public/nope.png`);
    expect(r.status).toBe(404);
  });
  test('traversal escape → 403', async () => {
    const r = await fetch(`${baseUrl}/api/assets/..%2Fsecret.txt`);
    expect(r.status).toBe(403);
    expect(await r.text()).toBe('');
  });
});

// ── search ───────────────────────────────────────────────────────────────────
describe('GET /api/search', () => {
  test('missing q → 400 text/plain exact body', async () => {
    const r = await fetch(`${baseUrl}/api/search`);
    expect(r.status).toBe(400);
    expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(r.headers.get(CORS_ORIGIN)).toBe('*');
    expect(await r.text()).toBe(MISSING_Q_BODY);
  });
  test('present q → 200 envelope; count==total==items.length', async () => {
    const b = await (await fetch(`${baseUrl}/api/search?q=article`)).json() as any;
    expect(Object.keys(b)).toEqual(['query', 'count', 'total', 'items']);
    expect(b.query).toBe('article');
    expect(b.count).toBe(b.total);
    expect(b.count).toBe(b.items.length);
    expect(b.items.some((d: { path: string }) => d.path === 'knowledge/a.md')).toBe(true);
  });
  test('empty q (present) → 200 with zero results', async () => {
    const b = await (await fetch(`${baseUrl}/api/search?q=`)).json() as any;
    expect(b).toEqual({ query: '', count: 0, total: 0, items: [] });
  });
  test('type/tag/limit ignored', async () => {
    const b = await (await fetch(`${baseUrl}/api/search?q=article&type=x&tag=y&limit=1`)).json() as any;
    expect(b.query).toBe('article');
  });
});

// ── graph ────────────────────────────────────────────────────────────────────
describe('GET /api/graph', () => {
  test('param parsing normalization delegated to buildGraph', async () => {
    const r = await fetch(
      `${baseUrl}/api/graph?edges=garbage&group_by=%20%20&depth=3&scope=folder:knowledge&shape=v2`,
    );
    expect(r.status).toBe(200);
    expect(lastGraphParams).toEqual({
      scope: 'folder:knowledge',
      depth: 3,
      groupBy: 'type', // '  ' trimmed → empty → 'type'
      edges: 'wiki', // 'garbage' → wiki
      shape: 'v2',
    });
    const b = await r.json() as any;
    expect(b).toEqual(FIXED_GRAPH);
  });
  test('edges=semantic / both recognized; defaults', async () => {
    await fetch(`${baseUrl}/api/graph?edges=semantic`);
    expect(lastGraphParams!.edges).toBe('semantic');
    await fetch(`${baseUrl}/api/graph?edges=both`);
    expect(lastGraphParams!.edges).toBe('both');
    await fetch(`${baseUrl}/api/graph`);
    expect(lastGraphParams).toEqual({ scope: undefined, depth: 1, groupBy: 'type', edges: 'wiki', shape: undefined });
  });
});

// ── projects ─────────────────────────────────────────────────────────────────
describe('GET /api/projects family', () => {
  test('list', async () => {
    const b = await (await fetch(`${baseUrl}/api/projects`)).json() as any;
    expect(b).toEqual([{ name: 'demo', hasReadme: true, hasClaude: true }]);
  });
  test('tree: ok / 404 / 403', async () => {
    expect((await fetch(`${baseUrl}/api/projects/deployment-cli/tree`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/projects/missing/tree`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/projects/evil/tree`)).status).toBe(403);
  });
  test('file: ProjectFileWire with language null present', async () => {
    const r = await fetch(`${baseUrl}/api/projects/deployment-cli/file/README.md`);
    expect(r.status).toBe(200);
    const b = await r.json() as any;
    expect(b).toEqual({ path: 'README.md', content: '# hi', language: null, size: 4 });
    expect('language' in b).toBe(true); // present as null, not omitted
  });
  test('file: 404 / 403', async () => {
    expect((await fetch(`${baseUrl}/api/projects/missing/file/x.md`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/projects/evil/file/x.md`)).status).toBe(403);
  });
});

// ── router misc ──────────────────────────────────────────────────────────────
describe('router', () => {
  test('unknown route → 404 empty with CORS', async () => {
    const r = await fetch(`${baseUrl}/api/bogus`);
    expect(r.status).toBe(404);
    expect(r.headers.get(CORS_ORIGIN)).toBe('*');
    expect(await r.text()).toBe('');
  });
  test('non-GET method → 404', async () => {
    const r = await fetch(`${baseUrl}/api/health`, { method: 'POST' });
    expect(r.status).toBe(404);
  });
});
