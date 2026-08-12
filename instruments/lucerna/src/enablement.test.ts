import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_ENABLEMENT,
  parseEnablementJson,
  readEnablementFile,
  readEnablementForHouse,
  resolveStartFlags,
} from "./enablement.ts";
import {
  CHARTER_FILES,
  RUNTIME_FILES,
  enablementPath,
  houseRuntimeDir,
  legacyEnablementPath,
} from "./paths.ts";

function scratchHouse(): { house: string; runtime: string; charter: string } {
  const house = mkdtempSync(join(tmpdir(), "lucerna-en-"));
  const runtime = houseRuntimeDir(house);
  const charter = join(house, ".amore", "lucerna");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(charter, { recursive: true });
  return { house, runtime, charter };
}

describe("parseEnablementJson", () => {
  test("empty / invalid → defaults (dreams off, auto-commit dry-run)", () => {
    expect(parseEnablementJson("")).toEqual(DEFAULT_ENABLEMENT);
    expect(parseEnablementJson("not-json")).toEqual(DEFAULT_ENABLEMENT);
    expect(parseEnablementJson("{}")).toEqual(DEFAULT_ENABLEMENT);
  });

  test("true knobs map; absent autoCommitEnabled stays on", () => {
    expect(
      parseEnablementJson(JSON.stringify({ dreamsEnabled: true, autoCommitLive: true })),
    ).toEqual({ dreamsEnabled: true, autoCommitEnabled: true, autoCommitLive: true });
    expect(
      parseEnablementJson(JSON.stringify({ dreamsEnabled: false, autoCommitLive: true })),
    ).toEqual({ dreamsEnabled: false, autoCommitEnabled: true, autoCommitLive: true });
    expect(
      parseEnablementJson(JSON.stringify({ dreamsEnabled: "yes", autoCommitLive: 1 })),
    ).toEqual(DEFAULT_ENABLEMENT);
  });

  test("autoCommitEnabled false is spend-off and clears live", () => {
    expect(
      parseEnablementJson(
        JSON.stringify({ autoCommitEnabled: false, autoCommitLive: true }),
      ),
    ).toEqual({ dreamsEnabled: false, autoCommitEnabled: false, autoCommitLive: false });
  });
});

describe("readEnablementFile", () => {
  test("absent file → defaults OFF", () => {
    const { house, runtime } = scratchHouse();
    try {
      const r = readEnablementFile(runtime);
      expect(r.enablement).toEqual(DEFAULT_ENABLEMENT);
      expect(r.error).toBeUndefined();
      expect(r.legacyLocation).toBeUndefined();
      expect(readEnablementForHouse(house)).toEqual(r);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("charter enable.json honored", () => {
    const { house, runtime, charter } = scratchHouse();
    try {
      writeFileSync(
        join(charter, CHARTER_FILES.enable),
        JSON.stringify({ dreamsEnabled: true, autoCommitLive: true }),
        "utf-8",
      );
      const r = readEnablementFile(runtime);
      expect(r.enablement).toEqual({
        dreamsEnabled: true,
        autoCommitEnabled: true,
        autoCommitLive: true,
      });
      expect(r.legacyLocation).toBeUndefined();
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("legacy-only file still returns flags + legacyLocation", () => {
    const { house, runtime } = scratchHouse();
    try {
      writeFileSync(
        join(runtime, RUNTIME_FILES.enable),
        JSON.stringify({ dreamsEnabled: true, autoCommitLive: false }),
        "utf-8",
      );
      const r = readEnablementFile(runtime);
      expect(r.enablement).toEqual({
        dreamsEnabled: true,
        autoCommitEnabled: true,
        autoCommitLive: false,
      });
      expect(r.legacyLocation).toBe(true);
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("charter path wins over legacy", () => {
    const { house, runtime, charter } = scratchHouse();
    try {
      writeFileSync(
        join(runtime, RUNTIME_FILES.enable),
        JSON.stringify({ dreamsEnabled: false, autoCommitLive: true }),
        "utf-8",
      );
      writeFileSync(
        join(charter, CHARTER_FILES.enable),
        JSON.stringify({ dreamsEnabled: true, autoCommitLive: false }),
        "utf-8",
      );
      const r = readEnablementForHouse(house);
      expect(r.enablement).toEqual({
        dreamsEnabled: true,
        autoCommitEnabled: true,
        autoCommitLive: false,
      });
      expect(r.legacyLocation).toBeUndefined();
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("malformed charter file → both false + error", () => {
    const { house, runtime, charter } = scratchHouse();
    try {
      writeFileSync(join(charter, CHARTER_FILES.enable), "{not valid", "utf-8");
      const r = readEnablementFile(runtime);
      expect(r.enablement).toEqual(DEFAULT_ENABLEMENT);
      expect(r.error).toMatch(/malformed/i);
      expect(r.legacyLocation).toBeUndefined();
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });

  test("enablementPath resolves new path first", () => {
    const { house } = scratchHouse();
    try {
      expect(enablementPath(house).replace(/\\/g, "/")).toMatch(
        /\.amore\/lucerna\/enable\.json$/,
      );
      expect(legacyEnablementPath(house).replace(/\\/g, "/")).toMatch(
        /instruments\/lucerna\/lucerna\.enable\.json$/,
      );
    } finally {
      rmSync(house, { recursive: true, force: true });
    }
  });
});

describe("resolveStartFlags", () => {
  test("absent enablement + no env → dry-run (no argv flags)", () => {
    const r = resolveStartFlags({});
    expect(r.dreamsEnabled).toBe(false);
    expect(r.autoCommitEnabled).toBe(true);
    expect(r.autoCommitLive).toBe(false);
    expect(r.argvFlags).toEqual([]);
  });

  test("durable enablement ON → both flags", () => {
    const r = resolveStartFlags({
      enablement: { dreamsEnabled: true, autoCommitEnabled: true, autoCommitLive: true },
    });
    expect(r.autoCommitEnabled).toBe(true);
    expect(r.argvFlags).toEqual(["--dreams-enabled", "--auto-commit-live"]);
  });

  test("env alone can enable", () => {
    const r = resolveStartFlags({
      envDreams: "1",
      envAutoCommitLive: "1",
    });
    expect(r.autoCommitEnabled).toBe(true);
    expect(r.argvFlags).toEqual(["--dreams-enabled", "--auto-commit-live"]);
  });

  test("file autoCommitEnabled false disables drafting", () => {
    const r = resolveStartFlags({
      enablement: { dreamsEnabled: false, autoCommitEnabled: false, autoCommitLive: false },
    });
    expect(r.autoCommitEnabled).toBe(false);
    expect(r.autoCommitLive).toBe(false);
    expect(r.argvFlags).toEqual(["--no-auto-commit"]);
  });

  test("--no-auto-commit and LUCERNA_AUTO_COMMIT=0 win over file on", () => {
    const base = {
      enablement: { dreamsEnabled: false, autoCommitEnabled: true, autoCommitLive: true },
    };
    expect(resolveStartFlags({ ...base, args: ["--no-auto-commit"] }).autoCommitEnabled).toBe(
      false,
    );
    expect(resolveStartFlags({ ...base, envAutoCommit: "0" }).autoCommitEnabled).toBe(false);
  });

  test("live argv/env re-enables a file that is off", () => {
    const r = resolveStartFlags({
      enablement: { dreamsEnabled: false, autoCommitEnabled: false, autoCommitLive: false },
      args: ["--auto-commit-live"],
    });
    expect(r.autoCommitEnabled).toBe(true);
    expect(r.autoCommitLive).toBe(true);
  });
});
