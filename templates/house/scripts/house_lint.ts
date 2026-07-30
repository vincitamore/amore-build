#!/usr/bin/env bun
/**
 * house_lint — validate a house markdown corpus against AGENTS.md schemas.
 *
 * Scope: tasks/, inbox/, knowledge/, reminders/ (recursive, *.md). Every rule is
 * objective — wrong-from-evidence alone, never a judgment about operator intent.
 * Editorial/style rules are deliberately absent.
 *
 * Usage:
 *   bun scripts/house_lint.ts [--json] [--root <dir>]
 *
 * Exit 0 clean / exit 1 with findings / exit 64 foreign root (no AGENTS.md + tasks/).
 * Skips (absent optional sources) are notes, never findings.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Pinned catalogs. Correctness derives from their smallness: each is a closed
// enumeration of an AGENTS.md schema claim, pinned by exact-equality tests in
// house_lint.test.ts. Add or remove an entry ONLY when AGENTS.md (or the
// reminders README taxonomy) admits a new objective schema statement.
// ---------------------------------------------------------------------------

export const RULE_IDS = [
  "frontmatter-missing",
  "frontmatter-parse",
  "type-folder-mismatch",
  "schema-key-missing",
  "value-domain",
  "value-format",
  "file-location",
  "lifecycle-fields",
  "wikilink-missing",
  "wikilink-broken",
  "lattice-drift",
  "orientation-rules-drift",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Top-level scope dir -> expected frontmatter `type` (README.md is `index`). */
export const FOLDER_TYPES: Record<string, string> = {
  tasks: "task",
  inbox: "inbox",
  knowledge: "knowledge",
  reminders: "reminder",
};

/**
 * Folder (posix, repo-relative) -> exact status domain.
 * Authority: AGENTS.md § Tasks/Inbox + reminders/README.md taxonomy.
 * pending/snoozed/ongoing live at reminders/ root; completed/dismissed in
 * reminders/completed/.
 */
export const STATUS_DOMAINS: Record<string, readonly string[]> = {
  tasks: ["active", "blocked"],
  "tasks/review": ["review"],
  "tasks/backlog": ["backlog"],
  "tasks/incubating": ["incubating"],
  "tasks/paused": ["paused"],
  "tasks/completed": ["complete"],
  "inbox/captures": ["open", "resolved", "dropped", "superseded"],
  "inbox/captures/resolved": ["resolved", "dropped", "superseded"],
  "inbox/decisions": ["open"],
  "inbox/decisions/resolved": ["resolved", "dropped", "superseded"],
  "inbox/investigations": ["open"],
  "inbox/investigations/resolved": ["resolved", "dropped", "superseded"],
  "inbox/ideas": ["open"],
  "inbox/ideas/resolved": ["resolved", "dropped", "superseded"],
  knowledge: [],
  reminders: ["pending", "snoozed", "ongoing"],
  "reminders/completed": ["completed", "dismissed"],
};

/** Folders where the `status` key may be absent (captures carry no lifecycle).
 * A present status is still validated against the domain. */
export const STATUS_OPTIONAL_FOLDERS: Record<string, true> = {
  "inbox/captures": true,
  "inbox/captures/resolved": true,
};

/** Required frontmatter keys per `type` (README.md index files included).
 * Nullable fields need only be present; value rules check them when set. */
export const REQUIRED_KEYS: Record<string, readonly string[]> = {
  task: ["type", "status", "created", "completed", "tags"],
  inbox: ["type", "created", "source"],
  knowledge: ["type", "created", "updated", "tags"],
  reminder: ["type", "status", "created", "remind-at", "tags"],
  index: ["type", "created"],
};

/** Enumerated scalar domains checked whenever the key is present. */
export const VALUE_DOMAINS: Record<string, readonly string[]> = {
  source: ["capture", "operator", "session"],
  repeat: ["daily", "weekly", "monthly", "custom"],
};

// ---------------------------------------------------------------------------
// House-root guard — markers AGENTS.md + tasks/. Refuse foreign roots so the
// tool never scaffolds findings into an unrelated tree (exit 64 by contract).
// ---------------------------------------------------------------------------

export const EXIT_FOREIGN_ROOT = 64;

/** True when dir looks like a house root (orientation file + tasks corpus). */
export function isHouseRoot(dir: string): boolean {
  return existsSync(join(dir, "AGENTS.md")) && existsSync(join(dir, "tasks"));
}

/**
 * Resolve a house root from a candidate path.
 * - If candidate itself is a house root, use it.
 * - Else walk parents looking for AGENTS.md + tasks/.
 * - Returns null when no house root is found (caller refuses).
 */
export function resolveHouseRoot(candidate: string): string | null {
  const start = resolve(candidate);
  const chain = [start, ...parentsOf(start)];
  for (const dir of chain) {
    if (isHouseRoot(dir)) return dir;
  }
  return null;
}

function parentsOf(dir: string): string[] {
  const out: string[] = [];
  let cur = dir;
  for (;;) {
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frontmatter parser — deliberate YAML subset: `key: value`, null/~,
// single/double-quoted scalars, inline [a, b] lists, `- item` block lists,
// trailing # comments outside quotes. Anything richer is a parse error: the
// corpus uses no richer constructs, and silence would hide schema drift.
// ---------------------------------------------------------------------------

export class FrontmatterParseError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(message);
  }
}

function parseScalar(raw: string, line: number): unknown {
  const v = raw.trim();
  if (v === "" || v === "null" || v === "~") return null;
  if (v.startsWith('"')) {
    if (v.length < 2 || !v.endsWith('"'))
      throw new FrontmatterParseError(`unterminated quoted scalar: ${v}`, line);
    return v.slice(1, -1);
  }
  if (v.startsWith("'")) {
    if (v.length < 2 || !v.endsWith("'"))
      throw new FrontmatterParseError(`unterminated quoted scalar: ${v}`, line);
    return v.slice(1, -1);
  }
  if (v.startsWith("[")) {
    if (!v.endsWith("]"))
      throw new FrontmatterParseError(`unterminated inline list: ${v}`, line);
    const inner = v.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseScalar(item, line));
  }
  if (v.startsWith("{") || v.startsWith("|") || v.startsWith(">"))
    throw new FrontmatterParseError(
      `unsupported YAML construct (nested map or multiline scalar): ${v}`,
      line,
    );
  return v; // unquoted scalar stays a string (dates, enums, paths)
}

/** Strip a trailing ` # comment` that starts outside any quote. */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

export function parseFrontmatter(
  text: string,
): { data: Record<string, unknown>; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---")
    throw new FrontmatterParseError("file does not open with ---", 1);
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1)
    throw new FrontmatterParseError("no closing --- for frontmatter", 1);

  const data: Record<string, unknown> = {};
  let pendingListKey: string | null = null;
  const blockListHeaders = new Set<string>();
  for (let i = 1; i < close; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (raw.trim() === "") continue;
    const listItem = raw.match(/^\s+-\s+(.*)$/);
    if (listItem) {
      if (pendingListKey === null)
        throw new FrontmatterParseError("block-list item with no parent key", lineNo);
      (data[pendingListKey] as unknown[]).push(parseScalar(stripComment(listItem[1]), lineNo));
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv)
      throw new FrontmatterParseError(`unparseable frontmatter line: ${raw.trim()}`, lineNo);
    const [, key, restRaw] = kv;
    const rest = stripComment(restRaw).trim();
    if (rest === "") {
      // Either an explicit null or the header of a block list; the post-pass
      // collapses headers that collected no items back to null.
      data[key] = [];
      blockListHeaders.add(key);
      pendingListKey = key;
    } else {
      data[key] = parseScalar(rest, lineNo);
      pendingListKey = null;
    }
  }
  for (const k of blockListHeaders)
    if ((data[k] as unknown[]).length === 0) data[k] = null;

  return { data, body: lines.slice(close + 1).join("\n") };
}

// ---------------------------------------------------------------------------
// Wikilink extraction — code-stripped so the tool never flags its own spec
// (fenced blocks and `inline code` are not prose). Line numbers are preserved
// by blanking code regions instead of deleting them.
// ---------------------------------------------------------------------------

export function stripCode(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      out.push("");
      fence = fence === null ? fenceMatch[1][0].repeat(3) : null;
      continue;
    }
    if (fence !== null) {
      out.push("");
      continue;
    }
    out.push(line.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length)));
  }
  return out;
}

export interface WikiLink {
  target: string;
  line: number;
}

export function extractWikilinks(text: string): WikiLink[] {
  const stripped = stripCode(text);
  const links: WikiLink[] = [];
  const re = /\[\[([^\[\]|]+)(?:\|[^\[\]]*)?\]\]/g;
  stripped.forEach((line, idx) => {
    for (const m of line.matchAll(re)) {
      let target = m[1].trim();
      const hash = target.indexOf("#");
      if (hash !== -1) target = target.slice(0, hash).trim();
      if (target !== "") links.push({ target, line: idx + 1 });
    }
  });
  return links;
}

/**
 * Component-wise case-EXACT existence check. Node's existsSync is only as exact
 * as the underlying filesystem (case-insensitive on Windows/macOS), so a link
 * that would 404 on a case-sensitive checkout can look resolvable here. Walking
 * each component through readdir gives the portable answer.
 */
export function existsCaseExact(absPath: string): boolean {
  const { root: vol } = parse(absPath);
  if (!vol) return false;
  let cur = vol;
  for (const part of absPath.slice(vol.length).split(/[\\/]+/).filter(Boolean)) {
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    cur = join(cur, part);
  }
  return true;
}

// ---------------------------------------------------------------------------
// The lint itself.
// ---------------------------------------------------------------------------

export interface Finding {
  file: string | null; // repo-relative posix path; null = tree-level rule
  rule: RuleId;
  message: string;
  line?: number;
}

export interface LintResult {
  ok: boolean;
  files: number;
  findings: Finding[];
  notes: string[];
}

const SCOPE_DIRS = ["tasks", "inbox", "knowledge", "reminders"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:?\d{2}|Z)?)?$/;

function listMarkdown(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

function checkDate(
  findings: Finding[],
  file: string,
  key: string,
  value: unknown,
  re: RegExp,
  shape: string,
) {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || !re.test(value))
    findings.push({
      file,
      rule: "value-format",
      message: `${key}: must be ${shape} or null, got ${JSON.stringify(value)}`,
    });
}

function checkFile(
  root: string,
  relFile: string,
  repoFiles: Set<string>,
  findings: Finding[],
): void {
  const text = readFileSync(join(root, relFile), "utf8");
  const dir = relFile.split("/").slice(0, -1).join("/"); // relFile is already posix
  const base = relFile.split("/").pop()!;
  const topDir = relFile.split("/")[0];

  // --- file location: the folder set is closed (AGENTS.md § Folder structure)
  const isReadme = base === "README.md";
  let expectedType: string;
  if (isReadme) {
    expectedType = "index";
  } else if (!(topDir in FOLDER_TYPES)) {
    findings.push({
      file: relFile,
      rule: "file-location",
      message: `markdown file outside lint scope dirs (${SCOPE_DIRS.join(", ")})`,
    });
    return;
  } else {
    expectedType = FOLDER_TYPES[topDir];
    if (topDir === "tasks" && !(dir in STATUS_DOMAINS)) {
      findings.push({
        file: relFile,
        rule: "file-location",
        message: `unknown tasks subfolder '${dir}' (expected root, review/, backlog/, incubating/, paused/, completed/)`,
      });
      return;
    }
    if (topDir === "inbox" && !(dir in STATUS_DOMAINS)) {
      findings.push({
        file: relFile,
        rule: "file-location",
        message: `unknown inbox folder '${dir}' — files live in captures|decisions|investigations|ideas, optionally under resolved/`,
      });
      return;
    }
    if (topDir === "reminders" && !(dir in STATUS_DOMAINS)) {
      findings.push({
        file: relFile,
        rule: "file-location",
        message: `unknown reminders folder '${dir}' (expected root or completed/)`,
      });
      return;
    }
    if (topDir === "knowledge" && dir !== "knowledge") {
      // knowledge subfolders are admitted at 3+ clustered articles — any real
      // subfolder is legitimate, no location finding.
    }
  }

  // --- frontmatter present + parseable
  let data: Record<string, unknown>;
  let bodyWithoutFm: string;
  try {
    const parsed = parseFrontmatter(text);
    data = parsed.data;
    bodyWithoutFm = parsed.body;
  } catch (e) {
    if (e instanceof FrontmatterParseError && e.message.includes("does not open with ---"))
      findings.push({ file: relFile, rule: "frontmatter-missing", message: "no frontmatter block" });
    else if (e instanceof FrontmatterParseError)
      findings.push({
        file: relFile,
        rule: "frontmatter-parse",
        message: e.message,
        line: e.line,
      });
    else throw e;
    return; // nothing further can be checked without frontmatter
  }

  // --- type matches folder
  if (data.type !== expectedType)
    findings.push({
      file: relFile,
      rule: "type-folder-mismatch",
      message: `type: ${JSON.stringify(data.type ?? null)} but ${isReadme ? "README.md" : dir + "/"} requires '${expectedType}'`,
    });

  // --- required keys present
  const required = REQUIRED_KEYS[expectedType] ?? [];
  for (const key of required)
    if (!(key in data))
      findings.push({
        file: relFile,
        rule: "schema-key-missing",
        message: `required key '${key}' absent for type '${expectedType}'`,
      });

  // --- status within folder domain
  if (!isReadme && dir in STATUS_DOMAINS) {
    const domain = STATUS_DOMAINS[dir];
    const optional = dir in STATUS_OPTIONAL_FOLDERS;
    if (data.status === undefined) {
      if (!optional && domain.length > 0)
        findings.push({
          file: relFile,
          rule: "schema-key-missing",
          message: `required key 'status' absent`,
        });
    } else if (domain.length > 0 && !domain.includes(String(data.status))) {
      findings.push({
        file: relFile,
        rule: "value-domain",
        message: `status: ${JSON.stringify(data.status)} outside ${dir}/ domain [${domain.join(", ")}]`,
      });
    }
  }

  // --- enumerated scalar domains
  for (const [key, domain] of Object.entries(VALUE_DOMAINS)) {
    const v = data[key];
    if (v === undefined || v === null) continue;
    if (!domain.includes(String(v)))
      findings.push({
        file: relFile,
        rule: "value-domain",
        message: `${key}: ${JSON.stringify(v)} outside domain [${domain.join(", ")}]`,
      });
  }

  // --- date / datetime formats
  for (const key of ["created", "updated", "completed", "resolved", "paused", "repeat-until"])
    checkDate(findings, relFile, key, data[key], DATE_RE, "YYYY-MM-DD");
  for (const key of ["remind-at", "snoozed-until"])
    checkDate(findings, relFile, key, data[key], DATETIME_RE, "ISO date or datetime");

  // --- lifecycle fields (conditional, per AGENTS.md schema comments)
  const lifecycle = (cond: boolean, message: string) => {
    if (cond)
      findings.push({ file: relFile, rule: "lifecycle-fields", message });
  };
  if (data.status === "complete")
    lifecycle(
      typeof data.completed !== "string" || !DATE_RE.test(data.completed),
      "status 'complete' requires a completed: date",
    );
  if (data.status === "blocked")
    lifecycle(
      !Array.isArray(data["blocked-by"]) || data["blocked-by"].length === 0,
      "status 'blocked' requires blocked-by naming who/what is blocking",
    );
  if (data.status === "paused") {
    lifecycle(
      typeof data.paused !== "string" || !DATE_RE.test(data.paused),
      "status 'paused' requires a paused: date",
    );
    lifecycle(
      typeof data["trigger-to-unpause"] !== "string" || data["trigger-to-unpause"] === "",
      "status 'paused' requires a trigger-to-unpause",
    );
  }
  if (["resolved", "dropped", "superseded"].includes(String(data.status))) {
    lifecycle(
      typeof data.resolved !== "string" || !DATE_RE.test(data.resolved),
      `status '${data.status}' requires a resolved: date (the day the resolving work shipped)`,
    );
    lifecycle(
      typeof data.resolution !== "string" || data.resolution.trim() === "",
      `status '${data.status}' requires a resolution line + wikilink`,
    );
  }
  if (data.status === "snoozed")
    lifecycle(
      data["snoozed-until"] === null || data["snoozed-until"] === undefined,
      "status 'snoozed' requires snoozed-until",
    );
  if (["completed", "dismissed"].includes(String(data.status)) && expectedType === "reminder")
    lifecycle(
      typeof data.completed !== "string" || !DATE_RE.test(String(data.completed)),
      `reminder status '${data.status}' requires a completed: date`,
    );

  // --- wikilinks: presence + resolution
  const links = extractWikilinks(bodyWithoutFm);
  if (links.length === 0)
    findings.push({
      file: relFile,
      rule: "wikilink-missing",
      message: "no [[wikilink]] in prose (code fences/inline code excluded)",
    });
  const seenTargets = new Set<string>();
  for (const link of links) {
    if (seenTargets.has(link.target)) continue;
    seenTargets.add(link.target);
    const rel = link.target.endsWith(".md") ? link.target : `${link.target}.md`;
    if (repoFiles.has(rel)) continue;
    if (rel.startsWith("../")) {
      // Cross-tree reference — can never be in the repo index, so validate
      // against the filesystem case-EXACTLY.
      if (existsCaseExact(join(root, rel))) continue;
      findings.push({
        file: relFile,
        rule: "wikilink-broken",
        message: `[[${link.target}]] → no such file (${rel}) (cross-tree, case-exact)`,
        line: link.line,
      });
      continue;
    }
    if (existsSync(join(root, rel))) {
      findings.push({
        file: relFile,
        rule: "wikilink-broken",
        message: `[[${link.target}]] resolves only case-insensitively — breaks on case-sensitive checkouts`,
        line: link.line,
      });
    } else {
      findings.push({
        file: relFile,
        rule: "wikilink-broken",
        message: `[[${link.target}]] → no such file (${rel})`,
        line: link.line,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Tree-level optional rules — skip cleanly (note, not finding) when their
// source is absent.
// ---------------------------------------------------------------------------

async function checkTree(root: string, findings: Finding[], notes: string[]): Promise<void> {
  // lattice-drift: optional external canonical via LATTICE_CANONICAL env.
  // Single-house adopters keep the lattice at context/principle-lattice.md as
  // the authority — no sibling-tree coupling by default.
  const canonicalEnv = process.env.LATTICE_CANONICAL;
  const local = join(root, "context", "principle-lattice.md");
  if (!canonicalEnv) {
    notes.push(
      "lattice-drift: skipped (no LATTICE_CANONICAL set; local context/principle-lattice.md is authority)",
    );
  } else {
    const canonical = resolve(canonicalEnv);
    if (!existsSync(canonical)) {
      notes.push(`lattice-drift: skipped (LATTICE_CANONICAL not found: ${canonical})`);
    } else if (!existsSync(local)) {
      findings.push({
        file: "context/principle-lattice.md",
        rule: "lattice-drift",
        message: `local lattice copy missing while LATTICE_CANONICAL exists at ${canonical}`,
      });
    } else {
      const a = readFileSync(canonical);
      const b = readFileSync(local);
      if (!a.equals(b))
        findings.push({
          file: "context/principle-lattice.md",
          rule: "lattice-drift",
          message: `local copy differs from LATTICE_CANONICAL (${canonical}) — sync it`,
        });
    }
  }

  // orientation-rules-drift: rules dir is derived state regenerated by
  // scripts/sync_orientation_rules.py; --check exits 1 on drift.
  // Prefer .selene/ (Selene Build default); fall back to .grok/ (upstream-grok).
  const hasSelene = existsSync(join(root, ".selene"));
  const hasGrok = existsSync(join(root, ".grok"));
  if (!hasSelene && !hasGrok) {
    notes.push("orientation-rules-drift: skipped (.selene/ and .grok/ absent)");
  } else {
    const scriptCandidates = [
      join(root, "scripts", "sync_orientation_rules.py"),
      join(import.meta.dir, "sync_orientation_rules.py"),
    ];
    const script = scriptCandidates.find((p) => existsSync(p));
    if (!script) {
      notes.push("orientation-rules-drift: skipped (sync_orientation_rules.py not found)");
    } else {
      const extraArgs = hasSelene ? [] : ["--grok-compat"];
      try {
        const proc = Bun.spawn(
          ["python", script, "--check", ...extraArgs],
          {
            cwd: root,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, ORG_ROOT: root },
          },
        );
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
          const outText = (await new Response(proc.stdout).text()).trim();
          const errText = (await new Response(proc.stderr).text()).trim();
          const tail = (outText || errText).split("\n").slice(-3).join(" | ");
          findings.push({
            file: null,
            rule: "orientation-rules-drift",
            message: `sync_orientation_rules.py --check exited ${exitCode}: ${tail}`,
          });
        }
      } catch {
        notes.push("orientation-rules-drift: skipped (python not available)");
      }
    }
  }
}

export async function lint(root: string): Promise<LintResult> {
  const findings: Finding[] = [];
  const notes: string[] = [];
  const repoFiles = new Set(listMarkdown(root));
  const scopeFiles = [...repoFiles].filter((f) => SCOPE_DIRS.includes(f.split("/")[0]));
  for (const file of scopeFiles) checkFile(root, file, repoFiles, findings);
  await checkTree(root, findings, notes);
  findings.sort((a, b) =>
    (a.file ?? "").localeCompare(b.file ?? "") ||
    a.rule.localeCompare(b.rule) ||
    a.message.localeCompare(b.message),
  );
  return { ok: findings.length === 0, files: scopeFiles.length, findings, notes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function formatHuman(result: LintResult): string {
  const lines: string[] = [];
  for (const f of result.findings)
    lines.push(`${f.file ?? "(tree)"}${f.line ? `:${f.line}` : ""} [${f.rule}] ${f.message}`);
  for (const n of result.notes) lines.push(`note: ${n}`);
  lines.push(
    result.ok
      ? `house-lint: ${result.files} files checked, 0 findings`
      : `house-lint: ${result.files} files checked, ${result.findings.length} finding(s)`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const rootFlag = args.indexOf("--root");
  const candidate =
    rootFlag !== -1 ? args[rootFlag + 1] : join(import.meta.dir, "..");
  const root = resolveHouseRoot(candidate);
  if (root === null) {
    console.error(
      `house-lint: refuse foreign root — no AGENTS.md + tasks/ found from ${resolve(candidate)}`,
    );
    process.exit(EXIT_FOREIGN_ROOT);
  }
  // When --root is explicit, require the candidate itself to be the house root
  // (do not silently walk up — that would mask a mis-aimed invocation).
  if (rootFlag !== -1 && resolve(candidate) !== root) {
    console.error(
      `house-lint: refuse foreign root — ${resolve(candidate)} is not a house root ` +
        `(nearest house root would be ${root}; pass that path explicitly if intended)`,
    );
    process.exit(EXIT_FOREIGN_ROOT);
  }
  const result = await lint(root);
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatHuman(result));
  process.exit(result.ok ? 0 : 1);
}
