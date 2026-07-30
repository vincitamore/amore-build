/**
 * house_lint tests — exact-equality pins on every catalog whose correctness
 * derives from its smallness, plus parser/wikilink unit checks and a
 * fixture-driven end-to-end lint of a synthetic clean house.
 *
 * A red bar here means the tool's rule set or schema domains changed without
 * an AGENTS.md (or reminders README) schema revision. When a pin legitimately
 * changes, update the literal in the same commit as the catalog.
 *
 * Fixtures live under tests/fixtures/ — the live templates/house tree is NOT
 * asserted clean (sibling units may still be stubbing content this wave).
 */

import { test, expect } from "bun:test";
import { join, resolve } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  RULE_IDS,
  FOLDER_TYPES,
  STATUS_DOMAINS,
  STATUS_OPTIONAL_FOLDERS,
  REQUIRED_KEYS,
  VALUE_DOMAINS,
  parseFrontmatter,
  FrontmatterParseError,
  extractWikilinks,
  lint,
  isHouseRoot,
  resolveHouseRoot,
  EXIT_FOREIGN_ROOT,
} from "./house_lint";

const SCRIPTS_DIR = import.meta.dir;
const FIXTURES = join(SCRIPTS_DIR, "tests", "fixtures");
const CLEAN_HOUSE = join(FIXTURES, "clean-house");

// ---------------------------------------------------------------------------
// Catalog pins (6) — whole-set equality
// ---------------------------------------------------------------------------

test("RULE_IDS is exactly the admitted rule set", () => {
  expect([...RULE_IDS].sort()).toEqual([
    "file-location",
    "frontmatter-missing",
    "frontmatter-parse",
    "lattice-drift",
    "lifecycle-fields",
    "orientation-rules-drift",
    "schema-key-missing",
    "type-folder-mismatch",
    "value-domain",
    "value-format",
    "wikilink-broken",
    "wikilink-missing",
  ]);
});

test("FOLDER_TYPES is exactly the AGENTS.md folder->type map", () => {
  expect(FOLDER_TYPES).toEqual({
    tasks: "task",
    inbox: "inbox",
    knowledge: "knowledge",
    reminders: "reminder",
  });
});

test("STATUS_DOMAINS is exactly the per-folder status enums", () => {
  // Authority: AGENTS.md § Tasks/Inbox + reminders/README.md taxonomy.
  expect(STATUS_DOMAINS).toEqual({
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
  });
});

test("STATUS_OPTIONAL_FOLDERS is exactly the captures folders", () => {
  expect(STATUS_OPTIONAL_FOLDERS).toEqual({
    "inbox/captures": true,
    "inbox/captures/resolved": true,
  });
});

test("REQUIRED_KEYS is exactly the schema-required keys per type", () => {
  expect(REQUIRED_KEYS).toEqual({
    task: ["type", "status", "created", "completed", "tags"],
    inbox: ["type", "created", "source"],
    knowledge: ["type", "created", "updated", "tags"],
    reminder: ["type", "status", "created", "remind-at", "tags"],
    index: ["type", "created"],
  });
});

test("VALUE_DOMAINS is exactly the enumerated scalar domains", () => {
  expect(VALUE_DOMAINS).toEqual({
    source: ["capture", "operator", "session"],
    repeat: ["daily", "weekly", "monthly", "custom"],
  });
});

// ---------------------------------------------------------------------------
// Parser unit checks (3)
// ---------------------------------------------------------------------------

test("parser: inline/block lists, quoted empties, nulls, comments", () => {
  const { data } = parseFrontmatter(`---
type: task
status: active
created: 2026-07-29
completed: null
resolution: ""
tags: [exercise, tooling]
materials:
  - alpha
  - "two words"
note: value # trailing comment
blocked-by: []
---
body
`);
  expect(data.type).toBe("task");
  expect(data.completed).toBeNull();
  expect(data.resolution).toBe("");
  expect(data.tags).toEqual(["exercise", "tooling"]);
  expect(data.materials).toEqual(["alpha", "two words"]);
  expect(data.note).toBe("value");
  expect(data["blocked-by"]).toEqual([]); // explicit empty list stays a list
});

test("parser: bare block-list header with no items collapses to null", () => {
  const { data } = parseFrontmatter("---\ntype: task\npaused:\nstatus: active\n---\n");
  expect(data.paused).toBeNull();
  expect(data.status).toBe("active");
});

test("parser: unterminated quote throws with the offending line", () => {
  let err: FrontmatterParseError | null = null;
  try {
    parseFrontmatter('---\ntype: task\nnote: "oops\n---\n');
  } catch (e) {
    err = e as FrontmatterParseError;
  }
  expect(err).toBeInstanceOf(FrontmatterParseError);
  expect(err!.line).toBe(3);
});

// ---------------------------------------------------------------------------
// Wikilink unit checks (2)
// ---------------------------------------------------------------------------

test("wikilinks: code fences and inline code are not prose", () => {
  const text = [
    "Real link: [[AGENTS]] and [[knowledge/audit-surface-design|alias]].",
    "Inline code `[[wikilink]]` must not count.",
    "```",
    "[[not-a-link]]",
    "```",
    "Heading ref: [[context/current-state#Section]].",
  ].join("\n");
  const links = extractWikilinks(text);
  expect(links.map((l) => l.target)).toEqual([
    "AGENTS",
    "knowledge/audit-surface-design",
    "context/current-state",
  ]);
  expect(links[2].line).toBe(6); // fence-blanked lines keep numbering
});

test("wikilinks: extension-bearing targets resolve as-is", () => {
  expect(extractWikilinks("[[AGENTS.md]]")[0].target).toBe("AGENTS.md");
});

// ---------------------------------------------------------------------------
// Fixture-driven e2e (replaces "the house itself is clean")
// ---------------------------------------------------------------------------

test("fixture clean-house is clean (end-to-end)", async () => {
  const result = await lint(CLEAN_HOUSE);
  expect(result.findings).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.files).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// House-root guard
// ---------------------------------------------------------------------------

test("house-root guard: markers AGENTS.md + tasks/", () => {
  expect(isHouseRoot(CLEAN_HOUSE)).toBe(true);
  expect(resolveHouseRoot(join(CLEAN_HOUSE, "tasks"))).toBe(resolve(CLEAN_HOUSE));

  const foreign = mkdtempSync(join(tmpdir(), "house-lint-foreign-"));
  try {
    writeFileSync(join(foreign, "README.md"), "# not a house\n");
    expect(isHouseRoot(foreign)).toBe(false);
    expect(resolveHouseRoot(foreign)).toBeNull();
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
});

test("house-root guard: EXIT_FOREIGN_ROOT is 64", () => {
  expect(EXIT_FOREIGN_ROOT).toBe(64);
});

// ---------------------------------------------------------------------------
// Fixture dirty findings (status domain + lifecycle)
// ---------------------------------------------------------------------------

test("fixture dirty-task surfaces value-domain and lifecycle findings", async () => {
  const dirtyRoot = join(FIXTURES, "dirty-house");
  const result = await lint(dirtyRoot);
  expect(result.ok).toBe(false);
  const rules = result.findings.map((f) => f.rule);
  expect(rules).toContain("value-domain");
  // wrong status in tasks/ root (complete belongs in tasks/completed/)
  const statusFinding = result.findings.find(
    (f) => f.rule === "value-domain" && f.message.includes("status"),
  );
  expect(statusFinding).toBeDefined();
});
