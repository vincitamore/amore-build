import { test, expect } from 'bun:test';
import { docJumpInfo } from './doc-jump';

test('docJumpInfo maps actionable types to their member', () => {
  expect(docJumpInfo('tasks/incubating/rust-game-engine-rewrite.md')?.member).toBe('Tasks');
  expect(docJumpInfo('inbox/decisions/some-decision.md')?.member).toBe('Inbox');
  expect(docJumpInfo('reminders/foo.md')?.member).toBe('Reminders');
});

test('docJumpInfo carries a non-empty action legend for actionable types', () => {
  for (const p of ['tasks/a.md', 'inbox/b.md', 'reminders/c.md']) {
    const info = docJumpInfo(p);
    expect(info).not.toBeNull();
    expect(info!.actions.length).toBeGreaterThan(0);
    expect(info!.typeLabel.length).toBeGreaterThan(0);
  }
});

test('docJumpInfo returns null for non-actionable types', () => {
  expect(docJumpInfo('knowledge/architecture/patterns/foo.md')).toBeNull();
  expect(docJumpInfo('forge/output/x/handle.md')).toBeNull();
  expect(docJumpInfo('projects/whatever.md')).toBeNull();
});

test('docJumpInfo returns null for absolute / cross-tree paths (no owning member) and empties', () => {
  expect(docJumpInfo('C:/tmp/other-house/tasks/a.md')).toBeNull();
  expect(docJumpInfo('/home/deck/other-house/tasks/a.md')).toBeNull();
  expect(docJumpInfo('')).toBeNull();
  expect(docJumpInfo(null)).toBeNull();
  expect(docJumpInfo(undefined)).toBeNull();
});
