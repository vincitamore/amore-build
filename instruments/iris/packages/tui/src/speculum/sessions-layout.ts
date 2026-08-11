/**
 * Sessions member nest ledger + stage-host seed.
 *
 * Nest rows sit OUTSIDE the measured stage host (shell bar, member pad, status
 * Panel, chips, member footer). After Actions idle chrome is zero, nest = 9.
 * Runtime truth is the measured host; this module seeds tests and pre-layout frames.
 */
import type { MeasuredSize } from '../use-measured-size';

/**
 * Seed / pre-measure fallbacks only — never floors of an already-measured
 * fixed-slot budget. Measured budgets are pure fit-clamps: floor(body/row)
 * bounded below by 1 when that many rows fit, never by a MIN that would
 * paint past the host (OpenTUI boxes do not clip overflow by default).
 */
export const MIN_STAGE_BOX_H = 8;
export const MIN_STAGE_BOX_W = 40;
/** Pre-measure seed fallback for the microscope session picker. */
export const MIN_SESSION_SLOTS = 4;
/** Pre-measure seed fallback for the microscope turn timeline. */
export const MIN_TURN_SLOTS = 4;
/** Pre-measure seed fallback for probe hit rows (already 1 = fit-clamp floor). */
export const MIN_HIT_SLOTS = 1;
/** Pre-measure seed fallback for probe card-grid rows. */
export const MIN_PROBE_GRID_ROWS = 1;
/** Pre-measure seed fallback for map canvas rows (measured path fit-clamps). */
export const MIN_MAP_CANVAS_ROWS = 6;
/** Pre-measure seed fallback for map canvas cols. */
export const MIN_MAP_CANVAS_COLS = 16;
/** Pre-measure seed fallback for search hit rows. */
export const MIN_SEARCH_HIT_SLOTS = 4;
/** Pre-measure seed fallback for usage model cards. */
export const MIN_USAGE_MODEL_SLOTS = 1;
/** Pre-measure seed fallback for turn-detail content lines (measured path fit-clamps). */
export const MIN_TURN_DETAIL_LINES = 4;

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
