import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PROTECTED_PATTERNS,
  WRITABLE_PATTERNS,
  LEGACY_CHARTER_FILES,
  RUNTIME_STATE_FILES,
  isProtectedPath,
  isLucernaRuntimePath,
  canWrite,
  assertWritable,
  writeGuarded,
  writeDecision,
  parseGovernanceUserToml,
  mergeGovernanceLists,
  loadUserGovernance,
  defaultLists,
  Governance,
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
    expect(canWrite(root, root + "/instruments/lucerna/wake")).toBe(true);
    expect(canWrite(root, root + "/instruments/lucerna/sleep")).toBe(true);
    expect(canWrite(root, root + "/instruments/lucerna/daemon.pid")).toBe(true);
    expect(canWrite(root, root + "/instruments/lucerna/notifications.jsonl")).toBe(true);
    expect(canWrite(root, root + "/instruments/lucerna/src/index.ts")).toBe(false);
    expect(canWrite(root, root + "/instruments/lucerna/package.json")).toBe(false);
    expect(canWrite(root, root + "/instruments/lucerna/sub/x.json")).toBe(false);
  });

  test("LEGACY_CHARTER_FILES exact equality + not residual-writable", () => {
    expect([...LEGACY_CHARTER_FILES]).toEqual([
      "lucerna.enable.json",
      "governance.user.toml",
    ]);
    const root = "C:/Users/example/house";
    for (const name of LEGACY_CHARTER_FILES) {
      const abs = root + "/instruments/lucerna/" + name;
      expect(isLucernaRuntimePath(root, abs)).toBe(false);
      expect(canWrite(root, abs)).toBe(false);
      const g = new Governance(root, defaultLists());
      expect(g.isProtected(abs)).toBe(true);
    }
  });

  test("RUNTIME_STATE_FILES exact equality", () => {
    expect([...RUNTIME_STATE_FILES]).toEqual([
      "health.json",
      "state.json",
      "log",
      "notifications.jsonl",
      "daemon.pid",
      "halt",
      "wake",
      "sleep",
    ]);
  });

  test("charter paths under .amore/lucerna are not writable", () => {
    const root = "C:/Users/example/house";
    const charter = [
      ".amore/lucerna/enable.json",
      ".amore/lucerna/governance.user.toml",
      ".amore/lucerna/budgets.json",
      ".amore/lucerna/chores.json",
    ];
    for (const rel of charter) {
      const abs = root + "/" + rel;
      expect(canWrite(root, abs)).toBe(false);
      expect(() => writeGuarded(root, abs, "nope")).toThrow(/write denied/);
    }
  });

  test("writeDecision order: user-extra, residual, protected, writable", () => {
    const root = "C:/Users/example/house";
    const lists = mergeGovernanceLists({
      protectedExtra: ["instruments/lucerna/health.json"],
    });
    const extra = writeDecision(root, root + "/instruments/lucerna/health.json", lists);
    expect(extra).toEqual({
      allowed: false,
      residual: false,
      userExtra: true,
      protected: true,
    });
    const residual = writeDecision(root, root + "/instruments/lucerna/state.json", lists);
    expect(residual.allowed).toBe(true);
    expect(residual.residual).toBe(true);
    const prot = writeDecision(root, root + "/knowledge/x.md", lists);
    expect(prot.allowed).toBe(false);
    expect(prot.protected).toBe(true);
    const writ = writeDecision(root, root + "/forge/ok.md", lists);
    expect(writ.allowed).toBe(true);
    expect(writ.residual).toBe(false);
    expect(writ.protected).toBe(false);
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
    expect(lists.protectedUserExtra).toEqual([]);
  });

  test("protected_extra on legacy enablement path denies write", () => {
    const lists = mergeGovernanceLists({
      protectedExtra: ["instruments/lucerna/lucerna.enable.json"],
    });
    const root = "C:/house";
    expect(canWrite(root, root + "/instruments/lucerna/lucerna.enable.json", lists)).toBe(
      false,
    );
  });

  test("protected_extra outranks residual allow-list", () => {
    const lists = mergeGovernanceLists({
      protectedExtra: ["instruments/lucerna/health.json"],
    });
    const root = "C:/house";
    expect(canWrite(root, root + "/instruments/lucerna/health.json", lists)).toBe(false);
    expect(canWrite(root, root + "/instruments/lucerna/state.json", lists)).toBe(true);
  });

  test("loadUserGovernance reads charter path then legacy", () => {
    const house = mkdtempSync(join(tmpdir(), "lucerna-gov-user-"));
    try {
      const charter = join(house, ".amore", "lucerna");
      const runtime = join(house, "instruments", "lucerna");
      mkdirSync(charter, { recursive: true });
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        join(runtime, "governance.user.toml"),
        `protected_extra = ["legacy-only/"]\n`,
        "utf-8",
      );
      expect(loadUserGovernance(house).protectedExtra).toEqual(["legacy-only/"]);
      writeFileSync(
        join(charter, "governance.user.toml"),
        `protected_extra = ["charter-only/"]\n`,
        "utf-8",
      );
      expect(loadUserGovernance(house).protectedExtra).toEqual(["charter-only/"]);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
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
