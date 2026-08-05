// lucerna-review.test.ts — dream/proposal list ordering, frontmatter parse,
// and atomic single-field review verbs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyProposal,
  closeProposal,
  dedupeDreamItems,
  flipFrontmatterField,
  lightBelongsToManifest,
  listDreams,
  listProposals,
  parseFrontmatterLenient,
  parseManifestStamp,
  pendingReviewCounts,
  reviewDream,
  showDream,
  showProposal,
  type DreamItem,
} from './lucerna-review.ts';

let org: string;

beforeEach(() => {
  org = mkdtempSync(join(tmpdir(), 'iris-lreview-'));
});
afterEach(() => rmSync(org, { recursive: true, force: true }));

function seedManifest(
  name: string,
  fm: Record<string, string | string[]>,
  body = 'Body line.\n',
): string {
  const dir = join(org, 'forge', 'dreams', 'sessions');
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${v}`;
  });
  const raw = `---\n${lines.join('\n')}\n---\n${body}`;
  const path = join(dir, name);
  writeFileSync(path, raw);
  return path;
}

function seedLight(name: string, fm: Record<string, string | string[]>, body = 'Light.\n'): string {
  const dir = join(org, 'forge', 'dreams');
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${v}`;
  });
  const raw = `---\n${lines.join('\n')}\n---\n${body}`;
  const path = join(dir, name);
  writeFileSync(path, raw);
  return path;
}

function seedProposal(
  name: string,
  fm: Record<string, string | string[]>,
  body = 'Proposal body.\n',
  sub?: string,
): string {
  const dir = sub ? join(org, 'forge', 'proposals', sub) : join(org, 'forge', 'proposals');
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.join(', ')}]`;
    return `${k}: ${v}`;
  });
  const raw = `---\n${lines.join('\n')}\n---\n${body}`;
  const path = join(dir, name);
  writeFileSync(path, raw);
  return path;
}

function ensureLucerna(dreamsEnabled = false): void {
  mkdirSync(join(org, 'instruments', 'lucerna'), { recursive: true });
  writeFileSync(
    join(org, 'instruments', 'lucerna', 'lucerna.enable.json'),
    JSON.stringify({ dreamsEnabled, autoCommitLive: false }, null, 2) + '\n',
  );
}

describe('parseFrontmatterLenient', () => {
  test('parses protocol §3 dream manifest fields', () => {
    const raw = `---
type: forge
pipeline: dream-tag-regen
recipe: dream
goal: "Run tag regen: phase 1"
created: '2026-08-05'
triggered-by: dream
review-status: pending
tags: [dream, tag-regen]
---
What ran.
`;
    const { fm, body, hasFence } = parseFrontmatterLenient(raw);
    expect(hasFence).toBe(true);
    expect(fm.type).toBe('forge');
    expect(fm.pipeline).toBe('dream-tag-regen');
    expect(fm.recipe).toBe('dream');
    expect(fm.goal).toBe('Run tag regen: phase 1');
    expect(fm.created).toBe('2026-08-05');
    expect(fm['triggered-by']).toBe('dream');
    expect(fm['review-status']).toBe('pending');
    expect(fm.tags).toEqual(['dream', 'tag-regen']);
    expect(body.startsWith('What ran.')).toBe(true);
  });

  test('partial / malformed frontmatter does not throw', () => {
    const { fm, hasFence } = parseFrontmatterLenient('no fence at all\n');
    expect(hasFence).toBe(false);
    expect(fm).toEqual({});

    const partial = parseFrontmatterLenient(`---
type: forge
goal: has: embedded colon
---
x
`);
    expect(partial.fm.goal).toBe('has: embedded colon');
    expect(partial.fm['review-status']).toBeUndefined();
  });
});

describe('listDreams ordering + kinds', () => {
  test('pending first, newest first; manifests + light kind-tagged', () => {
    ensureLucerna(true);
    seedManifest('20260801-100000-old.manifest.md', {
      type: 'forge',
      pipeline: 'dream-old',
      recipe: 'dream',
      goal: '"old pending"',
      created: "'2026-08-01'",
      'triggered-by': 'dream',
      'review-status': 'pending',
      tags: ['dream', 'old'],
    });
    seedManifest('20260805-120000-new.manifest.md', {
      type: 'forge',
      pipeline: 'dream-new',
      recipe: 'dream',
      goal: '"new reviewed"',
      created: "'2026-08-05'",
      'triggered-by': 'dream',
      'review-status': 'reviewed',
      tags: ['dream', 'new'],
    });
    seedManifest('20260804-090000-mid.manifest.md', {
      type: 'forge',
      pipeline: 'dream-mid',
      recipe: 'dream',
      goal: '"mid pending"',
      created: "'2026-08-04'",
      'triggered-by': 'dream',
      'review-status': 'pending',
      tags: ['dream', 'mid'],
    });
    seedLight('light-report.md', {
      type: 'forge',
      'dream-action': 'tag-regen',
      status: 'pending',
      created: "'2026-08-03'",
    });
    // non-md skipped
    writeFileSync(join(org, 'forge', 'dreams', 'sessions', 'notes.txt'), 'skip');

    const list = listDreams(org);
    expect(list.available).toBe(true);
    expect(list.dreamsEnabled).toBe(true);
    expect(list.lucernaInstalled).toBe(true);
    expect(list.items).toHaveLength(4);
    // pending first: old, mid, light — then reviewed new
    const pendingIds = list.items.filter((i) =>
      i.kind === 'manifest' ? i.reviewStatus === 'pending' : i.status === 'pending',
    );
    expect(pendingIds).toHaveLength(3);
    expect(list.items[0].reviewStatus === 'pending' || list.items[0].status === 'pending').toBe(
      true,
    );
    // among pending, newest created first
    const pendingManifests = list.items.filter(
      (i) => i.kind === 'manifest' && i.reviewStatus === 'pending',
    );
    expect(pendingManifests[0].created).toBe('2026-08-04');
    expect(pendingManifests[1].created).toBe('2026-08-01');
    // reviewed last
    expect(list.items[list.items.length - 1].reviewStatus).toBe('reviewed');
    // light kind
    const light = list.items.find((i) => i.kind === 'light');
    expect(light?.dreamAction).toBe('tag-regen');
    expect(list.pendingCount).toBe(3);
  });

  test('--pending filters to pending only', () => {
    ensureLucerna();
    seedManifest('a.manifest.md', {
      type: 'forge',
      'review-status': 'pending',
      created: "'2026-08-05'",
    });
    seedManifest('b.manifest.md', {
      type: 'forge',
      'review-status': 'reviewed',
      created: "'2026-08-05'",
    });
    const list = listDreams(org, { pendingOnly: true });
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe('a');
  });

  test('honest empty: no dreams yet', () => {
    ensureLucerna(false);
    const list = listDreams(org);
    expect(list.items).toEqual([]);
    expect(list.pendingCount).toBe(0);
    expect(list.total).toBe(0);
    expect(list.dreamsEnabled).toBe(false);
    expect(list.lucernaInstalled).toBe(true);
  });

  test('lucerna not installed still lists forge artifacts with flag', () => {
    seedManifest('x.manifest.md', {
      type: 'forge',
      'review-status': 'pending',
      created: "'2026-08-05'",
    });
    const list = listDreams(org);
    expect(list.lucernaInstalled).toBe(false);
    expect(list.dreamsEnabled).toBe(false);
    expect(list.items).toHaveLength(1);
  });

  test('missing fields render as absent (no crash)', () => {
    ensureLucerna();
    seedManifest('sparse.manifest.md', {
      type: 'forge',
    });
    const list = listDreams(org);
    expect(list.items[0].reviewStatus).toBeUndefined();
    expect(list.items[0].goal).toBeUndefined();
    expect(list.items[0].triggeredBy).toBeUndefined();
  });
});

describe('listProposals', () => {
  test('pending first; status pending preferred', () => {
    ensureLucerna();
    seedProposal('old.md', {
      type: 'proposal',
      status: 'pending',
      created: "'2026-08-01'",
      title: '"Old"',
      target: 'a.md',
      'triggered-by': 'dream',
    });
    seedProposal('new.md', {
      type: 'proposal',
      status: 'pending',
      created: "'2026-08-05'",
      title: '"New"',
      target: 'b.md',
      'triggered-by': 'dream',
    });
    seedProposal('done.md', {
      type: 'proposal',
      status: 'applied',
      created: "'2026-08-04'",
      title: '"Done"',
      target: 'c.md',
    });
    const list = listProposals(org);
    expect(list.items[0].id).toBe('new');
    expect(list.items[1].id).toBe('old');
    expect(list.items[2].status).toBe('applied');
    expect(list.pendingCount).toBe(2);
    const only = listProposals(org, { pendingOnly: true });
    expect(only.items).toHaveLength(2);
  });
});

describe('flipFrontmatterField byte-exact', () => {
  test('flips only the target field; remainder byte-exact', () => {
    const body = 'Exact body bytes.\nSecond line.\n';
    const path = seedManifest(
      'flip.manifest.md',
      {
        type: 'forge',
        pipeline: 'dream-x',
        recipe: 'dream',
        goal: '"Keep me"',
        created: "'2026-08-05'",
        'triggered-by': 'dream',
        'review-status': 'pending',
        tags: ['dream', 'x'],
      },
      body,
    );
    const before = readFileSync(path, 'utf8');
    const r = flipFrontmatterField(path, 'review-status', 'pending', 'reviewed');
    expect(r.ok).toBe(true);
    const after = readFileSync(path, 'utf8');
    expect(after).toContain('review-status: reviewed');
    expect(after.endsWith(body)).toBe(true);
    // Every line except the review-status line is identical.
    const bLines = before.split('\n');
    const aLines = after.split('\n');
    expect(aLines.length).toBe(bLines.length);
    let diffs = 0;
    for (let i = 0; i < bLines.length; i++) {
      if (bLines[i] !== aLines[i]) {
        diffs++;
        expect(bLines[i]).toContain('review-status');
        expect(aLines[i]).toContain('review-status: reviewed');
      }
    }
    expect(diffs).toBe(1);
  });

  test('refuses unknown current value', () => {
    const path = seedManifest('already.manifest.md', {
      type: 'forge',
      'review-status': 'reviewed',
    });
    const before = readFileSync(path, 'utf8');
    const r = flipFrontmatterField(path, 'review-status', 'pending', 'reviewed');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unexpected-value');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('refuses missing field', () => {
    const path = seedManifest('nofield.manifest.md', { type: 'forge' });
    const r = flipFrontmatterField(path, 'review-status', 'pending', 'reviewed');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('field-absent');
  });
});

describe('review verbs', () => {
  test('reviewDream flips manifest pending → reviewed', () => {
    ensureLucerna();
    seedManifest('20260805-120000-tag.manifest.md', {
      type: 'forge',
      pipeline: 'dream-tag',
      'review-status': 'pending',
      created: "'2026-08-05'",
      'triggered-by': 'dream',
    });
    const r = reviewDream(org, '20260805-120000-tag');
    expect(r.ok).toBe(true);
    expect(r.to).toBe('reviewed');
    const shown = showDream(org, '20260805-120000-tag');
    expect(shown.found).toBe(true);
    expect(shown.item?.reviewStatus).toBe('reviewed');
  });

  test('reviewDream on light dream flips status pending → acted', () => {
    ensureLucerna();
    seedLight('light.md', { type: 'forge', status: 'pending', 'dream-action': 'x' });
    const r = reviewDream(org, 'light');
    expect(r.ok).toBe(true);
    expect(r.to).toBe('acted');
  });

  test('applyProposal / closeProposal status-only flips', () => {
    ensureLucerna();
    seedProposal('p1.md', {
      type: 'proposal',
      status: 'pending',
      title: '"One"',
      target: 't.md',
      created: "'2026-08-05'",
    });
    seedProposal('p2.md', {
      type: 'proposal',
      status: 'pending',
      title: '"Two"',
      target: 'u.md',
      created: "'2026-08-05'",
    });
    expect(applyProposal(org, 'p1').ok).toBe(true);
    expect(showProposal(org, 'p1').item?.status).toBe('applied');
    // file stays in place (no move)
    expect(existsSync(join(org, 'forge', 'proposals', 'p1.md'))).toBe(true);

    expect(closeProposal(org, 'p2').ok).toBe(true);
    expect(showProposal(org, 'p2').item?.status).toBe('closed');

    // refuse second flip
    const again = applyProposal(org, 'p1');
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('unexpected-value');
  });

  test('not-found is honest', () => {
    ensureLucerna();
    expect(reviewDream(org, 'missing').ok).toBe(false);
    expect(applyProposal(org, 'missing').reason).toBe('not-found');
  });
});

describe('pendingReviewCounts', () => {
  test('sums dream + proposal pending', () => {
    ensureLucerna(true);
    seedManifest('d.manifest.md', { type: 'forge', 'review-status': 'pending' });
    seedProposal('p.md', { type: 'proposal', status: 'pending', title: '"p"' });
    const c = pendingReviewCounts(org);
    expect(c.dreams).toBe(1);
    expect(c.proposals).toBe(1);
    expect(c.total).toBe(2);
    expect(c.dreamsEnabled).toBe(true);
  });
});

describe('agentic dream single-row dedupe', () => {
  test('pipeline match folds report under manifest', () => {
    ensureLucerna(true);
    seedManifest('20260805-120000-tag-regen.manifest.md', {
      type: 'forge',
      pipeline: 'dream-tag-regen',
      recipe: 'dream',
      goal: '"tag regen"',
      created: "'2026-08-05'",
      'triggered-by': 'dream',
      'review-status': 'pending',
      tags: ['dream', 'tag-regen'],
    });
    seedLight('tag-regen-report.md', {
      type: 'forge',
      pipeline: 'dream-tag-regen',
      status: 'pending',
      created: "'2026-08-05'",
      'triggered-by': 'dream',
      'dream-action': 'tag-regen',
    }, '## Report\n\nDid the work.\n');
    // standalone light (different pipeline)
    seedLight('inbox-age.md', {
      type: 'forge',
      'dream-action': 'inbox-age',
      status: 'pending',
      created: "'2026-08-04'",
    });

    const list = listDreams(org);
    const kinds = list.items.map((i) => i.kind);
    expect(kinds.filter((k) => k === 'manifest')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'light')).toHaveLength(1);
    expect(list.items).toHaveLength(2);
    expect(list.pendingCount).toBe(2);

    const man = list.items.find((i) => i.kind === 'manifest')!;
    expect(man.reportPath).toBe('forge/dreams/tag-regen-report.md');
    expect(list.items.some((i) => i.path === 'forge/dreams/tag-regen-report.md')).toBe(false);

    const shown = showDream(org, man.id);
    expect(shown.found).toBe(true);
    expect(shown.reportPath).toBe('forge/dreams/tag-regen-report.md');
    expect(shown.displayBody).toContain('Linked report');
    expect(shown.displayBody).toContain('Did the work.');
  });

  test('legacy action+date fallback folds without pipeline on report', () => {
    ensureLucerna(true);
    seedManifest('20260805-091500-substrate-health.manifest.md', {
      type: 'forge',
      pipeline: 'dream-substrate-health',
      goal: '"health"',
      created: "'2026-08-05'",
      'triggered-by': 'dream',
      'review-status': 'pending',
      tags: ['dream', 'substrate-health'],
    });
    // Pre-linkage artifact: no pipeline field; filename + action + date
    seedLight('20260805-091500-substrate-health.md', {
      type: 'forge',
      status: 'pending',
      created: "'2026-08-05'",
      'dream-action': 'substrate-health',
    }, 'Legacy body.\n');

    const list = listDreams(org);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].kind).toBe('manifest');
    expect(list.items[0].reportPath).toContain('substrate-health');
    expect(list.pendingCount).toBe(1);
  });

  test('legacy dream-action + created day match', () => {
    ensureLucerna(true);
    seedManifest('20260803-220000-distill.manifest.md', {
      type: 'forge',
      pipeline: 'dream-distill',
      created: "'2026-08-03'",
      'review-status': 'pending',
    });
    seedLight('nightly-distill-notes.md', {
      type: 'forge',
      status: 'pending',
      created: "'2026-08-03'",
      'dream-action': 'distill',
    });
    const list = listDreams(org);
    expect(list.items).toHaveLength(1);
    expect(list.items[0].kind).toBe('manifest');
    expect(list.items[0].reportPath).toBe('forge/dreams/nightly-distill-notes.md');
  });

  test('lightBelongsToManifest + parseManifestStamp unit', () => {
    expect(parseManifestStamp('20260805-120000-tag-regen')).toEqual({
      ymd: '20260805',
      hms: '120000',
      action: 'tag-regen',
    });
    const man: DreamItem = {
      id: '20260805-120000-tag-regen',
      kind: 'manifest',
      path: 'forge/dreams/sessions/20260805-120000-tag-regen.manifest.md',
      pipeline: 'dream-tag-regen',
      tags: [],
    };
    const light: DreamItem = {
      id: 'tag-regen-report',
      kind: 'light',
      path: 'forge/dreams/tag-regen-report.md',
      pipeline: 'dream-tag-regen',
      tags: [],
    };
    expect(lightBelongsToManifest(light, man)).toBe(true);
    const other: DreamItem = {
      id: 'other',
      kind: 'light',
      path: 'forge/dreams/other.md',
      dreamAction: 'other',
      created: '2026-08-01',
      tags: [],
    };
    expect(lightBelongsToManifest(other, man)).toBe(false);

    const folded = dedupeDreamItems([man], [light, other]);
    expect(folded).toHaveLength(2);
    expect(folded.find((x) => x.kind === 'manifest')?.reportPath).toBe(light.path);
  });
});
