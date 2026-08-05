import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_ENABLEMENT,
  ENABLE_FILE_NAME,
  parseEnablementJson,
  readEnablementFile,
  resolveStartFlags,
} from "./enablement.ts";

describe("parseEnablementJson", () => {
  test("empty / invalid → both false", () => {
    expect(parseEnablementJson("")).toEqual(DEFAULT_ENABLEMENT);
    expect(parseEnablementJson("not-json")).toEqual(DEFAULT_ENABLEMENT);
    expect(parseEnablementJson("{}")).toEqual(DEFAULT_ENABLEMENT);
  });

  test("true knobs map; false/other stay off", () => {
    expect(
      parseEnablementJson(JSON.stringify({ dreamsEnabled: true, autoCommitLive: true })),
    ).toEqual({ dreamsEnabled: true, autoCommitLive: true });
    expect(
      parseEnablementJson(JSON.stringify({ dreamsEnabled: false, autoCommitLive: true })),
    ).toEqual({ dreamsEnabled: false, autoCommitLive: true });
    expect(
      parseEnablementJson(JSON.stringify({ dreamsEnabled: "yes", autoCommitLive: 1 })),
    ).toEqual(DEFAULT_ENABLEMENT);
  });
});

describe("readEnablementFile", () => {
  test("absent file → defaults OFF", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-en-"));
    try {
      const r = readEnablementFile(dir);
      expect(r.enablement).toEqual(DEFAULT_ENABLEMENT);
      expect(r.error).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("present file → parsed knobs", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-en-"));
    try {
      writeFileSync(
        join(dir, ENABLE_FILE_NAME),
        JSON.stringify({ dreamsEnabled: true, autoCommitLive: true }),
        "utf-8",
      );
      const r = readEnablementFile(dir);
      expect(r.enablement).toEqual({ dreamsEnabled: true, autoCommitLive: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("malformed file → both false + error", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-en-"));
    try {
      writeFileSync(join(dir, ENABLE_FILE_NAME), "{not valid", "utf-8");
      const r = readEnablementFile(dir);
      expect(r.enablement).toEqual(DEFAULT_ENABLEMENT);
      expect(r.error).toMatch(/malformed/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveStartFlags", () => {
  test("absent enablement + no env → no flags", () => {
    const r = resolveStartFlags({});
    expect(r.dreamsEnabled).toBe(false);
    expect(r.autoCommitLive).toBe(false);
    expect(r.argvFlags).toEqual([]);
  });

  test("durable enablement ON → both flags", () => {
    const r = resolveStartFlags({
      enablement: { dreamsEnabled: true, autoCommitLive: true },
    });
    expect(r.argvFlags).toEqual(["--dreams-enabled", "--auto-commit-live"]);
  });

  test("env alone can enable", () => {
    const r = resolveStartFlags({
      envDreams: "1",
      envAutoCommitLive: "1",
    });
    expect(r.argvFlags).toEqual(["--dreams-enabled", "--auto-commit-live"]);
  });
});
