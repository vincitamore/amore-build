// inbox promote — the examen inbox_process successor. Exercised through the command
// spec's run() against tmpdir fixture org trees (real regula file I/O), proving the
// create-then-close composition + the loud half-state guard.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS } from './commands';

const promote = COMMANDS.find((c) => c.name === 'inbox promote')!;

let org: string;
beforeEach(() => {
  org = mkdtempSync(join(tmpdir(), 'dioptra-promote-'));
});
afterEach(() => rmSync(org, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  const abs = join(org, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

const decisionDoc = [
  '---',
  'type: inbox',
  'created: 2026-07-01',
  'source: capture',
  'status: open',
  'tags:',
  '  - alpha',
  '---',
  '',
  '# My Decision',
  '',
  'Body text here.',
  '',
].join('\n');

const captureDoc = ['---', 'type: inbox', 'created: 2026-07-01', 'source: capture', 'tags: []', '---', '', '# Quick Thought', '', 'A capture body.', ''].join('\n');

describe('lifecycled type (decisions) → create task + resolveInbox with a wikilink', () => {
  test('creates the task and resolves the source (moved to resolved/, resolution wikilink)', () => {
    write('inbox/decisions/my-decision.md', decisionDoc);
    const out = promote.run({ orgRoot: org, args: { positional: ['inbox/decisions/my-decision.md'], flags: { to: 'task' } } }) as Record<string, unknown>;

    expect(out.to).toBe('task');
    expect(out.created).toBe('tasks/my-decision.md');
    expect(out.closed).toMatchObject({ via: 'resolve', newPath: 'inbox/decisions/resolved/my-decision.md' });

    // target created, with body H1 not doubled and tags carried
    const task = readFileSync(join(org, 'tasks/my-decision.md'), 'utf8');
    expect(task).toContain('# My Decision');
    expect(task).toContain('Body text here.');
    expect((task.match(/# My Decision/g) ?? []).length).toBe(1);
    expect(task).toContain('- alpha');

    // source resolved + moved, resolution carries a wikilink to the new doc
    expect(existsSync(join(org, 'inbox/decisions/my-decision.md'))).toBe(false);
    const resolved = readFileSync(join(org, 'inbox/decisions/resolved/my-decision.md'), 'utf8');
    expect(resolved).toContain('status: resolved');
    expect(resolved).toContain('Promoted to [[tasks/my-decision]]');
  });

  test('--title and --tags override the item defaults', () => {
    write('inbox/decisions/my-decision.md', decisionDoc);
    const out = promote.run({
      orgRoot: org,
      args: { positional: ['inbox/decisions/my-decision.md'], flags: { to: 'knowledge', title: 'Renamed Insight', tags: 'alef,bet', folder: 'architecture' } },
    }) as Record<string, unknown>;
    expect(out.created).toBe('knowledge/architecture/renamed-insight.md');
    const kb = readFileSync(join(org, 'knowledge/architecture/renamed-insight.md'), 'utf8');
    expect(kb).toContain('# Renamed Insight');
    expect(kb).toContain('- alef');
    expect(kb).toContain('- bet');
    // the promoted body H1 is not doubled (source H1 stripped; only the new title's H1 remains)
    expect((kb.match(/^# /gm) ?? []).length).toBe(1);
  });
});

describe('non-lifecycled type (captures) → create + archiveInbox', () => {
  test('promotes a capture to knowledge and archives the source', () => {
    write('inbox/captures/2026-07-01-quick.md', captureDoc);
    const out = promote.run({
      orgRoot: org,
      args: { positional: ['inbox/captures/2026-07-01-quick.md'], flags: { to: 'knowledge' } },
    }) as Record<string, unknown>;
    expect(out.created).toBe('knowledge/quick-thought.md');
    expect(out.closed).toMatchObject({ via: 'archive', newPath: 'archive/inbox/captures/2026-07-01-quick.md' });
    expect(existsSync(join(org, 'inbox/captures/2026-07-01-quick.md'))).toBe(false);
    expect(existsSync(join(org, 'archive/inbox/captures/2026-07-01-quick.md'))).toBe(true);
  });
});

describe('atomicity — create succeeds but close fails → loud, with the created path', () => {
  test('a pre-existing resolve target makes the close fail; the created doc is reported and kept', () => {
    write('inbox/decisions/my-decision.md', decisionDoc);
    // Pre-occupy the resolve target so resolveInbox's conflict check throws BEFORE any move.
    write('inbox/decisions/resolved/my-decision.md', decisionDoc);

    expect(() =>
      promote.run({ orgRoot: org, args: { positional: ['inbox/decisions/my-decision.md'], flags: { to: 'task' } } }),
    ).toThrow(/CREATED at tasks\/my-decision\.md/);

    // The task WAS created (no silent rollback) and the source is still in place to close manually.
    expect(existsSync(join(org, 'tasks/my-decision.md'))).toBe(true);
    expect(existsSync(join(org, 'inbox/decisions/my-decision.md'))).toBe(true);
  });
});

describe('guards', () => {
  test('non-inbox ref → throws (getInbox refuses)', () => {
    write('tasks/not-inbox.md', '---\ntype: task\nstatus: active\ncreated: 2026-07-01\ntags: []\n---\n\n# T\n');
    expect(() => promote.run({ orgRoot: org, args: { positional: ['tasks/not-inbox.md'], flags: { to: 'task' } } })).toThrow();
  });
});
