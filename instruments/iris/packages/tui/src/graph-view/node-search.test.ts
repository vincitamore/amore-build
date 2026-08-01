import { describe, expect, test } from 'bun:test';
import { composeHintRow, composeResultRow, matchNodes, windowBounds } from './node-search';
import type { GraphNode } from '../render/graph';

const n = (id: string, label?: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, label, ...extra });

describe('matchNodes', () => {
  test('empty / whitespace query yields no results', () => {
    const nodes = [n('a/x.md', 'Alpha')];
    expect(matchNodes(nodes, '')).toEqual([]);
    expect(matchNodes(nodes, '   ')).toEqual([]);
  });

  test('ranks label prefix > label substring > id substring', () => {
    const nodes = [
      n('deep/nested/foo-notes.md', 'Notes about foo'), // label substring
      n('tasks/foobar.md', 'Foobar plan'), // label prefix
      n('archive/foo-thing.md', 'Unrelated'), // id substring only
    ];
    const out = matchNodes(nodes, 'foo').map((x) => x.id);
    expect(out).toEqual(['tasks/foobar.md', 'deep/nested/foo-notes.md', 'archive/foo-thing.md']);
  });

  test('within a tier, higher linkCount wins, then label lexicographic', () => {
    const nodes = [
      n('a.md', 'Foo one', { linkCount: 2 }),
      n('b.md', 'Foo two', { linkCount: 9 }),
      n('c.md', 'Foo three', { linkCount: 2 }),
    ];
    const out = matchNodes(nodes, 'foo').map((x) => x.label);
    // linkCount 9 first; then the two linkCount-2 nodes by label ('Foo one' < 'Foo three')
    expect(out).toEqual(['Foo two', 'Foo one', 'Foo three']);
  });

  test('multi-word is AND across terms (label OR id per term)', () => {
    const nodes = [
      n('tasks/iron-rod-platform.md', 'Iron Rod platform design'), // both terms in label
      n('knowledge/iron.md', 'Iron notes'), // only "iron"
      n('projects/rod/spec.md', 'Rod spec'), // "rod" in label+id, no "iron"
      n('tasks/platform/iron-thing.md', 'Platform thing'), // "iron" in id, "platform" in label
    ];
    const out = matchNodes(nodes, 'iron platform').map((x) => x.id);
    expect(out).toContain('tasks/iron-rod-platform.md');
    expect(out).toContain('tasks/platform/iron-thing.md');
    expect(out).not.toContain('knowledge/iron.md');
    expect(out).not.toContain('projects/rod/spec.md');
  });

  test('multi-word ranks by the BEST single-term tier', () => {
    // "task" is a label prefix (tier 0); "graph" only matches the id (tier 2). Best tier = 0, so this
    // outranks a node where both terms are mere substrings.
    const best = n('x/task-graph.md', 'Task board', { linkCount: 1 });
    const worse = n('y/z.md', 'A task and a graph mention', { linkCount: 50 });
    const out = matchNodes([worse, best], 'task graph').map((x) => x.id);
    expect(out[0]).toBe('x/task-graph.md'); // tier 0 beats tier 1 despite far lower linkCount
  });

  test('excludes cluster-kind nodes, includes placeholders and files', () => {
    const nodes = [
      n('cluster/foo', 'Foo cluster', { kind: 'cluster' }),
      n('foo-placeholder', 'Foo placeholder', { kind: 'placeholder' }),
      n('foo-file.pdf', 'Foo file', { kind: 'file' }),
    ];
    const out = matchNodes(nodes, 'foo').map((x) => x.id);
    expect(out).toContain('foo-placeholder');
    expect(out).toContain('foo-file.pdf');
    expect(out).not.toContain('cluster/foo');
  });

  test('respects the limit', () => {
    const nodes = Array.from({ length: 30 }, (_, i) => n(`n${i}.md`, `Foo ${i}`, { linkCount: i }));
    expect(matchNodes(nodes, 'foo', 5)).toHaveLength(5);
    expect(matchNodes(nodes, 'foo')).toHaveLength(30); // default cap (100) does not bite at 30
    const many = Array.from({ length: 120 }, (_, i) => n(`m${i}.md`, `Foo ${i}`));
    expect(matchNodes(many, 'foo')).toHaveLength(100); // default cap
  });

  test('matches on id when there is no label', () => {
    const nodes = [n('deep/path/widget.md')];
    const out = matchNodes(nodes, 'widget').map((x) => x.id);
    expect(out).toEqual(['deep/path/widget.md']);
  });
});

describe('windowBounds', () => {
  test('everything fits: start is always 0', () => {
    expect(windowBounds(0, 5, 12)).toBe(0);
    expect(windowBounds(4, 5, 12, 3)).toBe(0); // stale prevStart clamps back
  });

  test('selection inside the window keeps prevStart (minimal movement)', () => {
    expect(windowBounds(5, 50, 12, 3)).toBe(3);
    expect(windowBounds(14, 50, 12, 3)).toBe(3); // last visible row (3..14)
  });

  test('selection past the bottom edge scrolls down just enough', () => {
    expect(windowBounds(12, 50, 12, 0)).toBe(1); // one past → shift by one
    expect(windowBounds(30, 50, 12, 0)).toBe(19); // jump → selected lands on the last row
  });

  test('selection above the top edge scrolls up to it', () => {
    expect(windowBounds(2, 50, 12, 3)).toBe(2);
    expect(windowBounds(0, 50, 12, 30)).toBe(0);
  });

  test('start clamps to the last full window', () => {
    expect(windowBounds(49, 50, 12, 0)).toBe(38); // 50 - 12
    expect(windowBounds(49, 50, 12, 45)).toBe(38); // prevStart past the end clamps back
  });

  test('shrunken result set snaps the window back into range', () => {
    // Window was scrolled deep, then a keystroke narrows results to 4: start must return to 0.
    expect(windowBounds(0, 4, 12, 38)).toBe(0);
  });
});

describe('composeResultRow', () => {
  const LONG_LABEL = 'Example integration: confirm path and knowledge substrate alignment plan';
  const LONG_PATH = 'tasks/completed/example-integration.md';

  test('invariant: head + tail is EXACTLY inner columns, across widths and content', () => {
    const labels = [LONG_LABEL, 'Short', ''];
    const paths = [LONG_PATH, 'a.md'];
    for (const inner of [80, 66, 58, 41, 40, 36, 24]) {
      for (const label of labels) {
        for (const path of paths) {
          for (const selected of [true, false]) {
            const { head, tail } = composeResultRow(label, path, '◆', selected, inner);
            expect(head.length + tail.length).toBe(inner);
            expect(head.includes('\n')).toBe(false);
          }
        }
      }
    }
  });

  test('long label truncates with a trailing ellipsis; the label START always shows', () => {
    const { head } = composeResultRow(LONG_LABEL, LONG_PATH, '◆', true, 66);
    expect(head.startsWith('› ◆ Example integration')).toBe(true);
    expect(head).toContain('…');
  });

  test('long path truncates with a LEADING ellipsis keeping the distinctive tail', () => {
    const { tail } = composeResultRow(LONG_LABEL, LONG_PATH, '◆', false, 80); // pathCol = 32
    const shown = tail.trimStart();
    expect(shown.startsWith('…')).toBe(true);
    expect(shown.endsWith('substrate.md')).toBe(true); // the tail survives, not the shared prefix
    expect(shown.length).toBe(32);
  });

  test('narrow modal drops the path column rather than squeeze the label below its floor', () => {
    // inner 40: pathCol would be 16, leaving 40-4-1-16 = 19 < 20 for the label → path dropped.
    const narrow = composeResultRow(LONG_LABEL, LONG_PATH, '◆', false, 40);
    expect(narrow.tail).toBe('');
    expect(narrow.head.length).toBe(40);
    // inner 41 keeps it: 41-4-1-16 = 20 meets the floor exactly.
    const kept = composeResultRow(LONG_LABEL, LONG_PATH, '◆', false, 41);
    expect(kept.tail.length).toBeGreaterThan(0);
  });

  test('short label pads the gap; short path right-aligns', () => {
    const { head, tail } = composeResultRow('Tiny', 'a/b.md', '●', false, 66);
    expect(head.startsWith('  ● Tiny')).toBe(true);
    expect(head.endsWith(' ')).toBe(true); // gap padding
    expect(tail.endsWith('a/b.md')).toBe(true);
    expect(tail.startsWith(' ')).toBe(true); // right-aligned in its column
  });
});

describe('composeHintRow', () => {
  test('invariant: exactly inner columns, counter right-aligned', () => {
    for (const inner of [80, 58, 36, 24]) {
      const row = composeHintRow('↑↓ move · ⏎ focus · esc close', '12/100', inner);
      expect(row.length).toBe(inner);
      expect(row.endsWith('12/100')).toBe(true);
    }
  });

  test('no counter: hint truncate-then-padded to inner', () => {
    const row = composeHintRow('↑↓ move · ⏎ focus · esc close', '', 40);
    expect(row.length).toBe(40);
    expect(row.startsWith('↑↓ move')).toBe(true);
  });

  test('hint yields to the counter when space is tight', () => {
    const row = composeHintRow('↑↓ move · ⏎ focus · esc close', '99/100', 20);
    expect(row.length).toBe(20);
    expect(row.endsWith('99/100')).toBe(true);
    expect(row).toContain('…'); // hint visibly truncated, not silently overrun
  });
});
