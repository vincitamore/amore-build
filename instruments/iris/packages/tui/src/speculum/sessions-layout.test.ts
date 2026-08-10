import { describe, expect, test } from 'bun:test';
import {
  MIN_STAGE_BOX_H,
  MIN_STAGE_BOX_W,
  SESSIONS_NEST_ROWS,
  seedStageBox,
  sessionsMemberPadCols,
  sessionsNestRows,
} from './sessions-layout';

describe('sessions nest ledger', () => {
  test('nest sum is 9 (Actions idle chrome = 0)', () => {
    expect(sessionsNestRows()).toBe(9);
    const n = SESSIONS_NEST_ROWS;
    expect(
      n.shellMemberBar + n.memberPadTop + n.statusPanel + n.chips + n.memberFooter,
    ).toBe(9);
  });

  test('member pad is 2 cols', () => {
    expect(sessionsMemberPadCols()).toBe(2);
  });

  test('seedStageBox at acceptance sizes', () => {
    const op = seedStageBox(140, 48);
    expect(op.height).toBe(48 - 9);
    expect(op.width).toBe(140 - 2);
    expect(op.height).toBeGreaterThanOrEqual(MIN_STAGE_BOX_H);
    expect(op.width).toBeGreaterThanOrEqual(MIN_STAGE_BOX_W);

    const narrow = seedStageBox(120, 36);
    expect(narrow.height).toBe(36 - 9);
    expect(narrow.width).toBe(120 - 2);

    const tight = seedStageBox(100, 30);
    expect(tight.height).toBe(30 - 9);
    expect(tight.width).toBe(100 - 2);

    const floor = seedStageBox(80, 24);
    expect(floor.height).toBe(24 - 9);
    expect(floor.height).toBeGreaterThanOrEqual(MIN_STAGE_BOX_H);
    expect(floor.width).toBe(80 - 2);
  });

  test('seed floors pathological terminals', () => {
    const tiny = seedStageBox(20, 10);
    expect(tiny.height).toBe(MIN_STAGE_BOX_H);
    expect(tiny.width).toBe(MIN_STAGE_BOX_W);
  });
});
