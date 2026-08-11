/**
 * Summarize orchestrator: select → digest → scrub → (spawn | dry-run) → parse → apply → audit.
 *
 * Second egress class beside the lens; inherits the same binary resolution,
 * wall timeout, scratch home isolation, fail-closed scrub, and audit ledger.
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
import type { Db } from "../store/db";
import {
  appendAuditRecord,
  type AuditRecord,
  defaultAuditPath,
} from "../audit";
import {
  scrubPayload,
  type ScrubReport,
} from "../scrub";
import {
  resolveAmoreBin,
  buildAmoreLensArgv,
  parseJsonEnvelope,
  runAmoreProcess,
  DEFAULT_WALL_MS,
  type AmoreJsonEnvelope,
} from "../lens-runner";
import { buildSessionDigest, type SessionDigest } from "./digest";
import { renderSummarizePrompt } from "./prompt";
import { parseTitleReply } from "./parse";
import { applyGeneratedTitle } from "./apply";
import {
  selectSessionsForSummarize,
  estimateTokens,
  DEFAULT_SUMMARIZE_LIMIT,
  type SelectOptions,
  type SelectedSession,
} from "./select";

/** max-turns for a single JSON title reply. */
export const SUMMARIZE_MAX_TURNS = 1;

export type SummarizeOutcome =
  | "generated"
  | "refused_scrub"
  | "failed_parse"
  | "failed_spawn"
  | "empty_digest"
  | "dry-run";

export interface SummarizeSessionResult {
  sessionId: string;
  outcome: SummarizeOutcome;
  title?: string;
  summary?: string;
  reason?: string;
  digestBytes?: number;
  digestHash?: string;
  estimatedTokens?: number;
  modelId?: string | null;
}

export interface SummarizeRunOptions extends SelectOptions {
  dryRun?: boolean;
  auditPath?: string;
  wallMs?: number;
  amoreBin?: string;
  /** Inject spawn for unit tests. */
  spawnImpl?: typeof spawn;
  /** Override home for scrub path redaction (tests). */
  scrubHomeDir?: string;
  maxBytes?: number;
}

export interface SummarizeRunReport {
  attempted: number;
  generated: number;
  refused_scrub: number;
  failed_parse: number;
  failed_spawn: number;
  empty_digest: number;
  dry_run: boolean;
  results: SummarizeSessionResult[];
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

function auditSummarize(opts: {
  auditPath: string;
  sessionId: string;
  digest: SessionDigest | null;
  scrub: ScrubReport | null;
  decision: AuditRecord["decision"];
  reason: string | null;
  modelId?: string | null;
  usage?: AmoreJsonEnvelope["usage"] | null;
  durationMs?: number | null;
  sessionIdFromEnvelope?: string | null;
  stopReason?: string | null;
}): void {
  const hashPart = opts.digest ? `digest=${opts.digest.hash.slice(0, 16)}` : "digest=none";
  const reason = opts.reason
    ? `${hashPart}; ${opts.reason}`
    : hashPart;

  const record: AuditRecord = {
    ts: new Date().toISOString(),
    lens: "summarize",
    selection: { sessionId: opts.sessionId },
    payloadBytes: opts.scrub?.bytes ?? opts.digest?.bytes ?? 0,
    scrubCounts: opts.scrub?.counts ?? {
      secret: 0,
      email: 0,
      "home-path": 0,
      "password-assignment": 0,
    },
    decision: opts.decision,
    reason,
    modelId: opts.modelId ?? null,
    usage: opts.usage ?? null,
    sessionIdFromEnvelope: opts.sessionIdFromEnvelope ?? null,
    stopReason: opts.stopReason ?? null,
    durationMs: opts.durationMs ?? null,
    reportPath: null,
  };
  appendAuditRecord(record, opts.auditPath);
}

async function spawnForTitle(
  promptText: string,
  opts: SummarizeRunOptions,
): Promise<{
  envelope: AmoreJsonEnvelope | null;
  text: string | null;
  error: string | null;
  durationMs: number;
  spawned: boolean;
}> {
  const bin = resolveAmoreBin(opts.amoreBin);
  const wallMs = opts.wallMs ?? DEFAULT_WALL_MS;
  const dir = mkdtempSync(join(tmpdir(), "speculum-summarize-"));
  const promptFile = join(dir, "prompt.md");
  const scratch = join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(promptFile, promptText, "utf-8");

  const argv = buildAmoreLensArgv({
    promptFile,
    cwd: scratch,
    maxTurns: SUMMARIZE_MAX_TURNS,
  });

  const start = Date.now();
  try {
    const scratchHome = join(dir, "amore-home");
    mkdirSync(scratchHome, { recursive: true });
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
    const durationMs = Date.now() - start;
    if (code !== 0 && code !== null) {
      return {
        envelope: null,
        text: null,
        error: `amore exited ${code}: ${stderr.slice(0, 500)}`,
        durationMs,
        spawned: true,
      };
    }
    const envelope = parseJsonEnvelope(stdout);
    const text =
      typeof envelope.text === "string" && envelope.text.length > 0
        ? envelope.text
        : stdout;
    return { envelope, text, error: null, durationMs, spawned: true };
  } catch (e) {
    return {
      envelope: null,
      text: null,
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start,
      spawned: true,
    };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function processOne(
  db: Db,
  session: SelectedSession,
  opts: SummarizeRunOptions,
  auditPath: string,
): Promise<SummarizeSessionResult> {
  const digest = buildSessionDigest(db, session.id);

  if (!digest.hasContent) {
    auditSummarize({
      auditPath,
      sessionId: session.id,
      digest,
      scrub: null,
      decision: "refused",
      reason: "empty digest: no content-bearing turns",
    });
    return {
      sessionId: session.id,
      outcome: "empty_digest",
      reason: "no content-bearing turns",
      digestBytes: digest.bytes,
      digestHash: digest.hash,
      estimatedTokens: estimateTokens(digest.bytes),
    };
  }

  const prompt = renderSummarizePrompt(digest.text);
  const scrub = scrubPayload(prompt, {
    maxBytes: opts.maxBytes,
    homeDir: opts.scrubHomeDir,
  });

  if (!scrub.ok) {
    auditSummarize({
      auditPath,
      sessionId: session.id,
      digest,
      scrub,
      decision: "refused",
      reason: scrub.refuseReason ?? "scrub refused",
    });
    return {
      sessionId: session.id,
      outcome: "refused_scrub",
      reason: scrub.refuseReason ?? "scrub refused",
      digestBytes: digest.bytes,
      digestHash: digest.hash,
      estimatedTokens: estimateTokens(scrub.bytes),
    };
  }

  if (opts.dryRun) {
    auditSummarize({
      auditPath,
      sessionId: session.id,
      digest,
      scrub,
      decision: "dry-run",
      reason: `dry-run: scrub ok (${scrub.bytes} bytes); model not invoked`,
    });
    return {
      sessionId: session.id,
      outcome: "dry-run",
      digestBytes: digest.bytes,
      digestHash: digest.hash,
      estimatedTokens: estimateTokens(scrub.bytes),
    };
  }

  const spawnResult = await spawnForTitle(scrub.text, opts);
  if (spawnResult.error || !spawnResult.text) {
    auditSummarize({
      auditPath,
      sessionId: session.id,
      digest,
      scrub,
      decision: "refused",
      reason: spawnResult.error ?? "empty model reply",
      durationMs: spawnResult.durationMs,
    });
    return {
      sessionId: session.id,
      outcome: "failed_spawn",
      reason: spawnResult.error ?? "empty model reply",
      digestBytes: digest.bytes,
      digestHash: digest.hash,
      estimatedTokens: estimateTokens(scrub.bytes),
    };
  }

  const parsed = parseTitleReply(spawnResult.text);
  if (!parsed.ok) {
    auditSummarize({
      auditPath,
      sessionId: session.id,
      digest,
      scrub,
      decision: "refused",
      reason: `parse failed: ${parsed.reason}`,
      modelId: modelIdFromEnvelope(spawnResult.envelope),
      usage: spawnResult.envelope?.usage ?? null,
      durationMs: spawnResult.durationMs,
      sessionIdFromEnvelope: spawnResult.envelope?.sessionId ?? null,
      stopReason: spawnResult.envelope?.stopReason ?? null,
    });
    return {
      sessionId: session.id,
      outcome: "failed_parse",
      reason: parsed.reason,
      digestBytes: digest.bytes,
      digestHash: digest.hash,
      estimatedTokens: estimateTokens(scrub.bytes),
      modelId: modelIdFromEnvelope(spawnResult.envelope),
    };
  }

  const modelId = modelIdFromEnvelope(spawnResult.envelope) ?? "";
  applyGeneratedTitle(db, {
    sessionId: session.id,
    title: parsed.value.title,
    summary: parsed.value.summary,
    modelId,
    sourceEvents: digest.sourceEvents,
  });

  auditSummarize({
    auditPath,
    sessionId: session.id,
    digest,
    scrub,
    decision: "accepted",
    reason: `generated title=${parsed.value.title}`,
    modelId,
    usage: spawnResult.envelope?.usage ?? null,
    durationMs: spawnResult.durationMs,
    sessionIdFromEnvelope: spawnResult.envelope?.sessionId ?? null,
    stopReason: spawnResult.envelope?.stopReason ?? null,
  });

  return {
    sessionId: session.id,
    outcome: "generated",
    title: parsed.value.title,
    summary: parsed.value.summary,
    digestBytes: digest.bytes,
    digestHash: digest.hash,
    estimatedTokens: estimateTokens(scrub.bytes),
    modelId,
  };
}

/**
 * Run summarize over the selected sessions. Always audits each attempt.
 * When dryRun is true, never spawns the binary.
 */
export async function runSummarize(
  db: Db,
  opts: SummarizeRunOptions = {},
): Promise<SummarizeRunReport> {
  const auditPath = opts.auditPath ?? defaultAuditPath();
  const selected = selectSessionsForSummarize(db, opts);
  const results: SummarizeSessionResult[] = [];

  for (const session of selected) {
    const one = await processOne(db, session, opts, auditPath);
    results.push(one);
  }

  const count = (o: SummarizeOutcome) =>
    results.filter((r) => r.outcome === o).length;

  return {
    attempted: results.length,
    generated: count("generated"),
    refused_scrub: count("refused_scrub"),
    failed_parse: count("failed_parse"),
    failed_spawn: count("failed_spawn"),
    empty_digest: count("empty_digest"),
    dry_run: opts.dryRun === true,
    results,
  };
}

/** Machine-readable subset matching the CLI --json contract. */
export function toJsonReport(report: SummarizeRunReport): {
  attempted: number;
  generated: number;
  refused_scrub: number;
  failed_parse: number;
  results: Array<{ sessionId: string; outcome: string; title?: string }>;
} {
  return {
    attempted: report.attempted,
    generated: report.generated,
    refused_scrub: report.refused_scrub,
    failed_parse: report.failed_parse,
    results: report.results.map((r) => {
      const row: { sessionId: string; outcome: string; title?: string } = {
        sessionId: r.sessionId,
        outcome: r.outcome,
      };
      if (r.title) row.title = r.title;
      return row;
    }),
  };
}

export { DEFAULT_SUMMARIZE_LIMIT, estimateTokens, selectSessionsForSummarize };
export type { SelectOptions, SelectedSession };
