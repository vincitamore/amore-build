/**
 * Two-list default-deny governance over a house tree.
 *
 * Writes are allowed only when the path matches WRITABLE and does not match
 * PROTECTED. Paths outside the house root are always protected.
 * Users may add protected paths via governance.user.toml (additive only).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { houseRuntimeDir, governanceUserPath } from "./paths.ts";

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
 * is also admitted by residual rule after instruments/ protection is applied.
 */
export const WRITABLE_PATTERNS = [
  "inbox/captures/",
  "forge/",
] as const;

export type PatternList = readonly string[];

export interface GovernanceLists {
  protected: string[];
  writable: string[];
}

export function defaultLists(): GovernanceLists {
  return {
    protected: [...PROTECTED_PATTERNS],
    writable: [...WRITABLE_PATTERNS],
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

/** Load user governance from house runtime dir. Absent or invalid → no extras. */
export function loadUserGovernance(houseRoot: string): { protectedExtra: string[] } {
  const path = governanceUserPath(houseRoot);
  if (!existsSync(path)) return { protectedExtra: [] };
  try {
    return parseGovernanceUserToml(readFileSync(path, "utf-8"));
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

/**
 * Residual writable: house-local lucerna runtime files under instruments/lucerna/
 * excluding package source and metadata.
 */
export function isLucernaRuntimePath(houseRoot: string, targetPath: string): boolean {
  const rel = relFromHouse(houseRoot, targetPath);
  if (rel === null) return false;
  if (!rel.startsWith("instruments/lucerna/") && rel !== "instruments/lucerna") return false;
  if (rel.startsWith("instruments/lucerna/src/")) return false;
  if (rel.startsWith("instruments/lucerna/scripts/")) return false;
  if (rel === "instruments/lucerna/package.json") return false;
  if (rel === "instruments/lucerna/tsconfig.json") return false;
  if (rel === "instruments/lucerna/README.md") return false;
  if (rel === "instruments/lucerna/bun.lock") return false;
  return true;
}

export function canWrite(
  houseRoot: string,
  targetPath: string,
  lists: GovernanceLists = defaultLists(),
): boolean {
  const rel = relFromHouse(houseRoot, targetPath);
  if (rel === null) return false;

  if (isLucernaRuntimePath(houseRoot, targetPath)) return true;

  if (isProtectedPath(houseRoot, targetPath, lists)) return false;

  for (const p of lists.writable) {
    if (matchesPattern(rel, p)) return true;
  }
  return false;
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
    if (isLucernaRuntimePath(this.houseRoot, targetPath)) return false;
    return isProtectedPath(this.houseRoot, targetPath, this.lists);
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
