/**
 * Sessions member nest ledger + stage-host seed.
 *
 * Nest rows sit OUTSIDE the measured stage host (shell bar, member pad, status
 * Panel, chips, member footer). After Actions idle chrome is zero, nest = 9.
 * Runtime truth is the measured host; this module seeds tests and pre-layout frames.
 */
import type { MeasuredSize } from '../use-measured-size';

/** Floors — 80×24 remains usable; never collapse lists to zero. */
export const MIN_STAGE_BOX_H = 8;
export const MIN_STAGE_BOX_W = 40;
export const MIN_SESSION_SLOTS = 4;
export const MIN_TURN_SLOTS = 4;
export const MIN_HIT_SLOTS = 1;
export const MIN_PROBE_GRID_ROWS = 1;
export const MIN_MAP_CANVAS_ROWS = 6;
export const MIN_MAP_CANVAS_COLS = 16;
export const MIN_SEARCH_HIT_SLOTS = 4;
export const MIN_USAGE_MODEL_SLOTS = 1;

/**
 * Nest rows outside the stage flex host.
 * Idle SpeculumActions contributes 0 (keyboard only; no strip).
 * Shell member bar is outside SessionsMember but inside terminal dims —
 * seed subtracts it when seeding from terminal dimensions.
 */
export const SESSIONS_NEST_ROWS = {
  shellMemberBar: 1,
  memberPadTop: 1,
  /** Panel border top+bottom (2) + title (1) + status body (1). */
  statusPanel: 4,
  /** chips marginTop (1) + chip row height (1). */
  chips: 2,
  memberFooter: 1,
} as const;

/** = 9 after Actions idle chrome is zero. */
export function sessionsNestRows(): number {
  const n = SESSIONS_NEST_ROWS;
  return (
    n.shellMemberBar +
    n.memberPadTop +
    n.statusPanel +
    n.chips +
    n.memberFooter
  );
}

/** SessionsMember paddingLeft + paddingRight. */
export function sessionsMemberPadCols(): number {
  return 2;
}

/**
 * Seed for the measured stage host before first layout commit.
 * termW/termH = full terminal (useStableDimensions / useTerminalDimensions).
 */
export function seedStageBox(termW: number, termH: number): MeasuredSize {
  return {
    width: Math.max(MIN_STAGE_BOX_W, Math.floor(termW) - sessionsMemberPadCols()),
    height: Math.max(MIN_STAGE_BOX_H, Math.floor(termH) - sessionsNestRows()),
  };
}
