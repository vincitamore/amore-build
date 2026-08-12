/**
 * Read-only charter load: budgets.json + chores.json.
 * Precedence argv > env > file > shipped. The daemon never writes these files.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  ADMITTED_ACTION_KEYS,
  ACTION_CATALOG,
  actionCooldownClass,
  catalogEntry,
} from "./actions.ts";
import {
  actionCooldownMs,
  CYCLE_COOLDOWN_MS,
  DAILY_ACTION_BUDGET,
  DEFAULT_DAILY_TOKEN_CEILING,
  DEFAULT_DREAMS_RESERVE_TOKENS,
  WEEKLY_EXPENSIVE_BUDGET,
} from "./budget.ts";
import { houseCharterDir } from "./paths.ts";

export type BudgetCapSource = "argv" | "env" | "file" | "shipped";

export const CHARTER_SCHEMA_VERSION = 1;

export const CHARTER_BUDGETS_NAME = "budgets.json";
export const CHARTER_CHORES_NAME = "chores.json";

export const SHIPPED_BUDGET_DEFAULTS = {
  dailyActionCap: DAILY_ACTION_BUDGET,
  weeklyExpensiveCap: WEEKLY_EXPENSIVE_BUDGET,
  cycleCooldownMinutes: 120,
  dailyTokenCeiling: DEFAULT_DAILY_TOKEN_CEILING,
  dreamsReserveTokens: DEFAULT_DREAMS_RESERVE_TOKENS,
  autoCommitCooldownMinutes: 30,
} as const;

export const BUDGET_KNOB_BOUNDS = {
  dailyActionCap: { min: 0, max: 100 },
  weeklyExpensiveCap: { min: 0, max: 100 },
  cycleCooldownMinutes: { min: 30, max: 10080 },
  dailyTokenCeiling: { min: 0, max: 10_000_000 },
  dreamsReserveTokens: { min: 0, max: Number.POSITIVE_INFINITY },
  autoCommitCooldownMinutes: { min: 1, max: 10080 },
} as const;

/** Daily-token-ceiling values above 0 must be at least this. 0 is disable. */
export const DAILY_TOKEN_CEILING_POSITIVE_MIN = 10_000;

export const ROSTER_ENTRY_FIELDS = ["enabled", "minIntervalHours"] as const;

export const MIN_INTERVAL_HOURS_BOUNDS = { min: 0, max: 8760 } as const;

export const DEFAULT_AUTO_COMMIT_COOLDOWN_MINUTES = 30;

const STRICT_UINT_RE = /^\d+$/;

const BUDGET_FILE_KEYS = [
  "schemaVersion",
  "dailyActionCap",
  "weeklyExpensiveCap",
  "cycleCooldownMinutes",
  "dailyTokenCeiling",
  "dreamsReserveTokens",
  "autoCommitCooldownMinutes",
] as const;

const CHORES_FILE_KEYS = ["schemaVersion", "chores"] as const;

export type BudgetKnobName =
  | "dailyActionCap"
  | "weeklyExpensiveCap"
  | "cycleCooldownMinutes"
  | "dailyTokenCeiling"
  | "dreamsReserveTokens"
  | "autoCommitCooldownMinutes";

export interface ResolvedKnob<T = number> {
  value: T;
  source: BudgetCapSource;
  aboveShipped: boolean;
}

export interface FileRead {
  present: boolean;
  mtimeMs: number;
  ioError?: string;
  malformed?: boolean;
  ignored?: boolean;
}

export interface ResolvedBudgetKnobs {
  dailyActionCap: ResolvedKnob;
  weeklyExpensiveCap: ResolvedKnob;
  cycleCooldownMinutes: ResolvedKnob;
  dailyTokenCeiling: ResolvedKnob;
  dreamsReserveTokens: ResolvedKnob;
  autoCommitCooldownMinutes: ResolvedKnob;
  cycleCooldownMs: number;
  autoCommitCooldownMs: number;
  warnings: string[];
  file: FileRead;
  notifyMalformed: boolean;
}

export interface RosterEntryView {
  key: string;
  class: string;
  tier: string;
  enabled: boolean;
  lastRun: string | null;
  unknown?: boolean;
}

export interface ResolvedRoster {
  effectiveKeys: string[];
  disabled: string[];
  unknownKeys: string[];
  cooldownOverridesMs: Record<string, number>;
  entries: RosterEntryView[];
  warnings: string[];
  file: FileRead;
  /** Malformed / unknown schema — refuse the cycle; do not fall back. */
  refuse: boolean;
  refuseReason?: string;
}

export interface ResolvedCharter {
  budgets: ResolvedBudgetKnobs;
  roster: ResolvedRoster;
}

export function budgetsPath(houseRoot: string): string {
  return join(houseCharterDir(houseRoot), CHARTER_BUDGETS_NAME);
}

export function choresPath(houseRoot: string): string {
  return join(houseCharterDir(houseRoot), CHARTER_CHORES_NAME);
}

export function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export function parseStrictUint(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!STRICT_UINT_RE.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function parseEnvHours(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

function isJsonInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && Number.isFinite(v);
}

type RawRead =
  | { kind: "absent" }
  | { kind: "io"; error: string; mtimeMs: number }
  | { kind: "ok"; text: string; mtimeMs: number };

function readTextFile(path: string): RawRead {
  try {
    if (!existsSync(path)) return { kind: "absent" };
  } catch (e) {
    return {
      kind: "io",
      error: e instanceof Error ? e.message : String(e),
      mtimeMs: 0,
    };
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    return {
      kind: "io",
      error: e instanceof Error ? e.message : String(e),
      mtimeMs: 0,
    };
  }
  try {
    return { kind: "ok", text: readFileSync(path, "utf-8"), mtimeMs };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") return { kind: "absent" };
    return {
      kind: "io",
      error: e instanceof Error ? e.message : String(e),
      mtimeMs,
    };
  }
}

function shippedKnob(value: number, shipped: number): ResolvedKnob {
  return { value, source: "shipped", aboveShipped: value > shipped };
}

function knobOf(
  value: number,
  source: BudgetCapSource,
  looserThanShipped: boolean,
): ResolvedKnob {
  return { value, source, aboveShipped: looserThanShipped };
}

function fileIntegerField(
  obj: Record<string, unknown>,
  key: string,
  warnings: string[],
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  const v = obj[key];
  if (!isJsonInteger(v)) {
    warnings.push(`budgets.json ${key} is not an integer; using shipped default`);
    return undefined;
  }
  return v;
}

function inBounds(n: number, min: number, max: number): boolean {
  return n >= min && n <= max;
}

function validateBudgetField(
  key: BudgetKnobName,
  n: number,
  ceiling: number,
  warnings: string[],
  origin: string,
): number | undefined {
  const bounds = BUDGET_KNOB_BOUNDS[key];
  if (key === "dailyTokenCeiling") {
    if (n < 0 || n > bounds.max) {
      warnings.push(`${origin} ${key} out of bounds; using shipped default`);
      return undefined;
    }
    if (n > 0 && n < DAILY_TOKEN_CEILING_POSITIVE_MIN) {
      warnings.push(`${origin} ${key} below ${DAILY_TOKEN_CEILING_POSITIVE_MIN}; using shipped default`);
      return undefined;
    }
    return n;
  }
  if (key === "dreamsReserveTokens") {
    if (n < 0) {
      warnings.push(`${origin} ${key} is negative; using shipped default`);
      return undefined;
    }
    if (n >= ceiling) {
      warnings.push(`${origin} ${key} >= dailyTokenCeiling; using shipped default`);
      return undefined;
    }
    return n;
  }
  if (!inBounds(n, bounds.min, bounds.max)) {
    warnings.push(`${origin} ${key} out of bounds; using shipped default`);
    return undefined;
  }
  return n;
}

interface LayeredNumber {
  argv?: number;
  env?: number;
  file?: number;
}

function pickLayer(
  layers: LayeredNumber,
  shipped: number,
  looser: (v: number) => boolean,
): ResolvedKnob {
  if (layers.argv !== undefined) {
    return knobOf(layers.argv, "argv", looser(layers.argv));
  }
  if (layers.env !== undefined) {
    return knobOf(layers.env, "env", looser(layers.env));
  }
  if (layers.file !== undefined) {
    return knobOf(layers.file, "file", looser(layers.file));
  }
  return shippedKnob(shipped, shipped);
}

function parseBudgetsObject(
  obj: Record<string, unknown>,
  warnings: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(obj)) {
    if (!(BUDGET_FILE_KEYS as readonly string[]).includes(key)) {
      warnings.push(`budgets.json unknown key ignored: ${key}`);
    }
  }
  const pairs: BudgetKnobName[] = [
    "dailyActionCap",
    "weeklyExpensiveCap",
    "cycleCooldownMinutes",
    "dailyTokenCeiling",
    "dreamsReserveTokens",
    "autoCommitCooldownMinutes",
  ];
  for (const key of pairs) {
    const n = fileIntegerField(obj, key, warnings);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

export function resolveBudgetKnobs(opts: {
  houseRoot: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  previous?: ResolvedBudgetKnobs;
}): ResolvedBudgetKnobs {
  const env = opts.env ?? process.env;
  const args = opts.args ?? [];
  const warnings: string[] = [];
  const path = budgetsPath(opts.houseRoot);
  const raw = readTextFile(path);

  const file: FileRead = {
    present: raw.kind !== "absent",
    mtimeMs: raw.kind === "absent" ? 0 : raw.mtimeMs,
  };

  if (raw.kind === "io") {
    file.ioError = raw.error;
    if (opts.previous) {
      return {
        ...opts.previous,
        warnings: [
          ...opts.previous.warnings,
          `budgets.json read failed: ${raw.error} (keeping previous)`,
        ],
        file: { ...file, present: true },
        notifyMalformed: false,
      };
    }
    warnings.push(`budgets.json read failed: ${raw.error}; using shipped defaults`);
    return shippedBudgets(warnings, file, false);
  }

  let fileFields: Record<string, number> = {};
  let notifyMalformed = false;
  if (raw.kind === "ok") {
    try {
      const parsed: unknown = JSON.parse(raw.text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        warnings.push("budgets.json is not an object; using shipped defaults");
        notifyMalformed = true;
        file.malformed = true;
      } else {
        const obj = parsed as Record<string, unknown>;
        const ver = obj.schemaVersion;
        if (typeof ver === "number" && ver > CHARTER_SCHEMA_VERSION) {
          warnings.push(
            `budgets.json schemaVersion ${ver} is newer than ${CHARTER_SCHEMA_VERSION}; ignoring file`,
          );
          file.ignored = true;
        } else {
          if (ver !== undefined && ver !== CHARTER_SCHEMA_VERSION) {
            warnings.push(
              `budgets.json unknown schemaVersion ${String(ver)}; ignoring file`,
            );
            file.ignored = true;
          } else {
            fileFields = parseBudgetsObject(obj, warnings);
          }
        }
      }
    } catch (e) {
      warnings.push(
        `budgets.json malformed: ${e instanceof Error ? e.message : String(e)}; using shipped defaults`,
      );
      notifyMalformed = true;
      file.malformed = true;
    }
  }

  const argvDaily = parseStrictUint(getArg(args, "--daily-action-cap"));
  const argvWeekly = parseStrictUint(getArg(args, "--weekly-expensive-cap"));
  const argvCycleMin = parseStrictUint(getArg(args, "--cycle-cooldown-minutes"));
  const argvTokens = parseStrictUint(getArg(args, "--daily-token-ceiling"));
  const argvReserve = parseStrictUint(getArg(args, "--dreams-reserve-tokens"));
  const argvAcMin = parseStrictUint(getArg(args, "--auto-commit-cooldown-minutes"));

  const envDaily = parseStrictUint(env.LUCERNA_DAILY_ACTION_CAP);
  const envWeekly = parseStrictUint(env.LUCERNA_WEEKLY_EXPENSIVE_CAP);
  const envTokens = parseStrictUint(env.LUCERNA_DAILY_TOKEN_CEILING);
  const envReserve = parseStrictUint(env.LUCERNA_DREAMS_RESERVE_TOKENS);
  const envCycleHours = parseEnvHours(env.LUCERNA_CYCLE_COOLDOWN_HOURS);
  const envAcMin = parseEnvHours(env.LUCERNA_AUTO_COMMIT_COOLDOWN_MINUTES);
  // Env cooldown floors match loadConfig: clamp, do not reject.

  const validArgvDaily = argvDaily;
  const validEnvDaily = envDaily;
  const validFileDaily =
    fileFields.dailyActionCap !== undefined
      ? validateBudgetField(
          "dailyActionCap",
          fileFields.dailyActionCap,
          0,
          warnings,
          "budgets.json",
        )
      : undefined;

  const dailyActionCap = pickLayer(
    { argv: validArgvDaily, env: validEnvDaily, file: validFileDaily },
    SHIPPED_BUDGET_DEFAULTS.dailyActionCap,
    (v) => v > SHIPPED_BUDGET_DEFAULTS.dailyActionCap,
  );

  const validArgvWeekly = argvWeekly;
  const validEnvWeekly = envWeekly;
  const validFileWeekly =
    fileFields.weeklyExpensiveCap !== undefined
      ? validateBudgetField(
          "weeklyExpensiveCap",
          fileFields.weeklyExpensiveCap,
          0,
          warnings,
          "budgets.json",
        )
      : undefined;

  const weeklyExpensiveCap = pickLayer(
    { argv: validArgvWeekly, env: validEnvWeekly, file: validFileWeekly },
    SHIPPED_BUDGET_DEFAULTS.weeklyExpensiveCap,
    (v) => v > SHIPPED_BUDGET_DEFAULTS.weeklyExpensiveCap,
  );

  const validArgvTokens = argvTokens;
  const validEnvTokens = envTokens;
  const validFileTokens =
    fileFields.dailyTokenCeiling !== undefined
      ? validateBudgetField(
          "dailyTokenCeiling",
          fileFields.dailyTokenCeiling,
          0,
          warnings,
          "budgets.json",
        )
      : undefined;

  const dailyTokenCeiling = pickLayer(
    { argv: validArgvTokens, env: validEnvTokens, file: validFileTokens },
    SHIPPED_BUDGET_DEFAULTS.dailyTokenCeiling,
    (v) => v > SHIPPED_BUDGET_DEFAULTS.dailyTokenCeiling,
  );

  const ceiling = dailyTokenCeiling.value;

  const validArgvReserve =
    argvReserve !== undefined && argvReserve >= ceiling ? undefined : argvReserve;
  const validEnvReserve =
    envReserve !== undefined && envReserve >= ceiling ? undefined : envReserve;
  if (argvReserve !== undefined && argvReserve >= ceiling) {
    warnings.push(`argv dreamsReserveTokens >= dailyTokenCeiling; using next source`);
  }
  if (envReserve !== undefined && envReserve >= ceiling) {
    warnings.push(`env dreamsReserveTokens >= dailyTokenCeiling; using next source`);
  }
  const validFileReserve =
    fileFields.dreamsReserveTokens !== undefined
      ? validateBudgetField(
          "dreamsReserveTokens",
          fileFields.dreamsReserveTokens,
          ceiling,
          warnings,
          "budgets.json",
        )
      : undefined;

  let dreamsReserveTokens = pickLayer(
    { argv: validArgvReserve, env: validEnvReserve, file: validFileReserve },
    SHIPPED_BUDGET_DEFAULTS.dreamsReserveTokens,
    (v) => v > SHIPPED_BUDGET_DEFAULTS.dreamsReserveTokens,
  );
  if (dreamsReserveTokens.value >= ceiling) {
    warnings.push(
      `dreamsReserveTokens ${dreamsReserveTokens.value} >= dailyTokenCeiling ${ceiling}; using shipped ${SHIPPED_BUDGET_DEFAULTS.dreamsReserveTokens}`,
    );
    dreamsReserveTokens = shippedKnob(
      SHIPPED_BUDGET_DEFAULTS.dreamsReserveTokens,
      SHIPPED_BUDGET_DEFAULTS.dreamsReserveTokens,
    );
  }

  const validArgvCycle =
    argvCycleMin !== undefined
      ? Math.max(BUDGET_KNOB_BOUNDS.cycleCooldownMinutes.min, argvCycleMin)
      : undefined;
  const validEnvCycleMin =
    envCycleHours !== undefined
      ? Math.max(BUDGET_KNOB_BOUNDS.cycleCooldownMinutes.min, envCycleHours * 60)
      : undefined;
  const validFileCycle =
    fileFields.cycleCooldownMinutes !== undefined
      ? validateBudgetField(
          "cycleCooldownMinutes",
          fileFields.cycleCooldownMinutes,
          0,
          warnings,
          "budgets.json",
        )
      : undefined;

  const cycleCooldownMinutes = pickLayer(
    { argv: validArgvCycle, env: validEnvCycleMin, file: validFileCycle },
    SHIPPED_BUDGET_DEFAULTS.cycleCooldownMinutes,
    (v) => v < SHIPPED_BUDGET_DEFAULTS.cycleCooldownMinutes,
  );

  const validArgvAc =
    argvAcMin !== undefined
      ? Math.max(BUDGET_KNOB_BOUNDS.autoCommitCooldownMinutes.min, argvAcMin)
      : undefined;
  const validEnvAc =
    envAcMin !== undefined
      ? Math.max(BUDGET_KNOB_BOUNDS.autoCommitCooldownMinutes.min, envAcMin)
      : undefined;
  const validFileAc =
    fileFields.autoCommitCooldownMinutes !== undefined
      ? validateBudgetField(
          "autoCommitCooldownMinutes",
          fileFields.autoCommitCooldownMinutes,
          0,
          warnings,
          "budgets.json",
        )
      : undefined;

  const autoCommitCooldownMinutes = pickLayer(
    { argv: validArgvAc, env: validEnvAc, file: validFileAc },
    SHIPPED_BUDGET_DEFAULTS.autoCommitCooldownMinutes,
    (v) => v < SHIPPED_BUDGET_DEFAULTS.autoCommitCooldownMinutes,
  );

  const cycleCooldownMs = Math.max(
    30 * 60 * 1000,
    cycleCooldownMinutes.value * 60 * 1000,
  );
  const autoCommitCooldownMs = Math.max(
    60 * 1000,
    autoCommitCooldownMinutes.value * 60 * 1000,
  );

  return {
    dailyActionCap,
    weeklyExpensiveCap,
    cycleCooldownMinutes,
    dailyTokenCeiling,
    dreamsReserveTokens,
    autoCommitCooldownMinutes,
    cycleCooldownMs,
    autoCommitCooldownMs,
    warnings,
    file,
    notifyMalformed,
  };
}

function shippedBudgets(
  warnings: string[],
  file: FileRead,
  notifyMalformed: boolean,
): ResolvedBudgetKnobs {
  return {
    dailyActionCap: shippedKnob(
      SHIPPED_BUDGET_DEFAULTS.dailyActionCap,
      SHIPPED_BUDGET_DEFAULTS.dailyActionCap,
    ),
    weeklyExpensiveCap: shippedKnob(
      SHIPPED_BUDGET_DEFAULTS.weeklyExpensiveCap,
      SHIPPED_BUDGET_DEFAULTS.weeklyExpensiveCap,
    ),
    cycleCooldownMinutes: shippedKnob(
      SHIPPED_BUDGET_DEFAULTS.cycleCooldownMinutes,
      SHIPPED_BUDGET_DEFAULTS.cycleCooldownMinutes,
    ),
    dailyTokenCeiling: shippedKnob(
      SHIPPED_BUDGET_DEFAULTS.dailyTokenCeiling,
      SHIPPED_BUDGET_DEFAULTS.dailyTokenCeiling,
    ),
    dreamsReserveTokens: shippedKnob(
      SHIPPED_BUDGET_DEFAULTS.dreamsReserveTokens,
      SHIPPED_BUDGET_DEFAULTS.dreamsReserveTokens,
    ),
    autoCommitCooldownMinutes: shippedKnob(
      SHIPPED_BUDGET_DEFAULTS.autoCommitCooldownMinutes,
      SHIPPED_BUDGET_DEFAULTS.autoCommitCooldownMinutes,
    ),
    cycleCooldownMs: CYCLE_COOLDOWN_MS,
    autoCommitCooldownMs: DEFAULT_AUTO_COMMIT_COOLDOWN_MINUTES * 60 * 1000,
    warnings,
    file,
    notifyMalformed,
  };
}

function defaultRosterEntries(unknownKeys: string[] = []): RosterEntryView[] {
  const admitted = ACTION_CATALOG.filter((e) => e.admitted).map((e) => ({
    key: e.key,
    class: e.class,
    tier: e.budgetTier,
    enabled: true,
    lastRun: null as string | null,
  }));
  const extra = unknownKeys.map((key) => ({
    key,
    class: "??",
    tier: "??",
    enabled: false,
    lastRun: null as string | null,
    unknown: true,
  }));
  return [...admitted, ...extra];
}

function allEnabledRoster(file: FileRead, warnings: string[], refuse = false, refuseReason?: string): ResolvedRoster {
  return {
    effectiveKeys: [...ADMITTED_ACTION_KEYS],
    disabled: [],
    unknownKeys: [],
    cooldownOverridesMs: {},
    entries: defaultRosterEntries(),
    warnings,
    file,
    refuse,
    refuseReason,
  };
}

/**
 * Lengthen-only cooldown map. Clamp hours to [0, 8760] at map-build.
 * A roster interval shorter than the compiled class floor is ignored.
 */
export function buildCooldownOverridesMs(
  hoursByKey: Record<string, number>,
  warnings: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, rawHours] of Object.entries(hoursByKey)) {
    if (!ADMITTED_ACTION_KEYS.includes(key)) continue;
    if (typeof rawHours !== "number" || !Number.isFinite(rawHours)) {
      warnings.push(`chores.json ${key}.minIntervalHours is not a number; ignored`);
      continue;
    }
    const hours = Math.min(
      MIN_INTERVAL_HOURS_BOUNDS.max,
      Math.max(MIN_INTERVAL_HOURS_BOUNDS.min, rawHours),
    );
    if (hours !== rawHours) {
      warnings.push(
        `chores.json ${key}.minIntervalHours clamped to [${MIN_INTERVAL_HOURS_BOUNDS.min}, ${MIN_INTERVAL_HOURS_BOUNDS.max}]`,
      );
    }
    const cls = actionCooldownClass(key);
    const floorMs = actionCooldownMs(cls);
    const rosterMs = hours * 60 * 60 * 1000;
    out[key] = Math.max(floorMs, rosterMs);
  }
  return out;
}

export function parseChoresObject(
  obj: Record<string, unknown>,
  warnings: string[],
): {
  enabledByKey: Record<string, boolean>;
  hoursByKey: Record<string, number>;
  unknownKeys: string[];
} {
  const enabledByKey: Record<string, boolean> = {};
  const hoursByKey: Record<string, number> = {};
  const unknownKeys: string[] = [];

  for (const key of Object.keys(obj)) {
    if (!(CHORES_FILE_KEYS as readonly string[]).includes(key)) {
      warnings.push(`chores.json unknown key ignored: ${key}`);
    }
  }

  const chores = obj.chores;
  if (chores === undefined) {
    return { enabledByKey, hoursByKey, unknownKeys };
  }
  if (!chores || typeof chores !== "object" || Array.isArray(chores)) {
    throw new Error("chores is not an object");
  }

  const map = chores as Record<string, unknown>;
  for (const [key, entry] of Object.entries(map)) {
    if (key.startsWith("user:")) {
      warnings.push(`chores.json ${key} is reserved; ignored`);
      continue;
    }
    const admitted = ADMITTED_ACTION_KEYS.includes(key);
    if (!admitted) {
      warnings.push(`chores.json unknown chore key ignored: ${key}`);
      unknownKeys.push(key);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      warnings.push(`chores.json ${key} must be an object; ignored`);
      continue;
    }
    const rec = entry as Record<string, unknown>;
    for (const field of Object.keys(rec)) {
      if (!(ROSTER_ENTRY_FIELDS as readonly string[]).includes(field)) {
        warnings.push(`chores.json ${key}.${field} ignored`);
      }
    }
    if (!admitted) continue;

    if (rec.enabled === false) enabledByKey[key] = false;
    else if (rec.enabled === true || rec.enabled === undefined) enabledByKey[key] = true;
    else {
      warnings.push(`chores.json ${key}.enabled is not a boolean; treating as enabled`);
      enabledByKey[key] = true;
    }

    if (rec.minIntervalHours !== undefined) {
      if (typeof rec.minIntervalHours === "number" && Number.isFinite(rec.minIntervalHours)) {
        hoursByKey[key] = rec.minIntervalHours;
      } else {
        warnings.push(`chores.json ${key}.minIntervalHours is not a number; ignored`);
      }
    }
  }
  return { enabledByKey, hoursByKey, unknownKeys };
}

export function resolveRoster(opts: {
  houseRoot: string;
  previous?: ResolvedRoster;
  recentActions?: Record<string, string>;
}): ResolvedRoster {
  const warnings: string[] = [];
  const path = choresPath(opts.houseRoot);
  const raw = readTextFile(path);
  const file: FileRead = {
    present: raw.kind !== "absent",
    mtimeMs: raw.kind === "absent" ? 0 : raw.mtimeMs,
  };

  if (raw.kind === "io") {
    file.ioError = raw.error;
    if (opts.previous) {
      return {
        ...opts.previous,
        warnings: [
          ...opts.previous.warnings,
          `chores.json read failed: ${raw.error} (keeping previous)`,
        ],
        file: { ...file, present: true },
      };
    }
    return allEnabledRoster(
      file,
      [`chores.json read failed: ${raw.error}`],
      true,
      "roster invalid — dreams paused",
    );
  }

  if (raw.kind === "absent") {
    return allEnabledRoster(file, warnings);
  }

  try {
    const parsed: unknown = JSON.parse(raw.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      file.malformed = true;
      return allEnabledRoster(
        file,
        ["chores.json is not an object"],
        true,
        "roster invalid — dreams paused",
      );
    }
    const obj = parsed as Record<string, unknown>;
    const ver = obj.schemaVersion;
    if (typeof ver === "number" && ver > CHARTER_SCHEMA_VERSION) {
      file.ignored = true;
      return allEnabledRoster(
        file,
        [`chores.json schemaVersion ${ver} is newer than ${CHARTER_SCHEMA_VERSION}`],
        true,
        "roster invalid — dreams paused",
      );
    }
    if (ver !== undefined && ver !== CHARTER_SCHEMA_VERSION) {
      file.ignored = true;
      return allEnabledRoster(
        file,
        [`chores.json unknown schemaVersion ${String(ver)}`],
        true,
        "roster invalid — dreams paused",
      );
    }

    const { enabledByKey, hoursByKey, unknownKeys } = parseChoresObject(obj, warnings);
    const disabled: string[] = [];
    const effectiveKeys: string[] = [];
    for (const key of ADMITTED_ACTION_KEYS) {
      const enabled = enabledByKey[key] !== false;
      if (enabled) effectiveKeys.push(key);
      else disabled.push(key);
    }
    const cooldownOverridesMs = buildCooldownOverridesMs(hoursByKey, warnings);
    const entries: RosterEntryView[] = ACTION_CATALOG.filter((e) => e.admitted).map((e) => ({
      key: e.key,
      class: e.class,
      tier: e.budgetTier,
      enabled: enabledByKey[e.key] !== false,
      lastRun: opts.recentActions?.[e.key] ?? null,
    }));
    for (const key of unknownKeys) {
      entries.push({
        key,
        class: "??",
        tier: "??",
        enabled: false,
        lastRun: null,
        unknown: true,
      });
    }
    return {
      effectiveKeys,
      disabled: [...disabled, ...unknownKeys],
      unknownKeys,
      cooldownOverridesMs,
      entries,
      warnings,
      file,
      refuse: false,
    };
  } catch (e) {
    file.malformed = true;
    return allEnabledRoster(
      file,
      [`chores.json malformed: ${e instanceof Error ? e.message : String(e)}`],
      true,
      "roster invalid — dreams paused",
    );
  }
}

export function resolveBudgetConfig(opts: {
  houseRoot: string;
  env?: NodeJS.ProcessEnv;
  args?: string[];
  previous?: ResolvedCharter;
  recentActions?: Record<string, string>;
}): ResolvedCharter {
  return {
    budgets: resolveBudgetKnobs({
      houseRoot: opts.houseRoot,
      env: opts.env,
      args: opts.args,
      previous: opts.previous?.budgets,
    }),
    roster: resolveRoster({
      houseRoot: opts.houseRoot,
      previous: opts.previous?.roster,
      recentActions: opts.recentActions,
    }),
  };
}

export function dreamPickSchema(effectiveKeys: readonly string[]): {
  type: "object";
  properties: {
    action: { type: "string"; enum: string[] };
    reason: { type: "string" };
  };
  required: ["action", "reason"];
  additionalProperties: false;
} {
  const keys = effectiveKeys.filter((k) => ADMITTED_ACTION_KEYS.includes(k));
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [...keys, "skip"],
      },
      reason: { type: "string" },
    },
    required: ["action", "reason"],
    additionalProperties: false,
  };
}

/** Planner spawn constants — roster fields must never change these. */
export const PLANNER_SPAWN_OPTIONS = {
  mode: "json" as const,
  maxTurns: 1,
  noSubagents: true,
  wallMs: 180_000,
};

export function plannerSpawnSnapshot(effectiveKeys: readonly string[]): string {
  return JSON.stringify({
    ...PLANNER_SPAWN_OPTIONS,
    jsonSchema: dreamPickSchema(effectiveKeys),
  });
}

export function isRosterKeyEnabled(
  roster: ResolvedRoster,
  key: string,
): boolean {
  return roster.effectiveKeys.includes(key);
}

export function catalogEntryClass(key: string): string {
  return catalogEntry(key)?.class ?? "??";
}

export interface ApplyCharterTarget {
  dailyActionCap: number;
  weeklyExpensiveCap: number;
  cycleCooldownMs: number;
  dailyTokenCeiling: number;
  autoCommitCooldownMs: number;
  dreamsReserveTokens?: number;
}

export function shouldApplyShippedBudgets(
  budgets: ResolvedBudgetKnobs,
  deletedWhileRunning: boolean,
): boolean {
  return (
    budgets.file.present ||
    !!budgets.file.malformed ||
    !!budgets.file.ignored ||
    deletedWhileRunning
  );
}

export function applyCharterToConfig(
  config: ApplyCharterTarget,
  charter: ResolvedCharter,
  opts?: { applyShipped?: boolean },
): void {
  const applyShipped =
    opts?.applyShipped ?? shouldApplyShippedBudgets(charter.budgets, false);
  const b = charter.budgets;
  const take = (knob: ResolvedKnob) => applyShipped || knob.source !== "shipped";
  if (take(b.dailyActionCap)) config.dailyActionCap = b.dailyActionCap.value;
  if (take(b.weeklyExpensiveCap)) config.weeklyExpensiveCap = b.weeklyExpensiveCap.value;
  if (take(b.cycleCooldownMinutes)) config.cycleCooldownMs = b.cycleCooldownMs;
  if (take(b.dailyTokenCeiling)) config.dailyTokenCeiling = b.dailyTokenCeiling.value;
  if (take(b.autoCommitCooldownMinutes)) {
    config.autoCommitCooldownMs = b.autoCommitCooldownMs;
  }
  if (take(b.dreamsReserveTokens)) {
    config.dreamsReserveTokens = b.dreamsReserveTokens.value;
  }
}

export function budgetsDeletedWhileRunning(
  previousPresent: boolean | undefined,
  next: ResolvedBudgetKnobs,
): boolean {
  return previousPresent === true && !next.file.present && !next.file.ioError;
}

export function choresDeletedWhileRunning(
  previousPresent: boolean | undefined,
  next: ResolvedRoster,
): boolean {
  return previousPresent === true && !next.file.present && !next.file.ioError;
}
