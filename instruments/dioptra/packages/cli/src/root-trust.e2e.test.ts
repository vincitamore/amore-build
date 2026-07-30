/**
 * End-to-end regression for the tiered foreign-root trust model (Phase 1.5 D2).
 * Spawns the real CLI entry so the single seam in index.ts is exercised.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, 'index.ts');

let foreignRoot: string;
let houseRoot: string;

beforeEach(() => {
  foreignRoot = mkdtempSync(join(tmpdir(), 'dioptra-foreign-'));
  houseRoot = mkdtempSync(join(tmpdir(), 'dioptra-house-'));
  writeFileSync(join(houseRoot, 'AGENTS.md'), '# house\n');
  mkdirSync(join(houseRoot, 'tasks'), { recursive: true });
});

afterEach(() => {
  rmSync(foreignRoot, { recursive: true, force: true });
  rmSync(houseRoot, { recursive: true, force: true });
});

function runCli(
  args: string[],
  env: Record<string, string | undefined>,
): { exitCode: number; stdout: string; stderr: string } {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'DIOPTRA_ORG_ROOT' && k !== 'DIOPTRA_ALLOW_FOREIGN_ROOT') {
      merged[k] = v;
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: merged,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe('CLI foreign-root tiered trust (e2e)', () => {
  test('mutation against foreign root refuses with remedy text', () => {
    const r = runCli(
      [
        'task',
        'create',
        '--title',
        'X',
        '--tags',
        't',
        '--description',
        'A goal long enough to pass the floor!!',
      ],
      { DIOPTRA_ORG_ROOT: foreignRoot },
    );
    expect(r.exitCode).toBe(64);
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/REFUSING mutation/);
    expect(combined).toContain('--allow-foreign-root');
    expect(combined).toContain('DIOPTRA_ALLOW_FOREIGN_ROOT=1');
  });

  test('mutation against foreign root + --allow-foreign-root proceeds', () => {
    const r = runCli(
      [
        'task',
        'create',
        '--title',
        'Allowed Task',
        '--tags',
        't',
        '--description',
        'A goal long enough to pass the floor!!',
        '--allow-foreign-root',
      ],
      { DIOPTRA_ORG_ROOT: foreignRoot },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"ok": true');
    expect(r.stdout).toContain('tasks/allowed-task.md');
  });

  test('mutation against foreign root + DIOPTRA_ALLOW_FOREIGN_ROOT=1 proceeds', () => {
    const r = runCli(
      [
        'task',
        'create',
        '--title',
        'Env Allowed',
        '--tags',
        't',
        '--description',
        'A goal long enough to pass the floor!!',
      ],
      { DIOPTRA_ORG_ROOT: foreignRoot, DIOPTRA_ALLOW_FOREIGN_ROOT: '1' },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"ok": true');
  });

  test('read against foreign root works unflagged', () => {
    const r = runCli(['status', '--json'], { DIOPTRA_ORG_ROOT: foreignRoot });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"ok": true');
    expect(r.stdout + r.stderr).not.toMatch(/REFUSING/);
  });

  test('mutation on recognized house root works unflagged', () => {
    const r = runCli(
      [
        'task',
        'create',
        '--title',
        'House Task',
        '--tags',
        't',
        '--description',
        'A goal long enough to pass the floor!!',
      ],
      { DIOPTRA_ORG_ROOT: houseRoot },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"ok": true');
  });
});
