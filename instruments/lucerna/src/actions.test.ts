import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ACTION_CATALOG,
  ADMITTED_ACTION_KEYS,
  executeLightAction,
  runSurveyOrg,
  runSubstrateHealth,
  runInboxAgeReport,
  runStateCleanup,
  extractWikilinks,
  parseFrontmatter,
} from "./actions.ts";
import { canWrite } from "./governance.ts";

function syntheticHouse(): string {
  const house = mkdtempSync(join(tmpdir(), "lucerna-house-"));
  mkdirSync(join(house, "tasks"), { recursive: true });
  mkdirSync(join(house, "tasks", "completed"), { recursive: true });
  mkdirSync(join(house, "inbox", "captures"), { recursive: true });
  mkdirSync(join(house, "inbox", "ideas"), { recursive: true });
  mkdirSync(join(house, "reminders"), { recursive: true });
  mkdirSync(join(house, "knowledge"), { recursive: true });
  mkdirSync(join(house, "context"), { recursive: true });
  mkdirSync(join(house, "forge"), { recursive: true });
  mkdirSync(join(house, "instruments", "lucerna"), { recursive: true });

  writeFileSync(join(house, "AGENTS.md"), "# agents\n", "utf-8");
  writeFileSync(join(house, "tasks", "active-one.md"), "---\nstatus: active\n---\n# Task\n", "utf-8");
  writeFileSync(join(house, "tasks", "completed", "done.md"), "# done\n", "utf-8");
  writeFileSync(join(house, "inbox", "captures", "c1.md"), "# capture\n", "utf-8");
  writeFileSync(join(house, "inbox", "ideas", "old.md"), "# idea\n", "utf-8");
  writeFileSync(join(house, "reminders", "r1.md"), "# rem\n", "utf-8");
  writeFileSync(
    join(house, "knowledge", "a.md"),
    "---\ntitle: A\n---\nSee [[missing-page]] and [[b]].\n",
    "utf-8",
  );
  writeFileSync(join(house, "knowledge", "b.md"), "---\ntitle: B\n---\nOk.\n", "utf-8");
  writeFileSync(join(house, "knowledge", "broken-fm.md"), "---\ntitle: unclosed\n", "utf-8");
  writeFileSync(join(house, "context", "current-state.md"), "# state\n", "utf-8");

  // aged runtime artifact for state-cleanup
  writeFileSync(join(house, "instruments", "lucerna", "log.1"), "old\n", "utf-8");
  writeFileSync(join(house, "instruments", "lucerna", "draft-old.bak"), "x\n", "utf-8");

  return house;
}

describe("action catalog", () => {
  test("exactly four admitted phase-1 actions", () => {
    expect(ADMITTED_ACTION_KEYS).toEqual([
      "survey-org",
      "substrate-health",
      "inbox-age-report",
      "state-cleanup",
    ]);
    for (const e of ACTION_CATALOG) {
      expect(e.parity === "admit" || e.parity === "defer" || e.parity === "refuse").toBe(true);
      expect(e.budgetTier).toBe("daily");
      expect(e.cooldownClass).toBe("light");
    }
  });
});

describe("helpers", () => {
  test("extractWikilinks", () => {
    expect(extractWikilinks("a [[Foo|bar]] and [[Baz#h]]")).toEqual(["Foo", "Baz"]);
  });

  test("parseFrontmatter", () => {
    expect(parseFrontmatter("---\na: 1\n---\nbody").ok).toBe(true);
    expect(parseFrontmatter("---\nunclosed").ok).toBe(false);
    expect(parseFrontmatter("nope").ok).toBe(false);
  });
});

describe("light actions against synthetic house", () => {
  test("survey-org writes forge report only", () => {
    const house = syntheticHouse();
    try {
      const r = runSurveyOrg(house);
      expect(r.ok).toBe(true);
      expect(r.artifactPath).toBeDefined();
      expect(r.artifactPath!.includes("forge")).toBe(true);
      expect(canWrite(house, r.artifactPath!)).toBe(true);
      expect(existsSync(r.artifactPath!)).toBe(true);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("substrate-health finds broken links and frontmatter errors", async () => {
    const house = syntheticHouse();
    try {
      const r = runSubstrateHealth(house);
      expect(r.ok).toBe(true);
      const t = await Bun.file(r.artifactPath!).text();
      expect(t).toMatch(/Broken wikilinks/i);
      expect(t).toMatch(/missing-page/);
      expect(t).toMatch(/Frontmatter/i);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("inbox-age-report writes report", () => {
    const house = syntheticHouse();
    try {
      const r = runInboxAgeReport(house);
      expect(r.ok).toBe(true);
      expect(existsSync(r.artifactPath!)).toBe(true);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("state-cleanup prunes aged runtime artifacts and reports", () => {
    const house = syntheticHouse();
    try {
      const r = runStateCleanup(house, { maxAgeMs: 0 });
      expect(r.ok).toBe(true);
      expect(existsSync(r.artifactPath!)).toBe(true);
      // log.1 and draft-old.bak should be candidates
      const runtime = join(house, "instruments", "lucerna");
      const remaining = readdirSync(runtime);
      expect(remaining.includes("log.1")).toBe(false);
      expect(remaining.includes("draft-old.bak")).toBe(false);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("executeLightAction dispatches all admitted keys", () => {
    const house = syntheticHouse();
    try {
      for (const key of ADMITTED_ACTION_KEYS) {
        const r = executeLightAction(key, house);
        expect(r).not.toBeNull();
        expect(r!.ok).toBe(true);
      }
      expect(executeLightAction("not-a-real-action", house)).toBeNull();
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("actions never write to knowledge/", () => {
    const house = syntheticHouse();
    try {
      const before = readdirSync(join(house, "knowledge")).sort();
      executeLightAction("survey-org", house);
      executeLightAction("substrate-health", house);
      const after = readdirSync(join(house, "knowledge")).sort();
      expect(after).toEqual(before);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});
