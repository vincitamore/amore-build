/**
 * Two-list default-deny governance over a house tree.
 *
 * Writes are allowed only when the path matches WRITABLE and does not match
 * PROTECTED. Paths outside the house root are always protected.
 * Users may add protected paths via governance.user.toml (additive only).
 *
 * Decision order: user extras deny, then residual allow-list, then
 * protected, then writable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  houseRuntimeDir,
  governanceUserPath,
  legacyGovernanceUserPath,
} from "./paths.ts";

/** Shipped protected surfaces relative to house root  -  exact-equality tested. */
export const PROTECTED_PATTERNS = [
  "AGENTS.md",
  "CLAUDE.md",
  "context/",
  "knowledge/",
  "tasks/",
  "reminders/",
  "tags/",
  "graph/",
  "projects/",
  "archive/",
  "scripts/",
  ".amore/",
  ".grok/",
  ".claude/",
  "instruments/",
] as const;

/**
 * Shipped writable surfaces. Lucerna runtime residual under instruments/lucerna/
 * is also admitted by the residual allow-list.
 */
export const WRITABLE_PATTERNS = [
  "inbox/captures/",
  "forge/",
] as const;

/** Legacy charter basenames under the runtime dir. Residual never admits these. */
export const LEGACY_CHARTER_FILES = [
  "lucerna.enable.json",
  "governance.user.toml",
] as const;

/** Residual-writable runtime state files (exact basename, top-level only). */
export const RUNTIME_STATE_FILES = [
  "health.json",
  "state.json",
  "log",
  "notifications.jsonl",
  "daemon.pid",
  "halt",
  "wake",
  "sleep",
] as const;

const RUNTIME_PREFIX = "instruments/lucerna/";
const RUNTIME_STATE_SET = new Set<string>(RUNTIME_STATE_FILES);
const LEGACY_CHARTER_SET = new Set<string>(LEGACY_CHARTER_FILES);

export type PatternList = readonly string[];

export interface GovernanceLists {
  protected: string[];
  writable: string[];
  protectedUserExtra: string[];
}

export function defaultLists(): GovernanceLists {
  return {
    protected: [...PROTECTED_PATTERNS],
    writable: [...WRITABLE_PATTERNS],
    protectedUserExtra: [],
  };
}

/**
 * Parse governance.user.toml for additive protected paths only.
 * User entries never widen the writable set.
 */
export function parseGovernanceUserToml(raw: string): { protectedExtra: string[] } {
  const protectedExtra: string[] = [];
  const m = raw.match(/protected_extra\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return { protectedExtra };
  const body = m[1] ?? "";
  const re = /"([^"]+)"|'([^']+)'/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(body)) !== null) {
    const v = (hit[1] ?? hit[2] ?? "").trim().replace(/\\/g, "/");
    if (v) protectedExtra.push(v);
  }
  return { protectedExtra };
}

/** Load user governance: charter path first, then legacy runtime path. */
export function loadUserGovernance(houseRoot: string): { protectedExtra: string[] } {
  const primary = governanceUserPath(houseRoot);
  const chosen = existsSync(primary)
    ? primary
    : existsSync(legacyGovernanceUserPath(houseRoot))
      ? legacyGovernanceUserPath(houseRoot)
      : null;
  if (!chosen) return { protectedExtra: [] };
  try {
    return parseGovernanceUserToml(readFileSync(chosen, "utf-8"));
  } catch {
    return { protectedExtra: [] };
  }
}

/**
 * Merge shipped lists with user protected extras.
 * Writable set is never widened by user config.
 */
export function mergeGovernanceLists(
  user: { protectedExtra?: string[] } = {},
): GovernanceLists {
  const lists = defaultLists();
  const extra = user.protectedExtra ?? [];
  for (const p of extra) {
    const norm = p.replace(/\\/g, "/");
    if (!lists.protectedUserExtra.includes(norm)) lists.protectedUserExtra.push(norm);
    if (!lists.protected.includes(norm)) lists.protected.push(norm);
  }
  return lists;
}

function relFromHouse(houseRoot: string, targetPath: string): string | null {
  const abs = resolve(targetPath);
  const root = resolve(houseRoot);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (rel.startsWith("..")) return null;
  return rel;
}

export function matchesPattern(rel: string, pattern: string): boolean {
  if (pattern.endsWith("/")) {
    const prefix = pattern.slice(0, -1);
    return rel === prefix || rel.startsWith(pattern);
  }
  return rel === pattern || rel.endsWith("/" + pattern);
}

export function isProtectedPath(
  houseRoot: string,
  targetPath: string,
  lists: GovernanceLists = defaultLists(),
): boolean {
  const rel = relFromHouse(houseRoot, targetPath);
  if (rel === null) return true;
  if (rel === "") return true;
  for (const p of lists.protected) {
    if (matchesPattern(rel, p)) return true;
  }
  return false;
}

function runtimeBasename(rel: string): string | null {
  if (!rel.startsWith(RUNTIME_PREFIX)) return null;
  const rest = rel.slice(RUNTIME_PREFIX.length);
  if (!rest || rest.includes("/")) return null;
  return rest;
}

function isRuntimeWriteArtifact(name: string): boolean {
  if (/^log\.\d+$/.test(name)) return true;
  if (name.endsWith(".tmp")) return true;
  if (name.startsWith("draft-")) return true;
  return false;
}

/**
 * Residual writable: allow-listed runtime state and write artifacts at the
 * top of instruments/lucerna/. Nested paths and legacy charter names are not.
 */
export function isLucernaRuntimePath(houseRoot: string, targetPath: string): boolean {
  const rel = relFromHouse(houseRoot, targetPath);
  if (rel === null) return false;
  const name = runtimeBasename(rel);
  if (name === null) return false;
  if (LEGACY_CHARTER_SET.has(name)) return false;
  if (RUNTIME_STATE_SET.has(name)) return true;
  return isRuntimeWriteArtifact(name);
}

export interface WriteDecision {
  allowed: boolean;
  residual: boolean;
  userExtra: boolean;
  protected: boolean;
}

/**
 * Single write decision. Order: user-extra deny, residual, protected, writable.
 */
export function writeDecision(
  houseRoot: string,
  targetPath: string,
  lists: GovernanceLists = defaultLists(),
): WriteDecision {
  const rel = relFromHouse(houseRoot, targetPath);
  if (rel === null) {
    return { allowed: false, residual: false, userExtra: false, protected: true };
  }

  const extras = lists.protectedUserExtra ?? [];
  for (const p of extras) {
    if (matchesPattern(rel, p)) {
      return { allowed: false, residual: false, userExtra: true, protected: true };
    }
  }

  if (isLucernaRuntimePath(houseRoot, targetPath)) {
    return { allowed: true, residual: true, userExtra: false, protected: false };
  }

  if (isProtectedPath(houseRoot, targetPath, lists)) {
    return { allowed: false, residual: false, userExtra: false, protected: true };
  }

  for (const p of lists.writable) {
    if (matchesPattern(rel, p)) {
      return { allowed: true, residual: false, userExtra: false, protected: false };
    }
  }
  return { allowed: false, residual: false, userExtra: false, protected: false };
}

export function canWrite(
  houseRoot: string,
  targetPath: string,
  lists: GovernanceLists = defaultLists(),
): boolean {
  return writeDecision(houseRoot, targetPath, lists).allowed;
}

export class Governance {
  readonly lists: GovernanceLists;

  constructor(
    private houseRoot: string,
    lists?: GovernanceLists,
  ) {
    this.lists = lists ?? mergeGovernanceLists(loadUserGovernance(houseRoot));
  }

  canWrite(targetPath: string): boolean {
    return canWrite(this.houseRoot, targetPath, this.lists);
  }

  isProtected(targetPath: string): boolean {
    const d = writeDecision(this.houseRoot, targetPath, this.lists);
    if (d.residual) return false;
    return d.protected || isProtectedPath(this.houseRoot, targetPath, this.lists);
  }

  resolve(...parts: string[]): string {
    return resolve(this.houseRoot, ...parts);
  }

  get runtimeDir(): string {
    return houseRuntimeDir(this.houseRoot);
  }
}

/**
 * Shared write guard: throws if the path is not writable under governance.
 * All action writers call this before creating files.
 */
export function assertWritable(
  houseRoot: string,
  targetPath: string,
  lists?: GovernanceLists,
): void {
  const l = lists ?? defaultLists();
  if (!canWrite(houseRoot, targetPath, l)) {
    const rel = relative(houseRoot, targetPath).replace(/\\/g, "/") || targetPath;
    throw new Error(`governance write denied: ${rel}`);
  }
}

/** Safe mkdir + write under governance. */
export function writeGuarded(
  houseRoot: string,
  targetPath: string,
  content: string,
  lists?: GovernanceLists,
): void {
  assertWritable(houseRoot, targetPath, lists);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, content, "utf-8");
}

export function forgeReportsDir(houseRoot: string): string {
  return join(houseRoot, "forge");
}
