// Amore headless spawn — sole LLM path for vinculum (SF-1 contract).
// Binary: AMORE_BIN env, else `amore` on PATH. No provider SDKs, no API keys,
// no hardcoded model ids. Model id is taken from the envelope after the run.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type AmoreJsonEnvelope = {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  num_turns?: number;
  usage?: Record<string, number>;
  modelUsage?: Record<string, Record<string, number>>;
  structuredOutput?: unknown;
  structuredOutputError?: string;
  model?: string;
};

export interface AmoreSpawnOptions {
  cwd: string;
  prompt: string;
  jsonSchema: object;
  maxTurns?: number;
  wallMs?: number;
  /** Override binary (tests / multi-install). */
  amoreBin?: string;
  /** Inject spawn for unit tests. */
  spawnImpl?: typeof spawn;
  /** When set, skip which/access preflight (tests). */
  skipBinaryCheck?: boolean;
}

export interface AmoreSpawnResult {
  envelope: AmoreJsonEnvelope;
  structuredOutput: unknown;
  modelId: string | null;
  code: number | null;
  stderr: string;
  stdout: string;
}

export const DEFAULT_WALL_MS = 240_000;
export const DEFAULT_MAX_TURNS = 4;

/** Resolve amore binary: explicit override, AMORE_BIN, else `amore`. */
export function resolveAmoreBin(override?: string): string {
  return override?.trim() || process.env.AMORE_BIN?.trim() || 'amore';
}

/**
 * Pure argv builder for schema-constrained headless runs.
 * Never pairs --single with --prompt-file.
 */
export function buildAmoreJudgeArgv(opts: {
  promptFile: string;
  cwd: string;
  maxTurns: number;
  jsonSchema: string;
}): string[] {
  return [
    '--prompt-file',
    opts.promptFile,
    '--cwd',
    opts.cwd,
    '--max-turns',
    String(opts.maxTurns),
    '--output-format',
    'json',
    '--json-schema',
    opts.jsonSchema,
    '--no-subagents',
  ];
}

export function parseJsonEnvelope(stdout: string): AmoreJsonEnvelope {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as AmoreJsonEnvelope;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as AmoreJsonEnvelope;
    }
    throw new Error(`amore stdout is not JSON: ${trimmed.slice(0, 200)}`);
  }
}

export function preferStructuredOutput(
  envelope: AmoreJsonEnvelope,
): { value: unknown; source: 'structuredOutput' | 'text' | 'none' } {
  if (envelope.structuredOutput !== undefined && envelope.structuredOutput !== null) {
    return { value: envelope.structuredOutput, source: 'structuredOutput' };
  }
  if (typeof envelope.text === 'string' && envelope.text.trim()) {
    try {
      return { value: JSON.parse(envelope.text.trim()), source: 'text' };
    } catch {
      try {
        const t = envelope.text.trim();
        const start = t.indexOf('{');
        const end = t.lastIndexOf('}');
        if (start >= 0 && end > start) {
          return { value: JSON.parse(t.slice(start, end + 1)), source: 'text' };
        }
      } catch {
        /* fall through */
      }
    }
  }
  return { value: undefined, source: 'none' };
}

export function modelIdFromEnvelope(env: AmoreJsonEnvelope | null): string | null {
  if (!env) return null;
  if (typeof env.model === 'string' && env.model.trim()) return env.model.trim();
  if (env.modelUsage && typeof env.modelUsage === 'object') {
    const keys = Object.keys(env.modelUsage);
    if (keys.length > 0) return keys[0]!;
  }
  return null;
}

export function killProcessTree(
  child: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean },
  spawnImpl: typeof spawn = spawn,
): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawnImpl('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    } else {
      child.kill();
    }
  } catch {
    /* ignore */
  }
}

export function runAmoreProcess(
  bin: string,
  argv: string[],
  cwd: string,
  wallMs: number,
  spawnImpl: typeof spawn = spawn,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child, spawnImpl);
      reject(new Error(`amore wall timeout after ${wallMs}ms`));
    }, wallMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** True when the binary path looks resolvable (absolute path exists, or on PATH via Bun.which). */
export function isAmoreBinaryAvailable(bin: string): boolean {
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\') || /^[A-Za-z]:/.test(bin)) {
    return existsSync(bin);
  }
  try {
    // Bun.which is available in the Bun runtime used by iris.
    const which = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which;
    if (typeof which === 'function') {
      return which(bin) !== null;
    }
  } catch {
    /* fall through */
  }
  return true; // unknown — let spawn fail honestly
}

export class AmoreBinaryMissingError extends Error {
  readonly code = 'AMORE_MISSING';
  constructor(bin: string) {
    super(
      `amore binary not found (${bin}). Set AMORE_BIN to the binary path, or put amore on PATH. Tier-2 requires a working amore binary.`,
    );
    this.name = 'AmoreBinaryMissingError';
  }
}

/**
 * Spawn amore headless with a prompt file and JSON schema.
 * Returns structuredOutput preferred from the envelope.
 */
export async function callAmoreJudge(opts: AmoreSpawnOptions): Promise<AmoreSpawnResult> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const wallMs = opts.wallMs ?? DEFAULT_WALL_MS;
  const bin = resolveAmoreBin(opts.amoreBin);

  if (!opts.skipBinaryCheck && !isAmoreBinaryAvailable(bin)) {
    throw new AmoreBinaryMissingError(bin);
  }

  const dir = mkdtempSync(join(tmpdir(), 'vinculum-amore-'));
  const promptFile = join(dir, 'prompt.md');
  writeFileSync(promptFile, opts.prompt, 'utf-8');

  try {
    const schemaStr = JSON.stringify(opts.jsonSchema);
    const argv = buildAmoreJudgeArgv({
      promptFile,
      cwd: opts.cwd,
      maxTurns,
      jsonSchema: schemaStr,
    });
    if (argv.includes('--single') && argv.includes('--prompt-file')) {
      throw new Error('internal error: --single must not pair with --prompt-file');
    }

    let code: number | null;
    let stdout: string;
    let stderr: string;
    try {
      ({ code, stdout, stderr } = await runAmoreProcess(
        bin,
        argv,
        opts.cwd,
        wallMs,
        opts.spawnImpl,
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('ENOENT') ||
        msg.includes('not found') ||
        (err as NodeJS.ErrnoException)?.code === 'ENOENT'
      ) {
        throw new AmoreBinaryMissingError(bin);
      }
      throw err;
    }

    if (code !== 0 && code !== null) {
      throw new Error(`amore exited ${code}: ${stderr.slice(0, 500) || '(no stderr)'}`);
    }

    const envelope = parseJsonEnvelope(stdout);
    const preferred = preferStructuredOutput(envelope);
    return {
      envelope,
      structuredOutput: preferred.value,
      modelId: modelIdFromEnvelope(envelope),
      code,
      stderr,
      stdout,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
