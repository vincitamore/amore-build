import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SPECULUM_VERSION, versionLine } from "./version";
import pkg from "../package.json";

const CLI = join(import.meta.dir, "cli.ts");

describe("version", () => {
  test("versionLine matches package.json (not hardcoded)", () => {
    expect(SPECULUM_VERSION).toBe(pkg.version);
    expect(versionLine()).toBe(`speculum ${pkg.version}`);
    expect(versionLine()).toMatch(/^speculum \d+\.\d+\.\d+/);
  });

  test("cli --version prints speculum <x.y.z> and exits 0", () => {
    const r = Bun.spawnSync(["bun", "run", CLI, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(`speculum ${pkg.version}`);
  });

  test("cli version (bare verb) prints the same line", () => {
    const r = Bun.spawnSync(["bun", "run", CLI, "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(`speculum ${pkg.version}`);
  });
});
