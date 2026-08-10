/**
 * Amore-headless single-shot lens runner.
 *
 * Flow: build slice → compose prompt → scrub (fail-closed) → write prompt-file
 * → spawn amore once → parse JSON envelope → write dated report → audit always.
 *
 * Binary: SPECULUM_AMORE_BIN, else `amore` on PATH.
 * Payload cap: 100 KB of prompt-file (never silently truncated).
 */

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "./store/db";
import {
  appendAuditRecord,
  type AuditRecord,
  type SelectionDescriptor,
  defaultAuditPath,
} from "./audit";
import { defaultReportsDir } from "./paths";
import {
  scrubPayload,
  formatScrubReport,
  LENS_PAYLOAD_CAP_BYTES,
  type ScrubReport,
} from "./scrub";
import { buildSlice, renderPromptTemplate, type SliceOptions, type SliceResult } from "./slice";
import { getLens, type LensDefinition } from "./lenses";

export const DEFAULT_MAX_TURNS = 4;
export const DEFAULT_WALL_MS = 240_000;

export type AmoreJsonEnvelope = {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  num_turns?: number;
  usage?: Record<string, number>;
  modelUsage?: Record<string, Record<string, number>>;
  model?: string;
  structuredOutput?: unknown;
};

export interface LensRunOptions extends SliceOptions {
  dryRun?: boolean;
  auditPath?: string;
  reportsDir?: string;
  maxBytes?: number;
  maxTurns?: number;
  wallMs?: number;
  amoreBin?: string;
  /** Inject spawn for unit tests (stub binary never invoked when dry-run). */
  spawnImpl?: typeof spawn;
  /** Override home for scrub path redaction (tests). */
  scrubHomeDir?: string;
  /** Scratch cwd for amore --cwd (defaults to a temp dir). */
  scratchCwd?: string;
}

export interface LensRunResult {
  lens: string;
  refused: boolean;
  refusedReason: string | null;
  dryRun: boolean;
  slice: SliceResult;
  scrub: ScrubReport;
  envelope: AmoreJsonEnvelope | null;
  modelId: string | null;
  text: string | null;
  reportPath: string | null;
  durationMs: number;
  audit: AuditRecord;
  /** True if the runner attempted to spawn amore (for tests). */
  spawned: boolean;
}

/** Resolve amore binary: explicit override, SPECULUM_AMORE_BIN, else `amore`. */
export function resolveAmoreBin(override?: string): string {
  return override?.trim() || process.env.SPECULUM_AMORE_BIN?.trim() || "amore";
}

export function buildAmoreLensArgv(opts: {
  promptFile: string;
  cwd: string;
  maxTurns: number;
}): string[] {
  return [
    "--prompt-file",
    opts.promptFile,
    "--output-format",
    "json",
    "--max-turns",
    String(opts.maxTurns),
    "--cwd",
    opts.cwd,
  ];
}

export function parseJsonEnvelope(stdout: string): AmoreJsonEnvelope {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as AmoreJsonEnvelope;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as AmoreJsonEnvelope;
    }
    throw new Error(`not JSON: ${trimmed.slice(0, 200)}`);
  }
}

/** Kill a process tree: Windows taskkill /T, POSIX process group when possible. */
export function killProcessTree(
  child: { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean },
  spawnImpl: typeof spawn = spawn,
): void {
  try {
    if (process.platform === "win32" && child.pid) {
      spawnImpl("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
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
  envOverride?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...(envOverride ?? {}) },
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child, spawnImpl);
      reject(new Error(`amore wall timeout after ${wallMs}ms`));
    }, wallMs);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function selectionDescriptor(opts: LensRunOptions, slice: SliceResult): SelectionDescriptor {
  return {
    sessionId: opts.sessionId ?? slice.sessionId,
    sessionIds: opts.sessionIds ?? slice.selectionSessionIds,
    projectPath: opts.projectPath ?? slice.project,
    since: opts.since?.toISOString() ?? null,
    until: opts.until?.toISOString() ?? null,
    lastN: opts.lastN ?? null,
    probeHit: opts.probeHit ?? null,
    includeSubagents: opts.includeSubagents !== false,
  };
}

function modelIdFromEnvelope(env: AmoreJsonEnvelope | null): string | null {
  if (!env) return null;
  if (typeof env.model === "string" && env.model.trim()) return env.model.trim();
  if (env.modelUsage && typeof env.modelUsage === "object") {
    const keys = Object.keys(env.modelUsage);
    if (keys.length > 0) return keys[0]!;
  }
  return null;
}

function writeLensReport(opts: {
  reportsDir: string;
  lens: LensDefinition;
  text: string;
  modelId: string | null;
  slice: SliceResult;
  scrub: ScrubReport;
}): string {
  mkdirSync(opts.reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safe = opts.lens.name.replace(/[^a-z0-9_-]+/gi, "-");
  const file = join(opts.reportsDir, `${stamp}-${safe}.md`);
  const body = [
    `# Speculum lens: ${opts.lens.name}`,
    "",
    `- **Lens:** ${opts.lens.name}`,
    `- **Model:** ${opts.modelId ?? "(not reported)"}`,
    `- **Session:** ${opts.slice.sessionId ?? "(multi / none)"}`,
    `- **Project:** ${opts.slice.project ?? "(none)"}`,
    `- **Generated:** ${new Date().toISOString()}`,
    `- **Payload bytes (scrubbed):** ${opts.scrub.bytes}`,
    `- **Scrub counts:** ${JSON.stringify(opts.scrub.counts)}`,
    "",
    "---",
    "",
    opts.text.trim(),
    "",
  ].join("\n");
  writeFileSync(file, body, "utf-8");
  return file;
}

/**
 * Run a named lens over a selected slice. Always appends an audit record.
 * When dryRun is true, selection + scrub + audit run but the binary is never spawned.
 */
export async function runLens(
  db: Db,
  lensName: string,
  opts: LensRunOptions = {},
): Promise<LensRunResult> {
  const lens = getLens(lensName);
  if (!lens) {
    throw new Error(
      `unknown lens: ${lensName} (run \`speculum lenses\` for the registry)`,
    );
  }

  const auditPath = opts.auditPath ?? defaultAuditPath();
  const reportsDir = opts.reportsDir ?? defaultReportsDir();
  const maxBytes = opts.maxBytes ?? LENS_PAYLOAD_CAP_BYTES;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const wallMs = opts.wallMs ?? DEFAULT_WALL_MS;
  const dryRun = opts.dryRun === true;

  const slice = buildSlice(db, opts);
  const constructed = renderPromptTemplate(lens.template, slice);
  const scrub = scrubPayload(constructed, {
    maxBytes,
    homeDir: opts.scrubHomeDir,
  });

  let refused = !scrub.ok;
  let refusedReason = scrub.refuseReason;
  let spawned = false;
  let envelope: AmoreJsonEnvelope | null = null;
  let text: string | null = null;
  let reportPath: string | null = null;
  let durationMs = 0;
  let error: string | null = null;

  if (refused) {
    // fail-closed: never spawn
  } else if (dryRun) {
    refused = true;
    refusedReason = `dry-run: scrub ok (${scrub.bytes} bytes); model not invoked`;
  } else {
    const bin = resolveAmoreBin(opts.amoreBin);
    const dir = mkdtempSync(join(tmpdir(), "speculum-lens-"));
    const promptFile = join(dir, "prompt.md");
    const scratch = opts.scratchCwd ?? join(dir, "scratch");
    mkdirSync(scratch, { recursive: true });
    writeFileSync(promptFile, scrub.text, "utf-8");

    const argv = buildAmoreLensArgv({
      promptFile,
      cwd: scratch,
      maxTurns,
    });

    const start = Date.now();
    try {
      spawned = true;
      // Home isolation (polluter fix): the headless amore writes its session
      // files under this scratch home, never the operator's real ~/.amore.
      const scratchHome = join(dir, "amore-home");
      mkdirSync(scratchHome, { recursive: true });
      // Seed the scratch home with the real config so the headless amore
      // authenticates and routes through the same models — while its session
      // files stay in this scratch tree, never the real home (auth works,
      // pollution does not). The per-run copy is removed with the scratch
      // tree in the finally below.
      const realHome = process.env.AMORE_HOME?.trim() || join(homedir(), ".amore");
      const realConfig = join(realHome, "config.toml");
      if (existsSync(realConfig)) {
        copyFileSync(realConfig, join(scratchHome, "config.toml"));
      }
      const { code, stdout, stderr } = await runAmoreProcess(
        bin,
        argv,
        scratch,
        wallMs,
        opts.spawnImpl,
        { AMORE_HOME: scratchHome, GROK_HOME: scratchHome },
      );
      durationMs = Date.now() - start;
      if (code !== 0 && code !== null) {
        error = `amore exited ${code}: ${stderr.slice(0, 500)}`;
        refused = true;
        refusedReason = error;
      } else {
        envelope = parseJsonEnvelope(stdout);
        text =
          typeof envelope.text === "string" && envelope.text.length > 0
            ? envelope.text
            : stdout;
        const modelId = modelIdFromEnvelope(envelope);
        reportPath = writeLensReport({
          reportsDir,
          lens,
          text: text ?? "",
          modelId,
          slice,
          scrub,
        });
      }
    } catch (e) {
      durationMs = Date.now() - start;
      error = e instanceof Error ? e.message : String(e);
      refused = true;
      refusedReason = error;
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  const modelId = modelIdFromEnvelope(envelope);
  const decision = dryRun
    ? "dry-run"
    : refused
      ? "refused"
      : "accepted";

  const audit: AuditRecord = {
    ts: new Date().toISOString(),
    lens: lens.name,
    selection: selectionDescriptor(opts, slice),
    payloadBytes: scrub.bytes,
    scrubCounts: scrub.counts,
    decision,
    reason: refusedReason,
    modelId: modelId,
    usage: envelope?.usage ?? null,
    sessionIdFromEnvelope: envelope?.sessionId ?? null,
    stopReason: envelope?.stopReason ?? null,
    durationMs: spawned ? durationMs : null,
    reportPath,
  };
  appendAuditRecord(audit, auditPath);

  return {
    lens: lens.name,
    refused,
    refusedReason,
    dryRun,
    slice,
    scrub,
    envelope,
    modelId,
    text,
    reportPath,
    durationMs,
    audit,
    spawned,
  };
}

export { formatScrubReport };
