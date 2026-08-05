/**
 * Agentic dream surfaces: prompts, manifests, proposals, governance after-check.
 *
 * Model path remains structural: only the amore binary via amore-headless.
 * Writable surface is the shipped governance WRITABLE list + lucerna runtime;
 * after-check enforces that boundary by construction.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  callAmoreHeadless,
  type AmoreHeadlessResult,
  type CallAmoreHeadlessOptions,
} from "./engine/amore-headless.ts";
import {
  canWrite,
  defaultLists,
  isLucernaRuntimePath,
  isProtectedPath,
  writeGuarded,
  type GovernanceLists,
  PROTECTED_PATTERNS,
} from "./governance.ts";
import { localDate, localFileTimestamp, localTimestamp } from "./time.ts";
import type { LucernaConfig } from "./config.ts";

/** Default wall for agentic amore spawns (20 minutes). */
export const DEFAULT_AGENTIC_WALL_MS = 20 * 60 * 1000;

/**
 * Verified against pager cli.rs: --disallowed-tools removes built-in tools.
 * Maintenance dreams disable web search and web fetch.
 */
export const MAINTENANCE_DISALLOWED_TOOLS = "web_search,web_fetch";

/** Keys that spawn a full agentic amore loop (not thin shell actions). */
export const FULL_AGENTIC_KEYS = ["self-orient", "agentic-housekeeping"] as const;
export type FullAgenticKey = (typeof FULL_AGENTIC_KEYS)[number];

export function isFullAgenticKey(key: string): key is FullAgenticKey {
  return (FULL_AGENTIC_KEYS as readonly string[]).includes(key);
}

export function agenticMaxTurns(actionKey: string): number {
  switch (actionKey) {
    case "self-orient":
      return 32;
    case "agentic-housekeeping":
      return 16;
    default:
      return 12;
  }
}

export function agenticWallMs(actionKey: string, overrideMs?: number): number {
  if (typeof overrideMs === "number" && overrideMs > 0) return overrideMs;
  const env = process.env.LUCERNA_AGENTIC_WALL_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 30_000) return n;
  }
  switch (actionKey) {
    case "self-orient":
      return DEFAULT_AGENTIC_WALL_MS;
    case "agentic-housekeeping":
      return DEFAULT_AGENTIC_WALL_MS;
    default:
      return DEFAULT_AGENTIC_WALL_MS;
  }
}

// ── Manifest contract (protocol §3) ─────────────────────────────────────────

/** Compact stamp for manifest filenames: YYYYMMDD-HHmmss (local). */
export function dreamManifestStamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

/**
 * Relative path: forge/dreams/sessions/<YYYYMMDD-HHmmss>-<action>.manifest.md
 */
export function dreamManifestRelPath(actionKey: string, stamp?: string): string {
  const s = stamp ?? dreamManifestStamp();
  return `forge/dreams/sessions/${s}-${actionKey}.manifest.md`;
}

export function buildManifestFrontmatter(opts: {
  actionKey: string;
  goal: string;
  reviewStatus?: "pending" | "reviewed";
  created?: string;
}): string {
  const created = opts.created ?? localDate();
  const goal = JSON.stringify(opts.goal);
  const review = opts.reviewStatus ?? "pending";
  return [
    "---",
    "type: forge",
    `pipeline: dream-${opts.actionKey}`,
    "recipe: dream",
    `goal: ${goal}`,
    `created: '${created}'`,
    "triggered-by: dream",
    `review-status: ${review}`,
    `tags: [dream, ${opts.actionKey}]`,
    "---",
  ].join("\n");
}

export function buildManifestBody(opts: {
  actionKey: string;
  reason: string;
  whatRan: string;
  whatRead: string[];
  whatProduced: string[];
  breachNote?: string;
}): string {
  const lines = [
    `# Dream manifest: ${opts.actionKey}`,
    "",
    `Reason: ${opts.reason}`,
    "",
    "## What ran",
    "",
    opts.whatRan,
    "",
    "## What was read",
    "",
    ...(opts.whatRead.length
      ? opts.whatRead.map((p) => `- \`${p}\``)
      : ["- (none recorded)"]),
    "",
    "## What was produced",
    "",
    ...(opts.whatProduced.length
      ? opts.whatProduced.map((p) => `- \`${p}\``)
      : ["- (none)"]),
    "",
  ];
  if (opts.breachNote) {
    lines.push(
      "## Governance breach",
      "",
      opts.breachNote,
      "",
      "Review status stays pending until a resident reviews the breach.",
      "",
    );
  }
  lines.push(`Generated at ${localTimestamp()} by lucerna agentic dream.`);
  return lines.join("\n");
}

export function writeDreamManifest(
  houseRoot: string,
  opts: {
    actionKey: string;
    goal: string;
    reason: string;
    whatRan: string;
    whatRead: string[];
    whatProduced: string[];
    stamp?: string;
    reviewStatus?: "pending" | "reviewed";
    breachNote?: string;
    lists?: GovernanceLists;
  },
): { absPath: string; relPath: string } {
  const lists = opts.lists ?? defaultLists();
  const rel = dreamManifestRelPath(opts.actionKey, opts.stamp);
  const abs = join(houseRoot, rel);
  const body = [
    buildManifestFrontmatter({
      actionKey: opts.actionKey,
      goal: opts.goal,
      reviewStatus: opts.reviewStatus ?? "pending",
    }),
    "",
    buildManifestBody({
      actionKey: opts.actionKey,
      reason: opts.reason,
      whatRan: opts.whatRan,
      whatRead: opts.whatRead,
      whatProduced: opts.whatProduced,
      breachNote: opts.breachNote,
    }),
    "",
  ].join("\n");
  writeGuarded(houseRoot, abs, body, lists);
  return { absPath: abs, relPath: rel };
}

// ── Proposal contract (protocol §3) ─────────────────────────────────────────

export interface ParsedProposal {
  title: string;
  target: string;
  rationale: string;
  section?: string;
  action?: string;
  currentText?: string;
  proposedText?: string;
}

export function slugifyProposalTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "proposal";
}

function extractField(block: string, name: string): string {
  const re = new RegExp(`\\*\\*${name}\\*\\*:\\s*(.+?)\\s*$`, "im");
  const m = block.match(re);
  if (m) return m[1]!.replace(/^`|`$/g, "").trim();
  const re2 = new RegExp(`-\\s*\\*\\*${name}\\*\\*:\\s*(.+?)\\s*$`, "im");
  const m2 = block.match(re2);
  return m2 ? m2[1]!.replace(/^`|`$/g, "").trim() : "";
}

function extractMultilineField(block: string, name: string): string {
  const re = new RegExp(
    `\\*\\*${name}\\*\\*:\\s*\\n?\`\`\`[\\s\\S]*?\\n([\\s\\S]*?)\\n\`\`\``,
    "i",
  );
  const m = block.match(re);
  return m ? m[1]!.trim() : "";
}

/**
 * Parse ### Proposal: blocks from agent text (report-and-propose shape).
 */
export function parseProposals(output: string): ParsedProposal[] {
  const proposals: ParsedProposal[] = [];
  const blocks = output.split(/^### Proposal:/m).slice(1);
  for (const block of blocks) {
    const title = block.split("\n")[0]?.trim() || "untitled";
    const target = extractField(block, "Target");
    if (!target) continue;
    const rationale =
      extractField(block, "Rationale") || "No rationale provided";
    proposals.push({
      title,
      target: target.replace(/\\/g, "/"),
      rationale,
      section: extractField(block, "Section") || undefined,
      action: extractField(block, "Action") || undefined,
      currentText: extractMultilineField(block, "Current text") || undefined,
      proposedText: extractMultilineField(block, "Proposed text") || undefined,
    });
  }
  return proposals;
}

export function buildProposalFrontmatter(opts: {
  title: string;
  target: string;
  created?: string;
}): string {
  const created = opts.created ?? localDate();
  const title = JSON.stringify(opts.title);
  return [
    "---",
    "type: proposal",
    "status: pending",
    `created: '${created}'`,
    "triggered-by: dream",
    `title: ${title}`,
    `target: ${opts.target}`,
    "---",
  ].join("\n");
}

export function writeProposalFile(
  houseRoot: string,
  proposal: ParsedProposal,
  lists: GovernanceLists = defaultLists(),
): { path: string; skipped?: boolean } | null {
  const proposalsDir = join(houseRoot, "forge", "proposals");
  const slug = slugifyProposalTitle(proposal.title);
  const rel = `forge/proposals/${slug}.md`;
  const abs = join(houseRoot, rel);

  const candidates = [
    abs,
    join(proposalsDir, "applied", `${slug}.md`),
    join(proposalsDir, "closed", `${slug}.md`),
  ];
  if (candidates.some((p) => existsSync(p))) {
    return { path: rel, skipped: true };
  }

  const lines = [
    buildProposalFrontmatter({
      title: proposal.title,
      target: proposal.target,
    }),
    "",
    `# ${proposal.title}`,
    "",
    `**Target**: \`${proposal.target}\``,
    ...(proposal.action ? [`**Action**: ${proposal.action}`] : []),
    ...(proposal.section ? [`**Section**: ${proposal.section}`] : []),
    "",
    "## Proposed change",
    "",
    proposal.rationale,
    "",
  ];
  if (proposal.currentText) {
    lines.push("## Current text", "", "```", proposal.currentText, "```", "");
  }
  if (proposal.proposedText) {
    lines.push("## Proposed text", "", "```", proposal.proposedText, "```", "");
  }
  lines.push(
    "## Status",
    "",
    "status: pending. Proposals are never auto-applied by lucerna.",
    "A resident agent applies or closes by flipping status to applied or closed.",
    "",
  );

  writeGuarded(houseRoot, abs, lines.join("\n"), lists);
  return { path: rel };
}

export function materializeProposals(
  houseRoot: string,
  output: string,
  lists: GovernanceLists = defaultLists(),
): { written: string[]; skipped: number } {
  const written: string[] = [];
  let skipped = 0;
  for (const p of parseProposals(output)) {
    const r = writeProposalFile(houseRoot, p, lists);
    if (!r) continue;
    if (r.skipped) skipped++;
    else written.push(r.path);
  }
  return { written, skipped };
}

// ── Governance after-check ──────────────────────────────────────────────────

export type FileInventory = Map<string, number>; // rel path -> mtimeMs

/**
 * Inventory files under protected patterns + writable roots for before/after.
 * Rel paths use forward slashes from house root.
 */
export function inventoryHousePaths(
  houseRoot: string,
  roots?: string[],
): FileInventory {
  const inv: FileInventory = new Map();
  const scanRoots =
    roots ??
    [
      ...PROTECTED_PATTERNS.map((p) => p.replace(/\/$/, "")),
      "forge",
      "inbox",
      "AGENTS.md",
      "CLAUDE.md",
    ];
  const seen = new Set<string>();

  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const childAbs = join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(childAbs, childRel, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = statSync(childAbs);
          inv.set(childRel.replace(/\\/g, "/"), st.mtimeMs);
        } catch {
          /* skip */
        }
      }
    }
  };

  for (const r of scanRoots) {
    const key = r.replace(/\\/g, "/");
    if (seen.has(key)) continue;
    seen.add(key);
    const abs = join(houseRoot, key);
    if (!existsSync(abs)) continue;
    try {
      const st = statSync(abs);
      if (st.isFile()) {
        inv.set(key, st.mtimeMs);
      } else if (st.isDirectory()) {
        walk(abs, key, 0);
      }
    } catch {
      /* skip */
    }
  }
  return inv;
}

export function diffInventories(
  before: FileInventory,
  after: FileInventory,
): { added: string[]; modified: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  for (const [rel, mtime] of after) {
    if (!before.has(rel)) added.push(rel);
    else if (before.get(rel) !== mtime) modified.push(rel);
  }
  return { added, modified };
}

/**
 * git status --porcelain -uall when house is a git repo; empty array otherwise.
 */
export function gitPorcelainAll(houseRoot: string): string[] {
  try {
    const r = spawnSync("git", ["status", "--porcelain", "-uall"], {
      cwd: houseRoot,
      encoding: "utf-8",
      windowsHide: true,
      timeout: 15_000,
    });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Parse path from a porcelain line (handles renames loosely). */
export function porcelainPath(line: string): string | null {
  // XY PATH or XY ORIG -> PATH
  if (line.length < 4) return null;
  const rest = line.slice(3).trim();
  if (!rest) return null;
  if (rest.includes(" -> ")) {
    return rest.split(" -> ").pop()!.replace(/\\/g, "/");
  }
  return rest.replace(/^"|"$/g, "").replace(/\\/g, "/");
}

/**
 * True when a relative path is outside the allowed dream write surface.
 * Allowed: forge/, inbox/captures/, instruments/lucerna runtime residual.
 */
export function isOutOfBoundsWrite(
  houseRoot: string,
  relPath: string,
  lists: GovernanceLists = defaultLists(),
): boolean {
  const abs = resolve(houseRoot, relPath);
  if (canWrite(houseRoot, abs, lists)) return false;
  // Explicit: any protected hit is out of bounds
  if (isProtectedPath(houseRoot, abs, lists)) return true;
  if (isLucernaRuntimePath(houseRoot, abs)) return false;
  return true;
}

export interface GovernanceBreach {
  path: string;
  kind: "added" | "modified" | "porcelain";
}

/**
 * After-check: flag any writes outside WRITABLE + lucerna runtime.
 */
export function checkGovernanceBreaches(
  houseRoot: string,
  before: FileInventory,
  after: FileInventory,
  lists: GovernanceLists = defaultLists(),
  porcelainLines?: string[],
): GovernanceBreach[] {
  const breaches: GovernanceBreach[] = [];
  const { added, modified } = diffInventories(before, after);
  for (const p of added) {
    if (isOutOfBoundsWrite(houseRoot, p, lists)) {
      breaches.push({ path: p, kind: "added" });
    }
  }
  for (const p of modified) {
    // forge/ and runtime may legitimately change; only flag out-of-bounds
    if (isOutOfBoundsWrite(houseRoot, p, lists)) {
      breaches.push({ path: p, kind: "modified" });
    }
  }
  if (porcelainLines) {
    for (const line of porcelainLines) {
      const p = porcelainPath(line);
      if (!p) continue;
      if (isOutOfBoundsWrite(houseRoot, p, lists)) {
        if (!breaches.some((b) => b.path === p)) {
          breaches.push({ path: p, kind: "porcelain" });
        }
      }
    }
  }
  return breaches;
}

// ── Agentic prompts + runner ────────────────────────────────────────────────

export function buildAgenticSystemPrompt(opts: {
  actionKey: FullAgenticKey;
  houseRoot: string;
  dreamRelPath: string;
}): string {
  const focus =
    opts.actionKey === "self-orient"
      ? `Read the house orientation surfaces (AGENTS.md, context/current-state.md, context/principle-lattice.md when present) and open state (tasks, inbox). Produce a grounded orientation report with concrete observations and paths. Prefer report-and-propose: never edit protected files. When a durable change is warranted, emit ### Proposal: blocks (Target, Rationale; optional Section, Action, Current text, Proposed text).`
      : `Bounded tidy-work survey: look for stale references, unresolved items, and drift between docs and reality. REPORT-AND-PROPOSE only. Never edit outside the writable surface (forge/, inbox/captures/, lucerna runtime). Emit ### Proposal: blocks for any durable change you cannot make yourself.`;

  return `You are Lucerna's dream agent running a bounded agentic maintenance loop.

House root: ${opts.houseRoot}
Action: ${opts.actionKey}

## Writable surface (hard boundary)
You may write under:
- forge/ (dream reports, sessions manifests, proposals)
- inbox/captures/
- instruments/lucerna/ runtime files only (not package source)

You MUST NOT write: AGENTS.md, CLAUDE.md, context/, knowledge/, tasks/, reminders/,
tags/, graph/, projects/, archive/, scripts/, .amore/, .grok/, .claude/, or any
instruments/ package source.

## Report file
Write a complete report to:

  ${opts.dreamRelPath}

Start with YAML frontmatter:

---
type: forge
status: pending
dream-action: ${opts.actionKey}
created: '${localDate()}'
triggered-by: dream
---

Then a full report with real paths under Evidence. Prefer exhibit over vibe.

## Proposals
When a change is warranted that you may not apply, emit blocks:

### Proposal: <short title>
- **Target**: <house-relative path>
- **Rationale**: <one paragraph with evidence>
Optional: **Section**, **Action**, **Current text** / **Proposed text** fenced blocks.

Proposals are doc-only; lucerna never auto-applies them.

## Action focus
${focus}

## Finish
When the report is complete, print one line:
LUCERNA_DREAM_COMPLETE path=${opts.dreamRelPath} proposals=<count>

Web tools are disabled for this maintenance dream. Stay inside the house tree.`;
}

export function buildAgenticUserPrompt(opts: {
  actionKey: string;
  reason: string;
  dreamRelPath: string;
}): string {
  return [
    `Action: ${opts.actionKey}`,
    `Reason: ${opts.reason}`,
    `Time: ${localTimestamp()}`,
    `Dream report path: ${opts.dreamRelPath}`,
    "",
    "Survey the house with tools, write the complete dream report, emit ### Proposal: blocks if warranted.",
  ].join("\n");
}

export function parseDreamComplete(
  text: string,
): { path: string; proposals: number } | null {
  const m = text.match(/LUCERNA_DREAM_COMPLETE\s+path=(\S+)\s+proposals=(\d+)/);
  if (!m) return null;
  return { path: m[1]!, proposals: parseInt(m[2]!, 10) };
}

export type AgenticHeadlessCaller = (
  opts: CallAmoreHeadlessOptions,
) => Promise<AmoreHeadlessResult>;

export interface AgenticActionResult {
  ok: boolean;
  detail: string;
  artifactPath?: string;
  manifestPath?: string;
  proposalPaths?: string[];
  breaches?: GovernanceBreach[];
  usageTokens?: number;
}

export interface RunAgenticActionOptions {
  config: LucernaConfig;
  actionKey: FullAgenticKey;
  reason: string;
  lists?: GovernanceLists;
  headless?: AgenticHeadlessCaller;
  /** Override wall timeout (tests). */
  wallMs?: number;
  /** Skip real after-check inventory (rare). */
  skipGovernanceCheck?: boolean;
}

/**
 * Run one full agentic dream: snapshot → spawn → materialize → after-check → manifest.
 */
export async function runAgenticAction(
  opts: RunAgenticActionOptions,
): Promise<AgenticActionResult> {
  const { config, actionKey, reason } = opts;
  const lists = opts.lists ?? defaultLists();
  const headless = opts.headless ?? callAmoreHeadless;
  const stamp = dreamManifestStamp();
  const fileTs = localFileTimestamp();
  const dreamRel = `forge/dreams/${fileTs}-${actionKey}.md`;
  const dreamAbs = join(config.houseRoot, dreamRel);

  mkdirSync(dirname(dreamAbs), { recursive: true });
  mkdirSync(join(config.houseRoot, "forge", "dreams", "sessions"), {
    recursive: true,
  });
  mkdirSync(join(config.houseRoot, "forge", "proposals"), { recursive: true });

  const before = opts.skipGovernanceCheck
    ? new Map<string, number>()
    : inventoryHousePaths(config.houseRoot);
  const porcelainBefore = opts.skipGovernanceCheck
    ? []
    : gitPorcelainAll(config.houseRoot);

  const system = buildAgenticSystemPrompt({
    actionKey,
    houseRoot: config.houseRoot,
    dreamRelPath: dreamRel,
  });
  const user = buildAgenticUserPrompt({
    actionKey,
    reason,
    dreamRelPath: dreamRel,
  });

  let result: AmoreHeadlessResult;
  try {
    result = await headless({
      cwd: config.houseRoot,
      prompt: { system, user },
      mode: "json",
      maxTurns: agenticMaxTurns(actionKey),
      alwaysApprove: true,
      noSubagents: true,
      wallMs: agenticWallMs(actionKey, opts.wallMs),
      disallowedTools: MAINTENANCE_DISALLOWED_TOOLS,
      model: config.dreamModel?.trim() || undefined,
      amoreBin: config.amoreBin,
    });
  } catch (err) {
    const detail = `agentic spawn failed: ${err instanceof Error ? err.message : String(err)}`;
    const man = writeDreamManifest(config.houseRoot, {
      actionKey,
      goal: `${actionKey}: failed`,
      reason,
      whatRan: detail,
      whatRead: [],
      whatProduced: [],
      stamp,
      lists,
    });
    return {
      ok: false,
      detail,
      manifestPath: man.absPath,
    };
  }

  const usageTokens =
    typeof result.usage?.total_tokens === "number"
      ? result.usage.total_tokens
      : undefined;

  // Fallback report if agent did not write the dream file
  if (!existsSync(dreamAbs)) {
    const fallback = [
      "---",
      "type: forge",
      "status: pending",
      `dream-action: ${actionKey}`,
      `created: '${localDate()}'`,
      "triggered-by: dream",
      "---",
      "",
      `# ${actionKey}`,
      "",
      `> Fallback wrap: agent did not write the dream file. Reason: ${reason}`,
      "",
      result.text?.trim() || "(empty agent output)",
      "",
      `Generated at ${localTimestamp()} by lucerna agentic dream.`,
      "",
    ].join("\n");
    writeGuarded(config.houseRoot, dreamAbs, fallback, lists);
  }

  const agentText = (() => {
    try {
      return readFileSync(dreamAbs, "utf-8") + "\n" + (result.text ?? "");
    } catch {
      return result.text ?? "";
    }
  })();

  const mat = materializeProposals(config.houseRoot, agentText, lists);
  const produced = [dreamRel, ...mat.written];

  // After-check
  let breaches: GovernanceBreach[] = [];
  if (!opts.skipGovernanceCheck) {
    const after = inventoryHousePaths(config.houseRoot);
    const porcelainAfter = gitPorcelainAll(config.houseRoot);
    // Only consider porcelain lines that appeared after start
    const newPorcelain = porcelainAfter.filter(
      (l) => !porcelainBefore.includes(l),
    );
    breaches = checkGovernanceBreaches(
      config.houseRoot,
      before,
      after,
      lists,
      newPorcelain,
    );
  }

  let breachNote: string | undefined;
  if (breaches.length > 0) {
    breachNote = breaches
      .map((b) => `${b.kind}: \`${b.path}\``)
      .join("; ");
  }

  const man = writeDreamManifest(config.houseRoot, {
    actionKey,
    goal: `${actionKey}: ${reason.slice(0, 120)}`,
    reason,
    whatRan: `Agentic amore loop (maxTurns=${agenticMaxTurns(actionKey)}, web tools disallowed). Exit code ${result.code}.`,
    whatRead: extractEvidencePaths(agentText),
    whatProduced: [...produced, dreamManifestRelPath(actionKey, stamp)],
    stamp,
    reviewStatus: "pending",
    breachNote,
    lists,
  });
  produced.push(man.relPath);

  // If breaches, rewrite manifest is already pending with breach section.
  // Do not auto-revert.

  return {
    ok: result.code === 0 || result.code === null ? breaches.length === 0 : false,
    detail:
      breaches.length > 0
        ? `governance breach: ${breachNote}`
        : `agentic ${actionKey} complete; proposals=${mat.written.length}`,
    artifactPath: dreamAbs,
    manifestPath: man.absPath,
    proposalPaths: mat.written,
    breaches: breaches.length ? breaches : undefined,
    usageTokens,
  };
}

/** Pull backtick paths and Evidence-looking lines for manifest body. */
export function extractEvidencePaths(text: string): string[] {
  const out = new Set<string>();
  const re = /`([a-zA-Z0-9_./-]+\.(?:md|json|toml|ts|jsonl))`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1]!.replace(/\\/g, "/");
    if (p.includes("/")) out.add(p);
  }
  return [...out].slice(0, 40);
}
