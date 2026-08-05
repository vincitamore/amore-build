import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROTECTED_PATTERNS,
  WRITABLE_PATTERNS,
  isProtectedPath,
  canWrite,
  assertWritable,
  writeGuarded,
  parseGovernanceUserToml,
  mergeGovernanceLists,
  defaultLists,
} from "./governance.ts";

describe("governance catalogs", () => {
  test("PROTECTED_PATTERNS exact equality (anti-accretion pin)", () => {
    expect([...PROTECTED_PATTERNS]).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "context/",
      "knowledge/",
      "tasks/",
      "reminders/",
      "tags/",
      "graph/",
      "projects/",
      "archive/",
      "scripts/",
      ".amore/",
      ".grok/",
      ".claude/",
      "instruments/",
    ]);
  });

  test("WRITABLE_PATTERNS exact equality", () => {
    expect([...WRITABLE_PATTERNS]).toEqual(["inbox/captures/", "forge/"]);
  });

  test("forge is writable; AGENTS.md and knowledge are protected", () => {
    const root = "C:/Users/example/house";
    expect(isProtectedPath(root, root + "/AGENTS.md")).toBe(true);
    expect(isProtectedPath(root, root + "/CLAUDE.md")).toBe(true);
    expect(isProtectedPath(root, root + "/knowledge/x.md")).toBe(true);
    expect(isProtectedPath(root, root + "/context/current-state.md")).toBe(true);
    expect(isProtectedPath(root, root + "/tasks/foo.md")).toBe(true);
    expect(canWrite(root, root + "/forge/report.md")).toBe(true);
    expect(canWrite(root, root + "/inbox/captures/note.md")).toBe(true);
    expect(canWrite(root, root + "/inbox/ideas/note.md")).toBe(false);
    expect(canWrite(root, root + "/knowledge/x.md")).toBe(false);
    expect(canWrite(root, root + "/AGENTS.md")).toBe(false);
  });

  test("instruments/ protected but lucerna runtime residual writable", () => {
    const root = "C:/Users/example/house";
    expect(isProtectedPath(root, root + "/instruments/other/src/x.ts")).toBe(true);
    expect(canWrite(root, root + "/instruments/other/src/x.ts")).toBe(false);
    expect(canWrite(root, root + "/instruments/lucerna/health.json")).toBe(true);
    expect(canWrite(root, root + "/instruments/lucerna/state.json")).toBe(true);
    expect(canWrite(root, root + "/instruments/lucerna/log")).toBe(true);
    expect(canWrite(root, root + "/instruments/lucerna/halt")).toBe(true);
    expect(canWrite(root, root + "/instruments/lucerna/src/index.ts")).toBe(false);
    expect(canWrite(root, root + "/instruments/lucerna/package.json")).toBe(false);
  });

  test("paths outside house root are denied", () => {
    const root = "C:/Users/example/house";
    expect(canWrite(root, "C:/Users/example/other/file.md")).toBe(false);
    expect(isProtectedPath(root, "C:/Users/example/other/file.md")).toBe(true);
  });
});

describe("user governance additions", () => {
  test("parseGovernanceUserToml reads protected_extra only", () => {
    const parsed = parseGovernanceUserToml(`
# comment
protected_extra = ["secrets/", "private/notes/"]
writable_extra = ["should-be-ignored/"]
`);
    expect(parsed.protectedExtra).toEqual(["secrets/", "private/notes/"]);
  });

  test("merge adds protected; never widens writable", () => {
    const lists = mergeGovernanceLists({ protectedExtra: ["secrets/", "forge/private/"] });
    expect(lists.protected).toContain("secrets/");
    expect(lists.protected).toContain("AGENTS.md");
    expect(lists.writable).toEqual([...WRITABLE_PATTERNS]);
    // forge/private/ is now protected even though forge/ is writable  -  protect wins
    const root = "C:/house";
    expect(canWrite(root, root + "/forge/ok.md", lists)).toBe(true);
    expect(canWrite(root, root + "/forge/private/x.md", lists)).toBe(false);
    expect(canWrite(root, root + "/secrets/a.key", lists)).toBe(false);
  });

  test("user cannot unprotect shipped defaults", () => {
    const lists = mergeGovernanceLists({ protectedExtra: [] });
    expect(lists.protected).toEqual([...PROTECTED_PATTERNS]);
  });
});

describe("write-guard denial", () => {
  test("assertWritable throws on protected path", () => {
    const root = "C:/house";
    expect(() => assertWritable(root, root + "/knowledge/x.md")).toThrow(/write denied/);
    expect(() => assertWritable(root, root + "/forge/ok.md")).not.toThrow();
  });

  test("writeGuarded writes forge report and denies knowledge", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-gov-"));
    try {
      mkdirSync(join(dir, "forge"), { recursive: true });
      mkdirSync(join(dir, "knowledge"), { recursive: true });
      const okPath = join(dir, "forge", "r.md");
      writeGuarded(dir, okPath, "# ok\n");
      expect(Bun.file(okPath).size).toBeGreaterThan(0);
      expect(() => writeGuarded(dir, join(dir, "knowledge", "x.md"), "nope")).toThrow(
        /write denied/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("defaultLists is a fresh copy", () => {
    const a = defaultLists();
    a.protected.push("extra/");
    expect(PROTECTED_PATTERNS).not.toContain("extra/");
  });
});
