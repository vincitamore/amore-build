/**
 * Auto-commit dry-run: scan house git tree, draft a commit message via one
 * amore-headless call, write draft + file list to state. Never commits in dry-run.
 *
 * Live mode exists behind autoCommitLive but ships inert (no commit path executed)
 * until a later phase hardens it; tests prove dry-run never commits.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { LucernaConfig } from "./config.ts";
import {
  callAmoreHeadless,
  preferStructuredOutput,
  type AmoreHeadlessResult,
} from "./engine/amore-headless.ts";
import { localTimestamp } from "./time.ts";
import type { StateManager } from "./state.ts";

const MAX_DIFFSTAT_CHARS = 12_000;
const MAX_STATUS_LINES = 200;

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

export function getPorcelainChanges(houseRoot: string): string[] {
  const r = git(["status", "--porcelain", "-uall"], houseRoot);
  if (r.code !== 0) return [];
  return parsePorcelainStatus(r.stdout).slice(0, MAX_STATUS_LINES);
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
    headless: HeadlessCaller = callAmoreHeadless,
    private state?: StateManager,
  ) {
    this.headless = headless;
  }

  async run(opts?: { force?: boolean }): Promise<AutoCommitResult> {
    const dryRun = this.config.autoCommitDryRun || this.config.dryRun;

    if (!this.config.autoCommitEnabled && !opts?.force) {
      return {
        committed: false,
        dryRun: true,
        files: [],
        message: null,
        skippedReason: "auto-commit disabled",
      };
    }

    if (!existsSync(join(this.config.houseRoot, ".git"))) {
      return {
        committed: false,
        dryRun,
        files: [],
        message: null,
        skippedReason: "not a git repository",
      };
    }

    if (isGitBusy(this.config.houseRoot)) {
      return {
        committed: false,
        dryRun,
        files: [],
        message: null,
        skippedReason: "git busy",
      };
    }

    const changes = getPorcelainChanges(this.config.houseRoot);
    const safe = filterSafeFiles(changes);
    if (safe.length === 0) {
      return {
        committed: false,
        dryRun,
        files: [],
        message: null,
        skippedReason: changes.length === 0 ? "no changes" : "all files filtered (dangerous)",
      };
    }

    // Live mode ships inert: draft only, never commit.
    if (!dryRun) {
      const draft = await this.composeDraft(safe);
      this.persistDraft(draft, safe, true);
      return {
        committed: false,
        dryRun: false,
        files: safe,
        message: draft,
        liveInert: true,
        skippedReason: "live mode inert in this release (draft only)",
      };
    }

    const message = await this.composeDraft(safe);
    this.persistDraft(message, safe, true);

    // Dry-run: never stage or commit
    return {
      committed: false,
      dryRun: true,
      files: safe,
      message,
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
    this.state.save();
  }

  private async composeDraft(files: string[]): Promise<CommitMessage | null> {
    const status = files.map((f, i) => `${i + 1}\t${f}`).join("\n");
    const diffstat = getDiffstat(this.config.houseRoot, files);
    const prompt = buildDraftPrompt(status, diffstat);
    try {
      const result = await this.headless({
        cwd: this.config.houseRoot,
        prompt,
        mode: "json",
        jsonSchema: COMMIT_MSG_SCHEMA,
        maxTurns: 1,
        noSubagents: true,
        wallMs: 120_000,
        model: this.config.autoCommitModel || undefined,
      });
      if (this.state && result.usage) {
        this.state.recordTokens(result.usage);
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
            subject: v.subject.trim().slice(0, 120),
            body: typeof v.body === "string" ? v.body : "",
          };
        }
      }
      return (
        parseCommitMessageResponse(result.text) ?? {
          subject: `Update ${files.length} file${files.length === 1 ? "" : "s"}`,
          body: files.slice(0, 12).map((f) => `- ${f}`).join("\n"),
        }
      );
    } catch {
      return {
        subject: `Update ${files.length} file${files.length === 1 ? "" : "s"}`,
        body: files.slice(0, 12).map((f) => `- ${f}`).join("\n"),
      };
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
