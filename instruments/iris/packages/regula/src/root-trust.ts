// ─────────────────────────────────────────────────────────────────────────────
// root-trust.ts — the ONE foreign-root / house-root trust seam.
//
// Public product model (Phase 1.5 D2):
//   READ operations (index, search, graph, dash) → any root, no guard.
//   MUTATION operations (regula CRUD / lifecycle) → recognized house root
//     (markers) OR explicit opt-in.
//
// Opt-in channels (any one suffices):
//   1. --allow-foreign-root (CLI / callers pass allowForeignRoot: true)
//   2. IRIS_ALLOW_FOREIGN_ROOT=1
//   3. path present in allowed-roots.json under the iris instrument home
//
// Interactive confirm (TTY only) can plant (3). Non-interactive must use
// (1) or (2) — never prompt when stdin is not a TTY.
//
// Every refusal names its remedy on one line.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RegulaError } from './errors';
import { allowedRootsDisplay, resolveIrisHome } from './home';

/** House markers: orientation doc + tasks/ directory (same as org-root walk-up). */
export function isHouseRoot(dir: string): boolean {
  try {
    const root = resolve(dir);
    const hasOrient =
      existsSync(join(root, 'AGENTS.md')) ||
      existsSync(join(root, 'AGENT.md')) ||
      existsSync(join(root, 'CLAUDE.md'));
    return hasOrient && existsSync(join(root, 'tasks'));
  } catch {
    return false;
  }
}

/** Canonical one-line remedy named by every refusal. */
export function foreignRootRemedy(): string {
  return (
    'pass --allow-foreign-root, set IRIS_ALLOW_FOREIGN_ROOT=1, ' +
    `or allow the root (interactive confirm plants ${allowedRootsDisplay()})`
  );
}

/**
 * Path to the per-user allow list under the iris instrument home.
 * @param userHome when set (tests), resolve under that user home with a clean env;
 *   when omitted, use process-wide resolveIrisHome() (honors IRIS_HOME / AMORE_HOME).
 */
export function allowedRootsPath(userHome?: string): string {
  const home =
    userHome !== undefined
      ? resolveIrisHome({ userHome, env: {} })
      : resolveIrisHome();
  return join(home, 'allowed-roots.json');
}

interface AllowedRootsFile {
  version: 1;
  roots: string[];
}

function readAllowedRoots(userHome?: string): string[] {
  const path = allowedRootsPath(userHome);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as AllowedRootsFile;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.roots)) return [];
    return raw.roots.map((r) => resolve(String(r)));
  } catch {
    return [];
  }
}

/** True when the resolved path is on the per-user allow list. */
export function isRootAllowed(root: string, userHome?: string): boolean {
  const resolved = resolve(root);
  return readAllowedRoots(userHome).includes(resolved);
}

/**
 * Plant (or reaffirm) a root on the allow list. Creates the instrument home as needed.
 * Returns the resolved path that was recorded.
 */
export function plantAllowedRoot(root: string, userHome?: string): string {
  const resolved = resolve(root);
  const path = allowedRootsPath(userHome);
  mkdirSync(dirname(path), { recursive: true });
  const existing = readAllowedRoots(userHome);
  if (!existing.includes(resolved)) existing.push(resolved);
  const body: AllowedRootsFile = { version: 1, roots: existing };
  writeFileSync(path, JSON.stringify(body, null, 2) + '\n', 'utf-8');
  return resolved;
}

export type RootTrustLevel = 'house' | 'flag' | 'env' | 'allow-list' | 'untrusted';

export interface RootTrustOptions {
  /** Explicit --allow-foreign-root (or equivalent caller opt-in). */
  allowForeignRoot?: boolean;
  /** Env bag (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** User home for instrument-home resolution (default os.homedir()). */
  homeDir?: string;
}

export interface RootTrustDecision {
  trusted: boolean;
  level: RootTrustLevel;
  root: string;
  /** Set when untrusted — exact remedy line. */
  remedy?: string;
  /** Short reason string for diagnostics. */
  reason: string;
}

function envAllowsForeign(env: NodeJS.ProcessEnv): boolean {
  const v = env.IRIS_ALLOW_FOREIGN_ROOT;
  if (v === undefined || v === '') return false;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

/**
 * Compute root trust for MUTATION. Reads never call this.
 * Order: house markers → flag → env → allow-list → untrusted.
 */
export function evaluateRootTrust(root: string, opts: RootTrustOptions = {}): RootTrustDecision {
  const resolved = resolve(root);
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? homedir();

  if (isHouseRoot(resolved)) {
    return {
      trusted: true,
      level: 'house',
      root: resolved,
      reason: 'recognized house root (AGENTS.md|AGENT.md|CLAUDE.md + tasks/)',
    };
  }
  if (opts.allowForeignRoot === true) {
    return {
      trusted: true,
      level: 'flag',
      root: resolved,
      reason: 'explicit --allow-foreign-root',
    };
  }
  if (envAllowsForeign(env)) {
    return {
      trusted: true,
      level: 'env',
      root: resolved,
      reason: 'IRIS_ALLOW_FOREIGN_ROOT is set',
    };
  }
  if (isRootAllowed(resolved, homeDir)) {
    return {
      trusted: true,
      level: 'allow-list',
      root: resolved,
      reason: `path is in ${allowedRootsDisplay()}`,
    };
  }
  const remedy = foreignRootRemedy();
  return {
    trusted: false,
    level: 'untrusted',
    root: resolved,
    remedy,
    reason: `non-house root (no markers): ${resolved}`,
  };
}

/** Refusal message: reason + one-line remedy. */
export function foreignRootRefusalMessage(root: string, remedy: string = foreignRootRemedy()): string {
  return `REFUSING mutation on non-house root ${resolve(root)} — ${remedy}`;
}

/**
 * Hard assert for mutation paths. Throws RegulaError('USAGE') with remedy text.
 * No interactive behavior — callers that want a TTY confirm use ensureMutationTrust.
 */
export function assertMutationTrust(root: string, opts: RootTrustOptions = {}): void {
  const decision = evaluateRootTrust(root, opts);
  if (decision.trusted) return;
  throw new RegulaError(
    'USAGE',
    foreignRootRefusalMessage(decision.root, decision.remedy ?? foreignRootRemedy()),
  );
}

export interface EnsureMutationTrustOptions extends RootTrustOptions {
  /**
   * When true, attempt interactive confirm if untrusted.
   * When false, never prompt (fail closed).
   * Default: false — CLI sets true only when stdin is a TTY.
   */
  interactive?: boolean;
  /**
   * Injected confirm for tests. Default reads a y/N line from stdin when interactive.
   * Must return true to plant the allow record and proceed.
   */
  confirm?: () => boolean | Promise<boolean>;
  /**
   * When interactive confirm is requested but stdin is not a TTY, fail with this
   * instruction (never prompt). Default true = fail closed.
   */
  requireTtyForPrompt?: boolean;
  /** Override TTY detection (tests). Default: process.stdin.isTTY. */
  isTty?: boolean;
}

/**
 * Mutation gate used by product verbs.
 *
 * - trusted → return
 * - untrusted + interactive + TTY → confirm; on yes plant allow-list and return
 * - untrusted + interactive + non-TTY → refuse with non-interactive instruction
 * - untrusted + non-interactive → refuse with remedy (flag/env/allow-list)
 */
export async function ensureMutationTrust(
  root: string,
  opts: EnsureMutationTrustOptions = {},
): Promise<RootTrustDecision> {
  const decision = evaluateRootTrust(root, opts);
  if (decision.trusted) return decision;

  const interactive = opts.interactive === true;
  const isTty = opts.isTty ?? Boolean(process.stdin.isTTY);
  const requireTty = opts.requireTtyForPrompt !== false;

  if (interactive) {
    if (requireTty && !isTty) {
      throw new RegulaError(
        'USAGE',
        foreignRootRefusalMessage(
          decision.root,
          'non-interactive session cannot prompt — pass --allow-foreign-root or set IRIS_ALLOW_FOREIGN_ROOT=1',
        ),
      );
    }
    const homeDir = opts.homeDir ?? homedir();
    let ok: boolean;
    if (opts.confirm) {
      ok = await opts.confirm();
    } else {
      ok = await defaultConfirm(decision.root);
    }
    if (!ok) {
      throw new RegulaError(
        'USAGE',
        foreignRootRefusalMessage(decision.root, decision.remedy ?? foreignRootRemedy()),
      );
    }
    plantAllowedRoot(decision.root, homeDir);
    return {
      trusted: true,
      level: 'allow-list',
      root: decision.root,
      reason: `operator confirmed; planted ${allowedRootsDisplay()}`,
    };
  }

  throw new RegulaError(
    'USAGE',
    foreignRootRefusalMessage(decision.root, decision.remedy ?? foreignRootRemedy()),
  );
}

async function defaultConfirm(root: string): Promise<boolean> {
  process.stderr.write(
    `[iris] ${resolve(root)} is not a recognized house root (need AGENTS.md|AGENT.md|CLAUDE.md + tasks/).\n` +
      `[iris] Allow mutations on this root and remember it in ${allowedRootsDisplay()}? [y/N] `,
  );
  const line = await readStdinLine();
  const answer = line.trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function readStdinLine(): Promise<string> {
  return new Promise((resolveLine) => {
    let buf = '';
    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      if (buf.includes('\n')) {
        cleanup();
        resolveLine(buf.split(/\r?\n/)[0] ?? '');
      }
    };
    const onEnd = () => {
      cleanup();
      resolveLine(buf);
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode?.(false);
        } catch {
          /* ignore */
        }
      }
      process.stdin.pause();
    };
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
  });
}
