/**
 * Auto-commit dry-run: scan house git tree, draft a commit message via one
 * amore-headless call, write draft + file list to state. Never commits in dry-run.
 *
 * Drafting is cadence-gated (cooldown decoupled from the heartbeat), deduped by
 * porcelain change-set hash, and token-ceiling aware. Live mode behind
 * autoCommitLive ships inert (draft only) until a later phase hardens it.
 */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { LucernaConfig } from "./config.ts";
import { DEFAULT_AUTO_COMMIT_COOLDOWN_MS } from "./config.ts";
import {
  DEFAULT_DREAMS_RESERVE_TOKENS,
  effectiveCeiling,
  isSingleCallSpend,
  isTokenCeilingReached,
} from "./budget.ts";
import { appendNotification } from "./notifications.ts";
import {
  callAmoreHeadless,
  preferStructuredOutput,
  type AmoreHeadlessResult,
} from "./engine/amore-headless.ts";
import { localTimestamp } from "./time.ts";
import type { StateManager } from "./state.ts";

const MAX_DIFFSTAT_CHARS = 12_000;
const MAX_STATUS_LINES = 200;

/** Wall bound for the draft compose driver call. */
export const AUTO_COMMIT_WALL_MS = 120_000;

/** Re-export default cooldown for callers that import from this module. */
export { DEFAULT_AUTO_COMMIT_COOLDOWN_MS };

const DANGEROUS_PATTERNS = [
  /\.env$/,
  /\.env\..+$/,
  /credentials/i,
  /secrets?[./]/i,
  /\.pem$/,
  /\.key$/,
  /id_rsa/,
  /id_ed25519/,
  /\.p12$/,
  /\.pfx$/,
  /password/i,
  /token\.json$/i,
  /auth\.json$/i,
  /\.sqlite$/,
  /\.db$/,
];

const BLOCKED_GIT_FILES = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];

const COMMIT_MSG_SYSTEM = `You generate a single git commit message draft from a status listing and diffstat.
Output ONLY JSON: {"subject":"...","body":"..."}
- subject: imperative, 50-90 chars, no conventional-commit prefixes
- body: bullets when multi-concern; empty string ok for single-concern
- NEVER put a literal double-quote inside subject/body
- Faithful to the file list scope`;

export const COMMIT_MSG_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string" },
    body: { type: "string" },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

export interface CommitMessage {
  subject: string;
  body: string;
}

export interface AutoCommitResult {
  committed: boolean;
  dryRun: boolean;
  files: string[];
  message: CommitMessage | null;
  skippedReason?: string;
  liveInert?: boolean;
  /** True when a draft was produced after a driver call this run. */
  composed?: boolean;
  /** True when the headless driver was invoked this run. */
  driverInvoked?: boolean;
}

export type HeadlessCaller = (opts: {
  cwd: string;
  prompt: string | { system?: string; user: string };
  mode?: "text" | "json";
  jsonSchema?: object;
  maxTurns?: number;
  noSubagents?: boolean;
  wallMs?: number;
  model?: string;
}) => Promise<AmoreHeadlessResult>;

export function isDangerousPath(file: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(file));
}

export function parsePorcelainStatus(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    // porcelain: XY PATH or XY ORIG -> PATH
    const rest = line.slice(3).trim();
    if (!rest) continue;
    const arrow = rest.indexOf(" -> ");
    const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    const clean = path.replace(/^"|"$/g, "").replace(/\\/g, "/");
    if (clean) files.push(clean);
  }
  return files;
}

export function filterSafeFiles(files: string[]): string[] {
  return files.filter((f) => !isDangerousPath(f));
}

/**
 * Paths excluded from auto-commit drafting and change-set hashing.
 * House instrument runtime (state/log/health) must not re-dirty the set after a draft save.
 */
export function isIgnoredForAutoCommit(file: string): boolean {
  const n = file.replace(/\\/g, "/").replace(/^\.\//, "");
  if (n.startsWith("instruments/")) return true;
  if (n.startsWith("node_modules/")) return true;
  if (n === "node_modules" || n === "instruments") return true;
  return false;
}

/** Safe house content only: drop secrets and instrument/runtime noise. */
export function filterDraftFiles(files: string[]): string[] {
  return filterSafeFiles(files).filter((f) => !isIgnoredForAutoCommit(f));
}

/**
 * Keep porcelain lines whose path is draft-eligible. Used for hashing so
 * runtime state writes cannot invalidate an otherwise-stable change-set.
 */
export function filterPorcelainForDraft(porcelainRaw: string): string {
  const kept: string[] = [];
  for (const line of porcelainRaw.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const paths = parsePorcelainStatus(line + "\n");
    if (paths.length === 0) continue;
    const safe = filterDraftFiles(paths);
    if (safe.length === 0) continue;
    kept.push(line);
  }
  return kept.join("\n") + (kept.length ? "\n" : "");
}

export function parseCommitMessageResponse(raw: string): CommitMessage | null {
  let s = raw.trim();
  if (s.includes("</think>")) s = s.split("</think>").pop()!.trim();
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fence) s = fence[1]!.trim();
  try {
    const obj = JSON.parse(s) as { subject?: string; body?: string };
    if (typeof obj.subject === "string" && obj.subject.trim()) {
      return {
        subject: obj.subject.trim().slice(0, 120),
        body: typeof obj.body === "string" ? obj.body : "",
      };
    }
  } catch {
    /* try extract */
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(s.slice(start, end + 1)) as { subject?: string; body?: string };
      if (typeof obj.subject === "string" && obj.subject.trim()) {
        return {
          subject: obj.subject.trim().slice(0, 120),
          body: typeof obj.body === "string" ? obj.body : "",
        };
      }
    } catch {
      return null;
    }
  }
  return null;
}

function git(args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout?.toString() ?? "",
    stderr: r.stderr?.toString() ?? "",
  };
}

export function isGitBusy(houseRoot: string): boolean {
  const gitDir = join(houseRoot, ".git");
  if (!existsSync(gitDir)) return false;
  for (const f of BLOCKED_GIT_FILES) {
    if (existsSync(join(gitDir, f))) return true;
  }
  return false;
}

/** Raw porcelain status text (normalized newlines) for hashing and parsing. */
export function getPorcelainRaw(houseRoot: string): string {
  const r = git(["status", "--porcelain", "-uall"], houseRoot);
  if (r.code !== 0) return "";
  return (r.stdout ?? "").replace(/\r\n/g, "\n");
}

export function getPorcelainChanges(houseRoot: string): string[] {
  return parsePorcelainStatus(getPorcelainRaw(houseRoot)).slice(0, MAX_STATUS_LINES);
}

/**
 * Stable hash of a porcelain change-set. Empty tree hashes to empty string.
 * Used to skip re-drafting when the change-set is unchanged.
 */
export function hashChangeSet(porcelainRaw: string): string {
  const normalized = porcelainRaw.replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex");
}

export function getDiffstat(houseRoot: string, files: string[]): string {
  if (files.length === 0) return "";
  const r = git(["diff", "--stat", "HEAD", "--", ...files.slice(0, 80)], houseRoot);
  let out = r.stdout || "";
  // also untracked names
  if (out.length < MAX_DIFFSTAT_CHARS) {
    const untracked = files.filter((f) => {
      try {
        const st = git(["ls-files", "--error-unmatch", f], houseRoot);
        return st.code !== 0;
      } catch {
        return true;
      }
    });
    if (untracked.length) {
      out += "\nUntracked:\n" + untracked.map((f) => `  ${f}`).join("\n");
    }
  }
  return out.slice(0, MAX_DIFFSTAT_CHARS);
}

export function buildDraftPrompt(statusLines: string, diffstat: string): {
  system: string;
  user: string;
} {
  return {
    system: COMMIT_MSG_SYSTEM,
    user: [
      "## git status --porcelain -uall",
      "",
      statusLines || "(empty)",
      "",
      "## diffstat (capped)",
      "",
      diffstat || "(none)",
    ].join("\n"),
  };
}

export class AutoCommitter {
  private headless: HeadlessCaller;

  constructor(
    private config: LucernaConfig,
    headless?: HeadlessCaller,
    private state?: StateManager,
  ) {
    this.headless = headless ?? callAmoreHeadless;
  }

  async run(opts?: {
    /** Bypass draft cooldown only. Never bypasses token ceiling or enablement. */
    force?: boolean;
    /** Override "now" for cooldown tests. */
    now?: Date;
  }): Promise<AutoCommitResult> {
    const dryRun = this.config.autoCommitDryRun || this.config.dryRun;
    const now = opts?.now ?? new Date();
    const cooldownMs =
      this.config.autoCommitCooldownMs ?? DEFAULT_AUTO_COMMIT_COOLDOWN_MS;

    if (!this.config.autoCommitEnabled && !opts?.force) {
      return {
        committed: false,
        dryRun: true,
        files: [],
        message: null,
        skippedReason: "auto-commit disabled",
        composed: false,
        driverInvoked: false,
      };
    }

    if (!existsSync(join(this.config.houseRoot, ".git"))) {
      return {
        committed: false,
        dryRun,
        files: [],
        message: null,
        skippedReason: "not a git repository",
        composed: false,
        driverInvoked: false,
      };
    }

    if (isGitBusy(this.config.houseRoot)) {
      return {
        committed: false,
        dryRun,
        files: [],
        message: null,
        skippedReason: "git busy",
        composed: false,
        driverInvoked: false,
      };
    }

    // Auto-commit uses ceiling − dreamsReserve. Dreams still allowed above this.
    const reserve =
      this.config.dreamsReserveTokens ?? DEFAULT_DREAMS_RESERVE_TOKENS;
    const autoCommitCeiling = effectiveCeiling(
      "autoCommit",
      this.config.dailyTokenCeiling,
      reserve,
    );
    if (
      this.state &&
      isTokenCeilingReached(this.state.asCounters(), now, autoCommitCeiling)
    ) {
      return {
        committed: false,
        dryRun,
        files: [],
        message: null,
        skippedReason: "daily token ceiling reached",
        composed: false,
        driverInvoked: false,
      };
    }

    // Cadence: decoupled from heartbeat; one draft attempt per cooldown window.
    if (
      this.state &&
      !opts?.force &&
      !this.state.isAutoCommitCooldownElapsed(cooldownMs, now.getTime())
    ) {
      return {
        committed: false,
        dryRun,
        files: [],
        message: null,
        skippedReason: "auto-commit cooldown",
        composed: false,
        driverInvoked: false,
      };
    }

    const porcelainRaw = getPorcelainRaw(this.config.houseRoot);
    const draftPorcelain = filterPorcelainForDraft(porcelainRaw);
    const changeHash = hashChangeSet(draftPorcelain);
    const changes = parsePorcelainStatus(porcelainRaw).slice(0, MAX_STATUS_LINES);
    const safe = filterDraftFiles(changes).slice(0, MAX_STATUS_LINES);
    if (safe.length === 0) {
      const reason =
        changes.length === 0
          ? "no changes"
          : filterSafeFiles(changes).length === 0
            ? "all files filtered (dangerous)"
            : "no draft-eligible changes";
      return {
        committed: false,
        dryRun,
        files: [],
        message: null,
        skippedReason: reason,
        composed: false,
        driverInvoked: false,
      };
    }

    // Dedup: identical change-set since last draft → no driver call.
    const prevHash = this.state?.getAutoCommitMeta().lastChangeHash ?? null;
    if (this.state && prevHash && prevHash === changeHash && !opts?.force) {
      return {
        committed: false,
        dryRun,
        files: safe,
        message: null,
        skippedReason: "unchanged change-set",
        composed: false,
        driverInvoked: false,
      };
    }

    const { message, driverInvoked } = await this.composeDraft(safe);

    // Advance cadence + hash even when the driver fails, so a broken PATH
    // cannot re-fire every heartbeat tick.
    if (this.state) {
      this.state.recordAutoCommitDraft(changeHash, now);
      this.persistDraft(message, safe, dryRun);
      this.state.save();
    } else {
      this.persistDraft(message, safe, dryRun);
    }

    if (!dryRun) {
      return {
        committed: false,
        dryRun: false,
        files: safe,
        message,
        liveInert: true,
        skippedReason: "live mode inert in this release (draft only)",
        composed: true,
        driverInvoked,
      };
    }

    return {
      committed: false,
      dryRun: true,
      files: safe,
      message,
      composed: true,
      driverInvoked,
    };
  }

  private persistDraft(
    message: CommitMessage | null,
    files: string[],
    dryRun: boolean,
  ): void {
    if (!this.state || !message) return;
    this.state.setAutoCommitDraft({
      subject: message.subject,
      body: message.body,
      files,
      createdAt: localTimestamp(),
      dryRun,
    });
    this.state.setActivity("auto-commit-draft", message.subject);
  }

  private async composeDraft(
    files: string[],
  ): Promise<{ message: CommitMessage | null; driverInvoked: boolean }> {
    const status = files.map((f, i) => `${i + 1}\t${f}`).join("\n");
    const diffstat = getDiffstat(this.config.houseRoot, files);
    const prompt = buildDraftPrompt(status, diffstat);
    const fallback = (): CommitMessage => ({
      subject: `Update ${files.length} file${files.length === 1 ? "" : "s"}`,
      body: files.slice(0, 12).map((f) => `- ${f}`).join("\n"),
    });
    try {
      const result = await this.headless({
        cwd: this.config.houseRoot,
        prompt,
        mode: "json",
        jsonSchema: COMMIT_MSG_SCHEMA,
        maxTurns: 1,
        noSubagents: true,
        wallMs: AUTO_COMMIT_WALL_MS,
        model: this.config.autoCommitModel || undefined,
      });
      // Meter tokens like planner calls (planning included in daily ceiling).
      if (this.state && result.usage) {
        this.state.recordTokens(result.usage, "autoCommit");
        if (
          isSingleCallSpend(
            result.usage.total_tokens
              ?? ((result.usage.input_tokens ?? 0) + (result.usage.output_tokens ?? 0)),
            this.config.dailyTokenCeiling,
          )
        ) {
          appendNotification(this.config.runtimeDir, {
            level: "warn",
            kind: "single-call-spend",
            message: `single envelope exceeds 25% of daily ceiling ${this.config.dailyTokenCeiling}`,
          });
        }
      }
      const preferred = preferStructuredOutput(
        (result.raw && typeof result.raw === "object"
          ? result.raw
          : { text: result.text }) as {
          text?: string;
          structuredOutput?: unknown;
        },
      );
      if (preferred.value && typeof preferred.value === "object") {
        const v = preferred.value as { subject?: string; body?: string };
        if (typeof v.subject === "string" && v.subject.trim()) {
          return {
            message: {
              subject: v.subject.trim().slice(0, 120),
              body: typeof v.body === "string" ? v.body : "",
            },
            driverInvoked: true,
          };
        }
      }
      return {
        message: parseCommitMessageResponse(result.text) ?? fallback(),
        driverInvoked: true,
      };
    } catch {
      // Driver missing or failed: still count as an attempted draft for cadence.
      return { message: fallback(), driverInvoked: true };
    }
  }
}

/**
 * Dry-run against an injected file list and mock headless (no real git required).
 * Guarantees committed === false.
 */
export async function dryRunAgainstFixture(
  files: string[],
  headless: HeadlessCaller,
  cwd: string,
): Promise<AutoCommitResult> {
  const safe = filterSafeFiles(files);
  if (safe.length === 0) {
    return {
      committed: false,
      dryRun: true,
      files: [],
      message: null,
      skippedReason: "no safe files",
    };
  }
  const status = safe.map((f, i) => `${i + 1}\t${f}`).join("\n");
  const prompt = buildDraftPrompt(status, "(fixture diffstat omitted)");
  let message: CommitMessage | null = null;
  try {
    const result = await headless({
      cwd,
      prompt,
      mode: "json",
      jsonSchema: COMMIT_MSG_SCHEMA,
      maxTurns: 1,
      noSubagents: true,
    });
    message =
      parseCommitMessageResponse(result.text) ??
      (result.structuredOutput &&
      typeof result.structuredOutput === "object" &&
      typeof (result.structuredOutput as CommitMessage).subject === "string"
        ? {
            subject: (result.structuredOutput as CommitMessage).subject,
            body: (result.structuredOutput as CommitMessage).body ?? "",
          }
        : null);
  } catch {
    message = {
      subject: `Update ${safe.length} files`,
      body: safe.slice(0, 8).map((f) => `- ${f}`).join("\n"),
    };
  }
  return {
    committed: false,
    dryRun: true,
    files: safe,
    message,
  };
}

/** Assert path exists only for typing/tests that inspect mtime. */
export function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
