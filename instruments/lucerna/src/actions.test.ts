import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  utimesSync,
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
  runEdgesUpdate,
  runEdgesDensify,
  runQmdRefresh,
  extractWikilinks,
  parseFrontmatter,
} from "./actions.ts";
import { canWrite } from "./governance.ts";
import type { SpawnSyncReturns } from "node:child_process";

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
  test("admitted catalog: light daily + agentic weekly", () => {
    expect(ADMITTED_ACTION_KEYS).toEqual([
      "survey-org",
      "substrate-health",
      "inbox-age-report",
      "state-cleanup",
      "edges-update",
      "qmd-refresh",
      "self-orient",
      "agentic-housekeeping",
      "edges-densify",
    ]);
    for (const e of ACTION_CATALOG) {
      expect(e.parity === "admit" || e.parity === "defer" || e.parity === "refuse").toBe(true);
    }
    const light = ACTION_CATALOG.filter((e) => e.class === "light");
    for (const e of light) {
      expect(e.budgetTier).toBe("daily");
      expect(e.cooldownClass).toBe("light");
    }
    const agentic = ACTION_CATALOG.filter(
      (e) => e.class === "agentic" || e.class === "recipe-map",
    );
    expect(agentic.map((e) => e.key).sort()).toEqual(
      ["agentic-housekeeping", "edges-densify", "self-orient"].sort(),
    );
    for (const e of agentic) {
      expect(e.budgetTier).toBe("weekly");
      expect(e.cooldownClass).toBe("recipe");
      expect(e.admitted).toBe(true);
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
  test("survey-org writes forge/dreams report only", async () => {
    const house = syntheticHouse();
    try {
      const r = runSurveyOrg(house);
      expect(r.ok).toBe(true);
      expect(r.artifactPath).toBeDefined();
      expect(r.artifactPath!.replace(/\\/g, "/")).toContain("forge/dreams/");
      expect(canWrite(house, r.artifactPath!)).toBe(true);
      expect(existsSync(r.artifactPath!)).toBe(true);
      const body = await Bun.file(r.artifactPath!).text();
      expect(body).toContain("triggered-by: dream");
      expect(body).toContain("dream-action: survey-org");
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
      const runtime = join(house, "instruments", "lucerna");
      // Deterministic age: backdate fixtures so prune does not race FS clock
      // resolution (Linux mtimeMs can equal or slightly lead Date.now()).
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(join(runtime, "log.1"), twoHoursAgo, twoHoursAgo);
      utimesSync(join(runtime, "draft-old.bak"), twoHoursAgo, twoHoursAgo);
      // tmp prune uses a fixed 1h floor; include a backdated .tmp candidate.
      writeFileSync(join(runtime, "scratch.tmp"), "tmp\n", "utf-8");
      utimesSync(join(runtime, "scratch.tmp"), twoHoursAgo, twoHoursAgo);

      const r = runStateCleanup(house, { maxAgeMs: 60 * 60 * 1000 });
      expect(r.ok).toBe(true);
      expect(existsSync(r.artifactPath!)).toBe(true);
      const remaining = readdirSync(runtime);
      expect(remaining.includes("log.1")).toBe(false);
      expect(remaining.includes("draft-old.bak")).toBe(false);
      expect(remaining.includes("scratch.tmp")).toBe(false);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("executeLightAction dispatches light and shell keys", () => {
    const house = syntheticHouse();
    try {
      const lightKeys = [
        "survey-org",
        "substrate-health",
        "inbox-age-report",
        "state-cleanup",
      ];
      for (const key of lightKeys) {
        const r = executeLightAction(key, house);
        expect(r).not.toBeNull();
        expect(r!.ok).toBe(true);
      }
      // Full agentic keys have no light runner
      expect(executeLightAction("self-orient", house)).toBeNull();
      expect(executeLightAction("agentic-housekeeping", house)).toBeNull();
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

describe("edges-update / edges-densify against stub iris", () => {
  test("edges-update argv is iris edges update --tier 0 --json", () => {
    const house = syntheticHouse();
    try {
      let capturedArgv: string[] = [];
      const spawnSyncImpl = ((_bin: string, argv: readonly string[]) => {
        capturedArgv = [...argv];
        return {
          status: 0,
          stdout: JSON.stringify({ added: 0, updated: 0 }),
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync;

      const r = runEdgesUpdate(house, { spawnSyncImpl });
      expect(r.ok).toBe(true);
      expect(capturedArgv).toEqual(["edges", "update", "--tier", "0", "--json"]);
      expect(r.artifactPath!.replace(/\\/g, "/")).toContain("forge/dreams/");
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("edges-densify argv is --tier 2", () => {
    const house = syntheticHouse();
    try {
      let capturedArgv: string[] = [];
      const spawnSyncImpl = ((_bin: string, argv: readonly string[]) => {
        capturedArgv = [...argv];
        return {
          status: 0,
          stdout: "{}",
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync;

      const r = runEdgesDensify(house, { spawnSyncImpl });
      expect(r.ok).toBe(true);
      expect(capturedArgv).toEqual(["edges", "update", "--tier", "2", "--json"]);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("missing iris is honest failure not crash", () => {
    const house = syntheticHouse();
    try {
      const spawnSyncImpl = (() => {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawn iris ENOENT"), { code: "ENOENT" }),
          pid: 0,
          output: [],
          signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync;

      const r = runEdgesUpdate(house, { spawnSyncImpl });
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/iris|spawn|ENOENT|unavailable/i);
      expect(r.artifactPath).toBeDefined();
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("nonzero iris exit is action failure", () => {
    const house = syntheticHouse();
    try {
      const spawnSyncImpl = (() => {
        return {
          status: 2,
          stdout: "",
          stderr: "validity gate",
          pid: 1,
          output: [],
          signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync;

      const r = executeLightAction("edges-update", house, undefined, {
        spawnSyncImpl,
      });
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(r!.detail).toMatch(/exited 2/);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("qmd-refresh against stub iris", () => {
  test("argv is iris qmd update --embed --json", () => {
    const house = syntheticHouse();
    try {
      let capturedArgv: string[] = [];
      const spawnSyncImpl = ((_bin: string, argv: readonly string[]) => {
        capturedArgv = [...argv];
        return {
          status: 0,
          stdout: JSON.stringify({ updated: 3, backlog: 0 }),
          stderr: "",
          pid: 1,
          output: [],
          signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync;

      const r = runQmdRefresh(house, { spawnSyncImpl });
      expect(r.ok).toBe(true);
      expect(capturedArgv).toEqual(["qmd", "update", "--embed", "--json"]);
      expect(r.artifactPath!.replace(/\\/g, "/")).toContain("forge/dreams/");
      expect(r.detail).toMatch(/ok/i);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("missing iris is honest failure not crash", () => {
    const house = syntheticHouse();
    try {
      const spawnSyncImpl = (() => {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawn iris ENOENT"), { code: "ENOENT" }),
          pid: 0,
          output: [],
          signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync;

      const r = runQmdRefresh(house, { spawnSyncImpl });
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/iris|spawn|ENOENT|unavailable/i);
      expect(r.artifactPath).toBeDefined();
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("missing qmd runtime is honest failure", () => {
    const house = syntheticHouse();
    try {
      const spawnSyncImpl = (() => {
        return {
          status: 1,
          stdout: "",
          stderr: "qmd runtime not found; install qmd or enable the house search index",
          pid: 1,
          output: [],
          signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync;

      const r = executeLightAction("qmd-refresh", house, undefined, {
        spawnSyncImpl,
      });
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(false);
      expect(r!.detail).toMatch(/qmd runtime missing|unavailable/i);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("nonzero iris exit is action failure", () => {
    const house = syntheticHouse();
    try {
      const spawnSyncImpl = (() => {
        return {
          status: 3,
          stdout: "",
          stderr: "embed failed",
          pid: 1,
          output: [],
          signal: null,
        } as unknown as SpawnSyncReturns<string>;
      }) as unknown as typeof import("node:child_process").spawnSync;

      const r = runQmdRefresh(house, { spawnSyncImpl });
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/exited 3/);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("catalog entry is light daily with light cooldown", () => {
    const e = ACTION_CATALOG.find((x) => x.key === "qmd-refresh");
    expect(e).toBeDefined();
    expect(e!.class).toBe("light");
    expect(e!.budgetTier).toBe("daily");
    expect(e!.cooldownClass).toBe("light");
    expect(e!.admitted).toBe(true);
  });
});
