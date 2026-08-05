/**
 * Amore headless driver  -  sole LLM path for lucerna.
 *
 * Spawns the `amore` binary with --prompt-file / --output-format json.
 * Model-agnostic: no provider SDKs, no API keys, no hardcoded model ids.
 * Binary resolution: LUCERNA_AMORE_BIN env override, else `amore` on PATH.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "../budget.ts";

export type AmoreJsonEnvelope = {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  num_turns?: number;
  usage?: TokenUsage;
  modelUsage?: Record<string, TokenUsage>;
  structuredOutput?: unknown;
  structuredOutputError?: string;
  model?: string;
};

export type AmoreHeadlessMode = "text" | "json";

export interface CallAmoreHeadlessOptions {
  cwd: string;
  prompt: string | { system?: string; user: string };
  mode?: AmoreHeadlessMode;
  jsonSchema?: object;
  maxTurns?: number;
  permissionMode?: string;
  alwaysApprove?: boolean;
  /** Default true for supervised one-shots. */
  noSubagents?: boolean;
  wallMs?: number;
  /** Optional model entry name; never a hardcoded product default. */
  model?: string;
  /** Override binary (tests / multi-install). */
  amoreBin?: string;
  /** Inject spawn for unit tests. */
  spawnImpl?: typeof spawn;
}

export interface AmoreHeadlessResult {
  text: string;
  structuredOutput?: unknown;
  raw: unknown;
  code: number | null;
  stderr: string;
  usage?: TokenUsage;
  modelUsage?: Record<string, TokenUsage>;
  sessionId?: string;
  stopReason?: string;
  num_turns?: number;
}

const DEFAULT_WALL_MS = 240_000;

/** Resolve the amore binary: LUCERNA_AMORE_BIN, then `amore`. */
export function resolveAmoreBin(override?: string): string {
  return (
    override?.trim() ||
    process.env.LUCERNA_AMORE_BIN?.trim() ||
    "amore"
  );
}

/**
 * Pure argv builder for long-prompt headless runs.
 * Never pairs --single with --prompt-file.
 */
export function buildAmoreHeadlessArgv(opts: {
  promptFile: string;
  cwd: string;
  maxTurns: number;
  jsonSchema?: string;
  outputFormat?: "plain" | "json";
  permissionMode?: string;
  alwaysApprove?: boolean;
  noSubagents?: boolean;
  model?: string;
}): string[] {
  const argv = [
    "--prompt-file",
    opts.promptFile,
    "--cwd",
    opts.cwd,
    "--max-turns",
    String(opts.maxTurns),
    "--output-format",
    opts.outputFormat ?? (opts.jsonSchema ? "json" : "plain"),
  ];
  if (opts.jsonSchema) argv.push("--json-schema", opts.jsonSchema);
  if (opts.noSubagents !== false) argv.push("--no-subagents");
  if (opts.permissionMode) argv.push("--permission-mode", opts.permissionMode);
  if (opts.alwaysApprove) argv.push("--always-approve");
  if (opts.model) argv.push("--model", opts.model);
  return argv;
}

export function composePrompt(prompt: string | { system?: string; user: string }): string {
  if (typeof prompt === "string") return prompt;
  const parts: string[] = [];
  if (prompt.system?.trim()) {
    parts.push("## System\n" + prompt.system.trim());
  }
  parts.push("## User\n" + prompt.user.trim());
  return parts.join("\n\n");
}

/** Parse JSON envelope; tolerate leading/trailing noise. */
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

export function preferStructuredOutput(
  envelope: AmoreJsonEnvelope,
): { value: unknown; source: "structuredOutput" | "text" | "none" } {
  if (envelope.structuredOutput !== undefined && envelope.structuredOutput !== null) {
    return { value: envelope.structuredOutput, source: "structuredOutput" };
  }
  if (typeof envelope.text === "string" && envelope.text.trim()) {
    try {
      const parsed = JSON.parse(envelope.text.trim());
      return { value: parsed, source: "text" };
    } catch {
      try {
        const t = envelope.text.trim();
        const start = t.indexOf("{");
        const end = t.lastIndexOf("}");
        if (start >= 0 && end > start) {
          return { value: JSON.parse(t.slice(start, end + 1)), source: "text" };
        }
      } catch {
        /* fall through */
      }
    }
  }
  return { value: undefined, source: "none" };
}

/**
 * Kill a process tree: Windows taskkill /T, POSIX process group kill when possible.
 */
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
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
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

/**
 * Call amore headless. Sole LLM entry for lucerna auto-commit and dreams.
 */
export async function callAmoreHeadless(
  opts: CallAmoreHeadlessOptions,
): Promise<AmoreHeadlessResult> {
  const mode = opts.mode ?? (opts.jsonSchema ? "json" : "text");
  const maxTurns = opts.maxTurns ?? 1;
  const wallMs = opts.wallMs ?? DEFAULT_WALL_MS;
  const bin = resolveAmoreBin(opts.amoreBin);
  const body = composePrompt(opts.prompt);

  const dir = mkdtempSync(join(tmpdir(), "lucerna-amore-"));
  const promptFile = join(dir, "prompt.md");
  writeFileSync(promptFile, body, "utf-8");

  try {
    const schemaStr =
      mode === "json" && opts.jsonSchema
        ? JSON.stringify(opts.jsonSchema)
        : undefined;
    const argv = buildAmoreHeadlessArgv({
      promptFile,
      cwd: opts.cwd,
      maxTurns,
      jsonSchema: schemaStr,
      outputFormat: mode === "json" ? "json" : "plain",
      permissionMode: opts.permissionMode,
      alwaysApprove: opts.alwaysApprove,
      noSubagents: opts.noSubagents,
      model: opts.model?.trim() || undefined,
    });

    if (argv.includes("--single") && argv.includes("--prompt-file")) {
      throw new Error("internal error: --single must not pair with --prompt-file");
    }

    const { code, stdout, stderr } = await runAmoreProcess(
      bin,
      argv,
      opts.cwd,
      wallMs,
      opts.spawnImpl,
    );

    if (mode === "json") {
      const envelope = parseJsonEnvelope(stdout);
      const preferred = preferStructuredOutput(envelope);
      const text =
        typeof envelope.text === "string"
          ? envelope.text
          : preferred.value !== undefined
            ? JSON.stringify(preferred.value)
            : stdout;
      return {
        text,
        structuredOutput: preferred.value,
        raw: envelope,
        code,
        stderr,
        usage: envelope.usage,
        modelUsage: envelope.modelUsage,
        sessionId: envelope.sessionId,
        stopReason: envelope.stopReason,
        num_turns: envelope.num_turns,
      };
    }

    // plain mode: still try to parse envelope if stdout looks like JSON
    let usage: TokenUsage | undefined;
    let modelUsage: Record<string, TokenUsage> | undefined;
    try {
      const env = parseJsonEnvelope(stdout);
      usage = env.usage;
      modelUsage = env.modelUsage;
      return {
        text: typeof env.text === "string" ? env.text : stdout,
        structuredOutput: undefined,
        raw: env,
        code,
        stderr,
        usage,
        modelUsage,
        sessionId: env.sessionId,
        stopReason: env.stopReason,
        num_turns: env.num_turns,
      };
    } catch {
      return {
        text: stdout,
        structuredOutput: undefined,
        raw: { text: stdout },
        code,
        stderr,
      };
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
