// Agentic ladder: tier-1 gen, brief construction, envelope parse, quote gate,
// live ingest provenance, suppressions, update argv semantics.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn as realSpawn } from 'node:child_process';
import {
  buildAmoreJudgeArgv,
  modelIdFromEnvelope,
  parseJsonEnvelope,
  preferStructuredOutput,
  resolveAmoreBin,
} from './amore-spawn';
import {
  buildBriefUnits,
  formatJudgePrompt,
  JUDGE_JSON_SCHEMA,
  parseJudgeOutput,
} from './brief';
import { generateCandidates, candidateId, pairKey } from './gen';
import { edgeFromVerdict, ingestVerdicts } from './ingest';
import { findQuoteSpan, verifyQuote } from './quote-gate';
import { MECHANISM_JUDGED } from './schema';
import { addSuppression } from './stewardship';
import { listAddressedEdges, readStore, rewriteEdges } from './store';
import { parseUpdateTier, runEdgesUpdate, UpdateError } from './update';

function seed(root: string, rel: string, body: string): void {
  const abs = join(root, ...rel.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body);
}

function house(): string {
  const root = mkdtempSync(join(tmpdir(), 'vinculum-agentic-'));
  mkdirSync(join(root, 'tasks'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'inbox'), { recursive: true });
  mkdirSync(join(root, 'graph'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# house\n');
  return root;
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

describe('tier-1 gen determinism', () => {
  test('same synthetic house yields identical candidate sets', () => {
    const root = house();
    roots.push(root);
    // Hub doc linked from two leaves → co-link pair between leaves
    seed(
      root,
      'knowledge/hub.md',
      `---\ntype: knowledge\ntags: [shared-rare]\n---\n\n# Hub\n\nCentral note.\n`,
    );
    seed(
      root,
      'knowledge/a.md',
      `---\ntype: knowledge\ntags: [shared-rare]\n---\n\n# A\n\nSee [[knowledge/hub]] for context.\nAlso mentions [[knowledge/b]] without a type label.\n`,
    );
    seed(
      root,
      'knowledge/b.md',
      `---\ntype: knowledge\ntags: [shared-rare]\n---\n\n# B\n\nSee [[knowledge/hub]] as well.\n`,
    );

    const r1 = generateCandidates({ orgRoot: root, topPerDoc: 8 });
    const r2 = generateCandidates({ orgRoot: root, topPerDoc: 8 });
    expect(r1.candidates.map((c) => c.id)).toEqual(r2.candidates.map((c) => c.id));
    expect(r1.candidates.map((c) => ({ a: c.a, b: c.b, score: c.score }))).toEqual(
      r2.candidates.map((c) => ({ a: c.a, b: c.b, score: c.score })),
    );
    expect(r1.candidates.length).toBeGreaterThan(0);

    // Unlabeled wikilink a→b should appear
    const uw = r1.candidates.find(
      (c) => pairKey(c.a, c.b) === pairKey('knowledge/a.md', 'knowledge/b.md'),
    );
    expect(uw).toBeDefined();
    expect(uw!.channels.unlabeledWikilink || uw!.channels.colink || uw!.channels.raretag).toBeTruthy();

    // Rare tag shared-rare should nominate a|b (and others)
    const rare = r1.candidates.filter((c) => c.channels.raretag);
    expect(rare.length).toBeGreaterThan(0);
  });

  test('candidate ids are stable sha12 of pair key', () => {
    expect(candidateId('knowledge/a.md', 'knowledge/b.md')).toBe(
      candidateId('knowledge/b.md', 'knowledge/a.md'),
    );
    expect(candidateId('knowledge/a.md', 'knowledge/b.md')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('judge brief construction', () => {
  test('packs candidates into units with excerpts and schema shape', () => {
    const root = house();
    roots.push(root);
    seed(root, 'knowledge/x.md', `---\ntype: knowledge\n---\n\n# X\n\nBody of x.\n`);
    seed(root, 'knowledge/y.md', `---\ntype: knowledge\n---\n\n# Y\n\nBody of y.\n`);
    seed(root, 'knowledge/z.md', `---\ntype: knowledge\n---\n\n# Z\n\nLinks [[knowledge/x]] and [[knowledge/y]].\n`);

    const run = generateCandidates({ orgRoot: root, topPerDoc: 8 });
    const units = buildBriefUnits(root, run, { batchSize: 2 });
    expect(units.length).toBeGreaterThan(0);
    for (const u of units) {
      expect(u.unit).toMatch(/^unit-\d{2}$/);
      expect(u.candidates.length).toBeGreaterThan(0);
      expect(u.candidates[0].excerptA.length).toBeGreaterThan(0);
      const prompt = formatJudgePrompt(u);
      expect(prompt).toContain(u.candidates[0].id);
      expect(prompt).toContain('verdicts');
    }
    expect(JUDGE_JSON_SCHEMA.required).toContain('verdicts');
  });
});

describe('envelope parse', () => {
  test('accept / reject / malformed', () => {
    const accept = parseJudgeOutput({
      verdicts: [
        {
          candidate_id: 'abc',
          verdict: 'accept',
          type: 'builds-on',
          source: 'knowledge/a.md',
          target: 'knowledge/b.md',
          confidence: 0.9,
          quote: 'verbatim',
          quote_source: 'knowledge/a.md',
        },
      ],
    });
    expect(accept.verdicts).toHaveLength(1);
    expect(accept.verdicts[0].verdict).toBe('accept');

    const reject = parseJudgeOutput({
      verdicts: [{ candidate_id: 'abc', verdict: 'reject', rationale: 'no' }],
    });
    expect(reject.verdicts[0].verdict).toBe('reject');

    expect(() => parseJudgeOutput({ not: 'right' })).toThrow(/verdicts/);
    // Malformed items dropped, not thrown
    const soft = parseJudgeOutput({
      verdicts: [{ candidate_id: 'x' }, { verdict: 'accept' }, { candidate_id: 'y', verdict: 'reject' }],
    });
    expect(soft.verdicts).toHaveLength(1);
    expect(soft.verdicts[0].candidate_id).toBe('y');
  });

  test('prefer structuredOutput over text', () => {
    const env = parseJsonEnvelope(
      JSON.stringify({
        text: '{"verdicts":[]}',
        structuredOutput: { verdicts: [{ candidate_id: '1', verdict: 'reject' }] },
        model: 'test-model-from-envelope',
      }),
    );
    const pref = preferStructuredOutput(env);
    expect(pref.source).toBe('structuredOutput');
    expect(modelIdFromEnvelope(env)).toBe('test-model-from-envelope');
  });

  test('argv uses prompt-file + json-schema and never --single', () => {
    const argv = buildAmoreJudgeArgv({
      promptFile: '/tmp/p.md',
      cwd: '/house',
      maxTurns: 4,
      jsonSchema: '{"type":"object"}',
    });
    expect(argv).toContain('--prompt-file');
    expect(argv).toContain('--json-schema');
    expect(argv).toContain('--output-format');
    expect(argv).not.toContain('--single');
  });

  test('resolveAmoreBin prefers AMORE_BIN', () => {
    const prev = process.env.AMORE_BIN;
    try {
      process.env.AMORE_BIN = 'C:/bins/amore.exe';
      expect(resolveAmoreBin()).toBe('C:/bins/amore.exe');
      expect(resolveAmoreBin('/explicit')).toBe('/explicit');
    } finally {
      if (prev === undefined) delete process.env.AMORE_BIN;
      else process.env.AMORE_BIN = prev;
    }
  });
});

describe('quote gate', () => {
  test('verbatim pass, near-miss fail, missing file fail', () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'knowledge/doc.md',
      `---\ntype: knowledge\n---\n\n# Doc\n\nThe builder builds on foundation patterns here.\n`,
    );
    const content = readFileSync(join(root, 'knowledge', 'doc.md'), 'utf8');
    expect(findQuoteSpan(content, 'builds on foundation patterns')).toBe('builds on foundation patterns');
    expect(findQuoteSpan(content, 'builds on foundation patterns XXX')).toBeNull();

    const ok = verifyQuote(root, 'knowledge/doc.md', 'builds on foundation patterns');
    expect(ok.ok).toBe(true);

    const near = verifyQuote(root, 'knowledge/doc.md', 'builds upon foundation patterns');
    expect(near.ok).toBe(false);
    if (!near.ok) expect(near.reason).toMatch(/quote not found/i);

    const miss = verifyQuote(root, 'knowledge/nope.md', 'anything');
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.reason).toMatch(/not found/i);
  });
});

describe('live ingest provenance', () => {
  test('accepted edge lands with tier 2, mechanism judged, model from envelope', () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'knowledge/base.md',
      `---\ntype: knowledge\n---\n\n# Base\n\nFoundation patterns for the stack.\n`,
    );
    seed(
      root,
      'knowledge/app.md',
      `---\ntype: knowledge\n---\n\n# App\n\nThe builder builds on foundation patterns for the stack.\n`,
    );

    const quote = 'The builder builds on foundation patterns for the stack.';
    const built = edgeFromVerdict(
      root,
      {
        candidate_id: candidateId('knowledge/app.md', 'knowledge/base.md'),
        verdict: 'accept',
        type: 'builds-on',
        source: 'knowledge/app.md',
        target: 'knowledge/base.md',
        confidence: 0.9,
        quote,
        quote_source: 'knowledge/app.md',
      },
      { modelId: 'stub-model-xyz', ts: '2026-08-05T15:00:00.000Z' },
    );
    expect('edge' in built).toBe(true);
    if (!('edge' in built)) return;
    expect(built.edge.provenance.tier).toBe('2');
    expect(built.edge.provenance.mechanism).toBe(MECHANISM_JUDGED);
    expect(built.edge.provenance.model).toBe('stub-model-xyz');
    expect(built.edge.provenance.asserted_by).toBe('judge-v1');
    expect(built.edge.evidence?.quote).toContain('builder builds on');

    const ingest = ingestVerdicts(
      root,
      [
        {
          candidate_id: candidateId('knowledge/app.md', 'knowledge/base.md'),
          verdict: 'accept',
          type: 'builds-on',
          source: 'knowledge/app.md',
          target: 'knowledge/base.md',
          confidence: 0.9,
          quote,
          quote_source: 'knowledge/app.md',
        },
      ],
      { modelId: 'stub-model-xyz', ts: '2026-08-05T15:00:00.000Z' },
    );
    expect(ingest.accepted).toBe(1);
    expect(ingest.added).toBe(1);
    const { edges } = readStore(root);
    expect(edges).toHaveLength(1);
    expect(edges[0].provenance.model).toBe('stub-model-xyz');
    expect(edges[0].provenance.mechanism).toBe('judged');
  });

  test('suppression honored on re-ingest', () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'knowledge/base.md',
      `---\ntype: knowledge\n---\n\n# Base\n\nFoundation patterns for the stack.\n`,
    );
    seed(
      root,
      'knowledge/app.md',
      `---\ntype: knowledge\n---\n\n# App\n\nThe builder builds on foundation patterns for the stack.\n`,
    );
    const quote = 'The builder builds on foundation patterns for the stack.';
    const verdict = {
      candidate_id: 'cid',
      verdict: 'accept' as const,
      type: 'builds-on',
      source: 'knowledge/app.md',
      target: 'knowledge/base.md',
      confidence: 0.9,
      quote,
      quote_source: 'knowledge/app.md',
    };
    const first = ingestVerdicts(root, [verdict], { modelId: 'm1' });
    expect(first.accepted).toBe(1);
    const edge = first.edges[0];
    addSuppression(root, edge);
    // remove from store like remove verb
    rewriteEdges(root, []);
    const second = ingestVerdicts(root, [verdict], { modelId: 'm1' });
    expect(second.accepted).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(readStore(root).edges).toHaveLength(0);
  });

  test('quote gate failure drops with reason', () => {
    const root = house();
    roots.push(root);
    seed(root, 'knowledge/base.md', `---\ntype: knowledge\n---\n\n# Base\n\nHello.\n`);
    seed(root, 'knowledge/app.md', `---\ntype: knowledge\n---\n\n# App\n\nWorld.\n`);
    const r = ingestVerdicts(
      root,
      [
        {
          candidate_id: 'x',
          verdict: 'accept',
          type: 'builds-on',
          source: 'knowledge/app.md',
          target: 'knowledge/base.md',
          confidence: 0.9,
          quote: 'this quote does not appear anywhere',
          quote_source: 'knowledge/app.md',
        },
      ],
      { modelId: 'm' },
    );
    expect(r.accepted).toBe(0);
    expect(r.dropped[0].reason).toMatch(/quote not found/i);
  });
});

describe('update ladder', () => {
  test('parseUpdateTier defaults and validates', () => {
    expect(parseUpdateTier(undefined)).toBe(0);
    expect(parseUpdateTier('0')).toBe(0);
    expect(parseUpdateTier('1')).toBe(1);
    expect(parseUpdateTier('2')).toBe(2);
    expect(() => parseUpdateTier('9')).toThrow(UpdateError);
  });

  test('tier 0 structural re-derive lands edges', async () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'tasks/blocker.md',
      `---\ntype: task\nstatus: active\n---\n\n# Blocker\n`,
    );
    seed(
      root,
      'tasks/blocked.md',
      `---\ntype: task\nstatus: blocked\nblocked-by:\n  - "[[tasks/blocker]]"\n---\n\n# Blocked\n`,
    );
    const s = await runEdgesUpdate({ orgRoot: root, tier: 0 });
    expect(s.ok).toBe(true);
    expect(s.tier).toBe(0);
    expect(s.structural?.derived).toBeGreaterThanOrEqual(1);
    expect(s.added).toBeGreaterThanOrEqual(1);
    expect(readStore(root).edges.length).toBeGreaterThanOrEqual(1);
  });

  test('tier 1 gen only — no land', async () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'knowledge/hub.md',
      `---\ntype: knowledge\ntags: [t]\n---\n\n# Hub\n`,
    );
    seed(
      root,
      'knowledge/a.md',
      `---\ntype: knowledge\ntags: [t]\n---\n\n# A\n\n[[knowledge/hub]]\n`,
    );
    seed(
      root,
      'knowledge/b.md',
      `---\ntype: knowledge\ntags: [t]\n---\n\n# B\n\n[[knowledge/hub]]\n`,
    );
    const s = await runEdgesUpdate({ orgRoot: root, tier: 1 });
    expect(s.tier).toBe(1);
    expect(s.candidates?.count).toBeGreaterThan(0);
    expect(s.candidates?.ids?.length).toBe(s.candidates?.count);
    expect(readStore(root).edges).toHaveLength(0);
  });

  test('tier 2 with judge stub lands provenance edges', async () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'knowledge/base.md',
      `---\ntype: knowledge\ntags: [pair]\n---\n\n# Base\n\nFoundation patterns for the stack.\n`,
    );
    seed(
      root,
      'knowledge/app.md',
      `---\ntype: knowledge\ntags: [pair]\n---\n\n# App\n\nThe builder builds on foundation patterns for the stack.\nRelated: [[knowledge/base]]\n`,
    );

    const s = await runEdgesUpdate({
      orgRoot: root,
      tier: 2,
      skipBinaryCheck: true,
      judgeStub: () => ({
        verdicts: [
          {
            candidate_id: candidateId('knowledge/app.md', 'knowledge/base.md'),
            verdict: 'accept',
            type: 'builds-on',
            source: 'knowledge/app.md',
            target: 'knowledge/base.md',
            confidence: 0.91,
            quote: 'The builder builds on foundation patterns for the stack.',
            quote_source: 'knowledge/app.md',
          },
        ],
      }),
    });
    expect(s.ok).toBe(true);
    expect(s.tier).toBe(2);
    expect(s.judge?.accepted).toBeGreaterThanOrEqual(1);
    expect(s.added).toBeGreaterThanOrEqual(1);
    const { edges } = readStore(root);
    const judged = edges.filter((e) => e.provenance.mechanism === 'judged');
    expect(judged.length).toBeGreaterThanOrEqual(1);
    expect(judged[0].provenance.tier).toBe('2');

    // list filters
    const byMech = listAddressedEdges(root, { mechanism: 'judged' });
    expect(byMech.count).toBeGreaterThanOrEqual(1);
    const byTier = listAddressedEdges(root, { tier: '2' });
    expect(byTier.count).toBeGreaterThanOrEqual(1);
    const recent = listAddressedEdges(root, { recent: 1 });
    expect(recent.count).toBe(1);
  });

  test('tier 2 missing binary is honest UpdateError', async () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'knowledge/a.md',
      `---\ntype: knowledge\ntags: [z]\n---\n\n# A\n\n[[knowledge/b]]\n`,
    );
    seed(
      root,
      'knowledge/b.md',
      `---\ntype: knowledge\ntags: [z]\n---\n\n# B\n`,
    );
    await expect(
      runEdgesUpdate({
        orgRoot: root,
        tier: 2,
        amoreBin: join(root, 'definitely-missing-amore-binary.exe'),
        skipBinaryCheck: false,
      }),
    ).rejects.toThrow(/amore binary not found/i);
  });

  test('stubbed spawn path returns model from envelope', async () => {
    const root = house();
    roots.push(root);
    seed(
      root,
      'knowledge/base.md',
      `---\ntype: knowledge\ntags: [pair]\n---\n\n# Base\n\nFoundation patterns for the stack.\n`,
    );
    seed(
      root,
      'knowledge/app.md',
      `---\ntype: knowledge\ntags: [pair]\n---\n\n# App\n\nThe builder builds on foundation patterns for the stack.\nRelated: [[knowledge/base]]\n`,
    );

    // Write a tiny stub script is hard cross-platform; use spawnImpl that returns envelope JSON.
    const spawnImpl = ((_bin: string, _argv: string[], _opts: unknown) => {
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      const child = {
        pid: 12345,
        stdout: {
          on(ev: string, cb: (d: Buffer) => void) {
            if (ev === 'data') {
              queueMicrotask(() =>
                cb(
                  Buffer.from(
                    JSON.stringify({
                      model: 'envelope-reported-model',
                      structuredOutput: {
                        verdicts: [
                          {
                            candidate_id: candidateId('knowledge/app.md', 'knowledge/base.md'),
                            verdict: 'accept',
                            type: 'builds-on',
                            source: 'knowledge/app.md',
                            target: 'knowledge/base.md',
                            confidence: 0.88,
                            quote: 'The builder builds on foundation patterns for the stack.',
                            quote_source: 'knowledge/app.md',
                          },
                        ],
                      },
                    }),
                  ),
                ),
              );
            }
            return child.stdout;
          },
        },
        stderr: {
          on() {
            return child.stderr;
          },
        },
        on(ev: string, cb: (...a: unknown[]) => void) {
          handlers[ev] = handlers[ev] ?? [];
          handlers[ev].push(cb);
          if (ev === 'close') queueMicrotask(() => cb(0));
          return child;
        },
        kill() {
          return true;
        },
      };
      return child as unknown as ReturnType<typeof realSpawn>;
    }) as typeof realSpawn;

    const s = await runEdgesUpdate({
      orgRoot: root,
      tier: 2,
      spawnImpl,
      skipBinaryCheck: true,
      amoreBin: 'stub-amore',
    });
    expect(s.judge?.model).toBe('envelope-reported-model');
    const judged = readStore(root).edges.filter((e) => e.provenance.mechanism === 'judged');
    expect(judged[0]?.provenance.model).toBe('envelope-reported-model');
  });
});
