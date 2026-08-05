import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VERSION,
  PROCESS_NAME,
  packageVersion,
  formatVersionLine,
} from "./config.ts";

describe("package version (embedded package.json)", () => {
  test("VERSION matches package.json and is not empty", () => {
    const pkgPath = join(import.meta.dir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    expect(typeof pkg.version).toBe("string");
    expect(pkg.version.length).toBeGreaterThan(0);
    expect(VERSION).toBe(pkg.version);
    expect(packageVersion()).toBe(pkg.version);
  });

  test("formatVersionLine is 'lucerna <semver>'", () => {
    const line = formatVersionLine();
    expect(line).toBe(`${PROCESS_NAME} ${packageVersion()}`);
    expect(line).toMatch(/^lucerna \d+\.\d+\.\d+/);
  });

  test("CLI --version prints formatVersionLine and exits 0", async () => {
    const cli = join(import.meta.dir, "cli.ts");
    const proc = Bun.spawn(["bun", "run", cli, "--version"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(formatVersionLine());
  });

  test("CLI version (bare) also works", async () => {
    const cli = join(import.meta.dir, "cli.ts");
    const proc = Bun.spawn(["bun", "run", cli, "version"], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(formatVersionLine());
  });
});
