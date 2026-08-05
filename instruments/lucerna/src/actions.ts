/**
 * Action catalog and light / shell action implementations.
 * Agentic loops live in agentic.ts; edges shell to iris when present.
 * Writes go only through the shared write guard.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { localFileTimestamp, localTimestamp } from "./time.ts";
import type { BudgetTier } from "./budget.ts";
import { writeGuarded, type GovernanceLists, defaultLists } from "./governance.ts";
import { houseRuntimeDir, RUNTIME_FILES } from "./paths.ts";

export type ParityDecision = "admit" | "defer" | "refuse";
export type ActionClass = "light" | "agentic" | "recipe-map";

export interface ActionCatalogEntry {
  key: string;
  class: ActionClass;
  parity: ParityDecision;
  admitted: boolean;
  budgetTier: BudgetTier;
  cooldownClass: "light" | "recipe";
  description: string;
  note?: string;
}

export function budgetTierForClass(cls: ActionClass): BudgetTier {
  return cls === "light" ? "daily" : "weekly";
}

/**
 * Admitted action catalog (light + agentic). Exact set is anti-accretion pinned in tests.
 */
export const ACTION_CATALOG: readonly ActionCatalogEntry[] = [
  {
    key: "survey-org",
    class: "light",
    parity: "admit",
    admitted: true,
    budgetTier: "daily",
    cooldownClass: "light",
    description: "Count tasks, inbox, and reminders by status into a dated forge report",
  },
  {
    key: "substrate-health",
    class: "light",
    parity: "admit",
    admitted: true,
    budgetTier: "daily",
    cooldownClass: "light",
    description: "Broken wikilink and frontmatter-parse scan into a forge report",
  },
  {
    key: "inbox-age-report",
    class: "light",
    parity: "admit",
    admitted: true,
    budgetTier: "daily",
    cooldownClass: "light",
    description: "Scan inbox subfolders for items past triage age thresholds",
  },
  {
    key: "state-cleanup",
    class: "light",
    parity: "admit",
    admitted: true,
    budgetTier: "daily",
    cooldownClass: "light",
    description: "Prune lucerna aged runtime artifacts (rotated logs, tmp files)",
  },
  {
    key: "edges-update",
    class: "light",
    parity: "admit",
    admitted: true,
    budgetTier: "daily",
    cooldownClass: "light",
    description: "Shell iris edges update --tier 0 --json (structural re-derive, no model)",
  },
  {
    key: "qmd-refresh",
    class: "light",
    parity: "admit",
    admitted: true,
    budgetTier: "daily",
    cooldownClass: "light",
    description:
      "Shell iris qmd update --embed --json so the house search index stays current and clears any ingestion backlog",
  },
  {
    key: "self-orient",
    class: "agentic",
    parity: "admit",
    admitted: true,
    budgetTier: "weekly",
    cooldownClass: "recipe",
    description:
      "Agentic orientation report: read house surfaces, propose protected-file updates only",
  },
  {
    key: "agentic-housekeeping",
    class: "agentic",
    parity: "admit",
    admitted: true,
    budgetTier: "weekly",
    cooldownClass: "recipe",
    description:
      "Bounded agentic tidy survey: stale refs, unresolved items, doc drift (report-and-propose)",
  },
  {
    key: "edges-densify",
    class: "agentic",
    parity: "admit",
    admitted: true,
    budgetTier: "weekly",
    cooldownClass: "recipe",
    description: "Shell iris edges update --tier 2 --json under dreams budgets (model-judged densify)",
  },
] as const;

export const ADMITTED_ACTION_KEYS = ACTION_CATALOG.filter((e) => e.admitted).map((e) => e.key);

export const LIGHT_ACTION_KEYS = ACTION_CATALOG.filter(
  (e) => e.admitted && e.class === "light",
).map((e) => e.key);

export const AGENTIC_ACTION_KEYS = ACTION_CATALOG.filter(
  (e) => e.admitted && (e.class === "agentic" || e.class === "recipe-map"),
).map((e) => e.key);

export function catalogEntry(key: string): ActionCatalogEntry | undefined {
  return ACTION_CATALOG.find((e) => e.key === key);
}

export function isAdmittedAction(key: string): boolean {
  return catalogEntry(key)?.admitted === true;
}

export function isAgenticCatalogAction(key: string): boolean {
  const e = catalogEntry(key);
  return e?.admitted === true && (e.class === "agentic" || e.class === "recipe-map");
}

export function isLightCatalogAction(key: string): boolean {
  const e = catalogEntry(key);
  return e?.admitted === true && e.class === "light";
}

export function actionBudgetTier(key: string): BudgetTier {
  return catalogEntry(key)?.budgetTier ?? "daily";
}

export function actionCooldownClass(key: string): "light" | "recipe" {
  return catalogEntry(key)?.cooldownClass ?? "light";
}

export interface ActionResult {
  ok: boolean;
  artifactPath?: string;
  detail: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeReport(
  houseRoot: string,
  name: string,
  content: string,
  actionKey: string,
  lists: GovernanceLists = defaultLists(),
): ActionResult {
  const dreamsDir = join(houseRoot, "forge", "dreams");
  ensureDir(dreamsDir);
  const path = join(dreamsDir, name);
  const body = content.trimStart().startsWith("---")
    ? content
    : [
        "---",
        "type: forge",
        "status: pending",
        `dream-action: ${actionKey}`,
        `created: '${localTimestamp()}'`,
        "triggered-by: dream",
        "---",
        "",
        content,
      ].join("\n");
  writeGuarded(houseRoot, path, body, lists);
  return { ok: true, artifactPath: path, detail: `wrote ${path}` };
}

function walkMd(root: string, maxDepth = 4): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (["resolved", "completed", "archive", "node_modules"].includes(e.name)) continue;
        walk(p, depth + 1);
      } else if (e.name.endsWith(".md")) {
        out.push(p);
      }
    }
  };
  walk(root, 0);
  return out;
}

function countMd(root: string, maxDepth = 2): number {
  return walkMd(root, maxDepth).length;
}

/** Extract [[wikilink]] targets (first segment before |). */
export function extractWikilinks(text: string): string[] {
  const re = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]!.trim().replace(/\\/g, "/"));
  }
  return out;
}

/** Parse YAML frontmatter block; returns null if missing or unclosed. */
export function parseFrontmatter(
  text: string,
): { ok: true; raw: string } | { ok: false; error: string } {
  if (!text.startsWith("---")) return { ok: false, error: "no frontmatter fence" };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { ok: false, error: "unclosed frontmatter" };
  return { ok: true, raw: text.slice(3, end) };
}

export function surveyOrg(houseRoot: string): {
  inboxOpen: number;
  tasksActive: number;
  tasksCompleted: number;
  reminders: number;
  forgeReports: number;
} {
  const countSkip = (dir: string, skip: string[]): number => {
    const root = join(houseRoot, dir);
    if (!existsSync(root)) return 0;
    let n = 0;
    const walk = (d: string, depth: number) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) {
          if (skip.includes(e.name)) continue;
          walk(p, depth + 1);
        } else if (e.name.endsWith(".md")) {
          n++;
        }
      }
    };
    walk(root, 0);
    return n;
  };

  return {
    inboxOpen: countSkip("inbox", ["resolved"]),
    tasksActive: countSkip("tasks", ["completed", "archive"]),
    tasksCompleted: countMd(join(houseRoot, "tasks", "completed"), 2),
    reminders: countMd(join(houseRoot, "reminders"), 2),
    forgeReports: countMd(join(houseRoot, "forge"), 2),
  };
}

export function runSurveyOrg(
  houseRoot: string,
  lists: GovernanceLists = defaultLists(),
): ActionResult {
  const s = surveyOrg(houseRoot);
  const ts = localFileTimestamp();
  const lines = [
    `# Org survey ${ts}`,
    "",
    `- inbox (open): ${s.inboxOpen}`,
    `- tasks (active): ${s.tasksActive}`,
    `- tasks (completed): ${s.tasksCompleted}`,
    `- reminders: ${s.reminders}`,
    `- forge reports: ${s.forgeReports}`,
    "",
    `Generated at ${localTimestamp()} by lucerna light action.`,
  ];
  return writeReport(houseRoot, `${ts}-survey-org.md`, lines.join("\n"), "survey-org", lists);
}

/**
 * Substrate health: broken wikilink + frontmatter-parse scan.
 */
export function runSubstrateHealth(
  houseRoot: string,
  lists: GovernanceLists = defaultLists(),
): ActionResult {
  const roots = ["knowledge", "tasks", "context", "inbox", "reminders"];
  const files: string[] = [];
  for (const r of roots) {
    files.push(...walkMd(join(houseRoot, r), 5));
  }

  const basenames = new Map<string, string>();
  for (const f of files) {
    const rel = relative(houseRoot, f).replace(/\\/g, "/");
    const base = rel.replace(/\.md$/, "");
    basenames.set(base.toLowerCase(), rel);
    basenames.set(base.split("/").pop()!.toLowerCase(), rel);
  }

  const broken: Array<{ file: string; link: string }> = [];
  const fmErrors: Array<{ file: string; error: string }> = [];

  for (const f of files) {
    const rel = relative(houseRoot, f).replace(/\\/g, "/");
    let text = "";
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    if (text.startsWith("---")) {
      const fm = parseFrontmatter(text);
      if (!fm.ok) fmErrors.push({ file: rel, error: fm.error });
    }
    for (const link of extractWikilinks(text)) {
      const key = link.toLowerCase().replace(/\.md$/, "");
      if (!basenames.has(key)) {
        broken.push({ file: rel, link });
      }
    }
  }

  const ts = localFileTimestamp();
  const lines = [
    `# Substrate health ${ts}`,
    "",
    `Files scanned: ${files.length}`,
    `Broken wikilinks: ${broken.length}`,
    `Frontmatter parse errors: ${fmErrors.length}`,
    "",
    "## Broken wikilinks",
    "",
    ...(broken.length === 0
      ? ["None found.", ""]
      : [
          ...broken.slice(0, 40).map((b) => `- \`${b.file}\` → [[${b.link}]]`),
          broken.length > 40 ? `\n…and ${broken.length - 40} more` : "",
          "",
        ]),
    "## Frontmatter errors",
    "",
    ...(fmErrors.length === 0
      ? ["None found.", ""]
      : [
          ...fmErrors.slice(0, 40).map((e) => `- \`${e.file}\`: ${e.error}`),
          fmErrors.length > 40 ? `\n…and ${fmErrors.length - 40} more` : "",
          "",
        ]),
    `Generated at ${localTimestamp()} by lucerna light action.`,
  ];
  return writeReport(
    houseRoot,
    `${ts}-substrate-health.md`,
    lines.join("\n"),
    "substrate-health",
    lists,
  );
}

export function runInboxAgeReport(
  houseRoot: string,
  lists: GovernanceLists = defaultLists(),
): ActionResult {
  const inboxDir = join(houseRoot, "inbox");
  const ts = localFileTimestamp();
  if (!existsSync(inboxDir)) {
    return writeReport(
      houseRoot,
      `${ts}-inbox-age-report.md`,
      `# Inbox age report\n\nNo inbox/ directory.\n`,
      "inbox-age-report",
      lists,
    );
  }
  const thresholds: Record<string, number> = {
    captures: 2,
    emails: 3,
    tickets: 5,
    ideas: 14,
    decisions: 7,
    investigations: 7,
  };
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const aging: Array<{ subfolder: string; file: string; ageDays: number }> = [];
  let total = 0;
  for (const sub of readdirSync(inboxDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    if (sub.name === "resolved" || sub.name.startsWith(".")) continue;
    const subPath = join(inboxDir, sub.name);
    let files: string[] = [];
    try {
      files = readdirSync(subPath).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    total += files.length;
    const thr = thresholds[sub.name] ?? 7;
    for (const file of files) {
      try {
        const ageDays = Math.floor((now - statSync(join(subPath, file)).mtimeMs) / DAY);
        if (ageDays >= thr) aging.push({ subfolder: sub.name, file, ageDays });
      } catch {
        /* skip */
      }
    }
  }
  aging.sort((a, b) => b.ageDays - a.ageDays);
  const lines = [
    `# Inbox age report ${ts}`,
    "",
    `Total open inbox items: ${total}`,
    `Past threshold: ${aging.length}`,
    "",
  ];
  if (aging.length === 0) {
    lines.push("All items within thresholds.", "");
  } else {
    lines.push("| Subfolder | File | Age (days) |", "|-----------|------|------------|");
    for (const a of aging.slice(0, 40)) {
      lines.push(`| ${a.subfolder} | ${a.file.slice(0, 50)} | ${a.ageDays} |`);
    }
    lines.push("");
  }
  lines.push(`Generated at ${localTimestamp()} by lucerna light action.`);
  return writeReport(
    houseRoot,
    `${ts}-inbox-age-report.md`,
    lines.join("\n"),
    "inbox-age-report",
    lists,
  );
}

/**
 * Prune lucerna runtime artifacts: rotated logs, tmp files older than maxAgeMs.
 */
export function runStateCleanup(
  houseRoot: string,
  opts?: { maxAgeMs?: number; lists?: GovernanceLists },
): ActionResult {
  const lists = opts?.lists ?? defaultLists();
  const maxAgeMs = opts?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const runtimeDir = houseRuntimeDir(houseRoot);
  if (!existsSync(runtimeDir)) {
    return { ok: true, detail: "no runtime dir" };
  }

  const now = Date.now();
  let pruned = 0;
  const keep = new Set<string>(Object.values(RUNTIME_FILES));
  keep.add("state.json.tmp");
  keep.add("health.json.tmp");
  keep.add("notifications.jsonl.tmp");

  let entries;
  try {
    entries = readdirSync(runtimeDir);
  } catch {
    return { ok: true, detail: "runtime dir unreadable" };
  }

  for (const name of entries) {
    // Never delete core runtime files or enablement
    if (keep.has(name)) continue;
    if (name === RUNTIME_FILES.enable) continue;
    if (name === RUNTIME_FILES.governanceUser) continue;
    // Prune rotated logs (log.1, log.old), *.tmp, aged drafts
    const isRotated = /^log\.\d+$/.test(name) || name.endsWith(".old") || name.endsWith(".tmp");
    const isAgedArtifact =
      name.endsWith(".jsonl") ||
      name.startsWith("draft-") ||
      name.endsWith(".bak");
    if (!isRotated && !isAgedArtifact) continue;
    const fp = join(runtimeDir, name);
    try {
      const st = statSync(fp);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs < maxAgeMs && !name.endsWith(".tmp")) continue;
      // tmp files: prune immediately if older than 1h
      if (name.endsWith(".tmp") && now - st.mtimeMs < 60 * 60 * 1000) continue;
      unlinkSync(fp);
      pruned++;
    } catch {
      /* skip */
    }
  }

  const ts = localFileTimestamp();
  const report = [
    `# State cleanup ${ts}`,
    "",
    `- pruned: ${pruned}`,
    `- maxAgeDays: ${Math.round(maxAgeMs / DAY_MS)}`,
    "",
    `Generated at ${localTimestamp()} by lucerna light action.`,
  ].join("\n");
  return writeReport(houseRoot, `${ts}-state-cleanup.md`, report, "state-cleanup", lists);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Resolve iris binary: LUCERNA_IRIS_BIN, IRIS_BIN, else `iris` on PATH. */
export function resolveIrisBin(override?: string): string {
  return (
    override?.trim() ||
    process.env.LUCERNA_IRIS_BIN?.trim() ||
    process.env.IRIS_BIN?.trim() ||
    "iris"
  );
}

export interface IrisEdgesUpdateOptions {
  houseRoot: string;
  tier: 0 | 2;
  irisBin?: string;
  /** Inject for tests: replace spawnSync. */
  spawnSyncImpl?: typeof spawnSync;
  lists?: GovernanceLists;
  actionKey?: string;
}

/**
 * Shell exactly: iris edges update --tier <0|2> --json
 * Nonzero exit or missing iris is an action failure (never a crash).
 */
export function runIrisEdgesUpdate(opts: IrisEdgesUpdateOptions): ActionResult {
  const lists = opts.lists ?? defaultLists();
  const actionKey = opts.actionKey ?? (opts.tier === 0 ? "edges-update" : "edges-densify");
  const bin = resolveIrisBin(opts.irisBin);
  const argv = ["edges", "update", "--tier", String(opts.tier), "--json"];
  const spawnFn = opts.spawnSyncImpl ?? spawnSync;
  const spawnOpts: SpawnSyncOptions = {
    cwd: opts.houseRoot,
    encoding: "utf-8",
    windowsHide: true,
    timeout: 120_000,
  };

  let status: number | null = null;
  let stdout = "";
  let stderr = "";
  let spawnError: string | undefined;

  try {
    const r = spawnFn(bin, argv, spawnOpts);
    status = r.status;
    stdout = typeof r.stdout === "string" ? r.stdout : (r.stdout?.toString() ?? "");
    stderr = typeof r.stderr === "string" ? r.stderr : (r.stderr?.toString() ?? "");
    if (r.error) {
      spawnError = r.error.message;
    }
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
  }

  const ts = localFileTimestamp();
  const ok = spawnError === undefined && status === 0;
  const lines = [
    `# ${actionKey} ${ts}`,
    "",
    `Command: ${bin} ${argv.join(" ")}`,
    `Exit: ${status === null ? "null" : status}`,
    spawnError ? `Spawn error: ${spawnError}` : "",
    "",
    "## stdout",
    "",
    "```",
    stdout.trim().slice(0, 4000) || "(empty)",
    "```",
    "",
    "## stderr",
    "",
    "```",
    stderr.trim().slice(0, 2000) || "(empty)",
    "```",
    "",
    `Generated at ${localTimestamp()} by lucerna ${actionKey}.`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === ""));

  const report = writeReport(
    opts.houseRoot,
    `${ts}-${actionKey}.md`,
    lines.join("\n"),
    actionKey,
    lists,
  );

  if (!ok) {
    return {
      ok: false,
      artifactPath: report.artifactPath,
      detail: spawnError
        ? `iris unavailable or failed to spawn: ${spawnError}`
        : `iris edges update --tier ${opts.tier} exited ${status}`,
    };
  }
  return {
    ok: true,
    artifactPath: report.artifactPath,
    detail: `iris edges update --tier ${opts.tier} ok`,
  };
}

export function runEdgesUpdate(
  houseRoot: string,
  opts?: {
    lists?: GovernanceLists;
    irisBin?: string;
    spawnSyncImpl?: typeof spawnSync;
  },
): ActionResult {
  return runIrisEdgesUpdate({
    houseRoot,
    tier: 0,
    actionKey: "edges-update",
    lists: opts?.lists,
    irisBin: opts?.irisBin,
    spawnSyncImpl: opts?.spawnSyncImpl,
  });
}

export function runEdgesDensify(
  houseRoot: string,
  opts?: {
    lists?: GovernanceLists;
    irisBin?: string;
    spawnSyncImpl?: typeof spawnSync;
  },
): ActionResult {
  return runIrisEdgesUpdate({
    houseRoot,
    tier: 2,
    actionKey: "edges-densify",
    lists: opts?.lists,
    irisBin: opts?.irisBin,
    spawnSyncImpl: opts?.spawnSyncImpl,
  });
}

export interface IrisQmdRefreshOptions {
  houseRoot: string;
  irisBin?: string;
  /** Inject for tests: replace spawnSync. */
  spawnSyncImpl?: typeof spawnSync;
  lists?: GovernanceLists;
}

/**
 * Shell exactly: iris qmd update --embed --json
 * Missing binary, missing qmd runtime, or nonzero exit is an action failure
 * (never a crash). Resolves iris the same way as edges-update.
 */
export function runQmdRefresh(
  houseRoot: string,
  opts?: {
    lists?: GovernanceLists;
    irisBin?: string;
    spawnSyncImpl?: typeof spawnSync;
  },
): ActionResult {
  const lists = opts?.lists ?? defaultLists();
  const actionKey = "qmd-refresh";
  const bin = resolveIrisBin(opts?.irisBin);
  const argv = ["qmd", "update", "--embed", "--json"];
  const spawnFn = opts?.spawnSyncImpl ?? spawnSync;
  const spawnOpts: SpawnSyncOptions = {
    cwd: houseRoot,
    encoding: "utf-8",
    windowsHide: true,
    timeout: 300_000,
  };

  let status: number | null = null;
  let stdout = "";
  let stderr = "";
  let spawnError: string | undefined;

  try {
    const r = spawnFn(bin, argv, spawnOpts);
    status = r.status;
    stdout = typeof r.stdout === "string" ? r.stdout : (r.stdout?.toString() ?? "");
    stderr = typeof r.stderr === "string" ? r.stderr : (r.stderr?.toString() ?? "");
    if (r.error) {
      spawnError = r.error.message;
    }
  } catch (err) {
    spawnError = err instanceof Error ? err.message : String(err);
  }

  const ts = localFileTimestamp();
  const ok = spawnError === undefined && status === 0;
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  const missingRuntime =
    !ok &&
    (combined.includes("qmd") &&
      (combined.includes("not found") ||
        combined.includes("not installed") ||
        combined.includes("no such") ||
        combined.includes("missing") ||
        combined.includes("unavailable")));

  const lines = [
    `# ${actionKey} ${ts}`,
    "",
    `Command: ${bin} ${argv.join(" ")}`,
    `Exit: ${status === null ? "null" : status}`,
    spawnError ? `Spawn error: ${spawnError}` : "",
    missingRuntime ? "Note: qmd runtime appears missing or unavailable." : "",
    "",
    "## stdout",
    "",
    "```",
    stdout.trim().slice(0, 4000) || "(empty)",
    "```",
    "",
    "## stderr",
    "",
    "```",
    stderr.trim().slice(0, 2000) || "(empty)",
    "```",
    "",
    `Generated at ${localTimestamp()} by lucerna ${actionKey}.`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === ""));

  const report = writeReport(
    houseRoot,
    `${ts}-${actionKey}.md`,
    lines.join("\n"),
    actionKey,
    lists,
  );

  if (!ok) {
    let detail: string;
    if (spawnError) {
      detail = `iris unavailable or failed to spawn: ${spawnError}`;
    } else if (missingRuntime) {
      detail = `iris qmd runtime missing or unavailable (exit ${status})`;
    } else {
      detail = `iris qmd update --embed exited ${status}`;
    }
    return {
      ok: false,
      artifactPath: report.artifactPath,
      detail,
    };
  }
  return {
    ok: true,
    artifactPath: report.artifactPath,
    detail: "iris qmd update --embed ok",
  };
}

export function executeLightAction(
  key: string,
  houseRoot: string,
  lists: GovernanceLists = defaultLists(),
  shellOpts?: {
    irisBin?: string;
    spawnSyncImpl?: typeof spawnSync;
  },
): ActionResult | null {
  switch (key) {
    case "survey-org":
      return runSurveyOrg(houseRoot, lists);
    case "substrate-health":
      return runSubstrateHealth(houseRoot, lists);
    case "inbox-age-report":
      return runInboxAgeReport(houseRoot, lists);
    case "state-cleanup":
      return runStateCleanup(houseRoot, { lists });
    case "edges-update":
      return runEdgesUpdate(houseRoot, { lists, ...shellOpts });
    case "qmd-refresh":
      return runQmdRefresh(houseRoot, { lists, ...shellOpts });
    case "edges-densify":
      return runEdgesDensify(houseRoot, { lists, ...shellOpts });
    default:
      return null;
  }
}
