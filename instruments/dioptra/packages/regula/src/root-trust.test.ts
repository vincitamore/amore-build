import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RegulaError } from './errors';
import {
  assertMutationTrust,
  ensureMutationTrust,
  evaluateRootTrust,
  foreignRootRemedy,
  isHouseRoot,
  plantAllowedRoot,
  allowedRootsPath,
} from './root-trust';

let root: string;
let fakeHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dioptra-trust-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'dioptra-home-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function plantHouseMarkers(dir: string): void {
  writeFileSync(join(dir, 'AGENTS.md'), '# test house\n');
  mkdirSync(join(dir, 'tasks'), { recursive: true });
}

describe('isHouseRoot / evaluateRootTrust', () => {
  test('bare temp dir is not a house root', () => {
    expect(isHouseRoot(root)).toBe(false);
    const d = evaluateRootTrust(root, { env: {}, homeDir: fakeHome });
    expect(d.trusted).toBe(false);
    expect(d.level).toBe('untrusted');
    expect(d.remedy).toBe(foreignRootRemedy());
  });

  test('markers make a recognized house root (mutations unflagged)', () => {
    plantHouseMarkers(root);
    expect(isHouseRoot(root)).toBe(true);
    const d = evaluateRootTrust(root, { env: {}, homeDir: fakeHome });
    expect(d.trusted).toBe(true);
    expect(d.level).toBe('house');
  });

  test('--allow-foreign-root / allowForeignRoot trusts without markers', () => {
    const d = evaluateRootTrust(root, {
      allowForeignRoot: true,
      env: {},
      homeDir: fakeHome,
    });
    expect(d.trusted).toBe(true);
    expect(d.level).toBe('flag');
  });

  test('DIOPTRA_ALLOW_FOREIGN_ROOT=1 trusts without markers', () => {
    const d = evaluateRootTrust(root, {
      env: { DIOPTRA_ALLOW_FOREIGN_ROOT: '1' },
      homeDir: fakeHome,
    });
    expect(d.trusted).toBe(true);
    expect(d.level).toBe('env');
  });

  test('allow-list record trusts without markers', () => {
    plantAllowedRoot(root, fakeHome);
    expect(allowedRootsPath(fakeHome)).toContain('.dioptra');
    const d = evaluateRootTrust(root, { env: {}, homeDir: fakeHome });
    expect(d.trusted).toBe(true);
    expect(d.level).toBe('allow-list');
  });
});

describe('mutation regression cases', () => {
  test('mutation against foreign root refuses with remedy text', () => {
    expect(() => assertMutationTrust(root, { env: {}, homeDir: fakeHome })).toThrow(RegulaError);
    try {
      assertMutationTrust(root, { env: {}, homeDir: fakeHome });
    } catch (e) {
      expect(e).toBeInstanceOf(RegulaError);
      const msg = (e as RegulaError).message;
      expect(msg).toContain('REFUSING mutation');
      expect(msg).toContain('--allow-foreign-root');
      expect(msg).toContain('DIOPTRA_ALLOW_FOREIGN_ROOT=1');
    }
  });

  test('mutation against foreign root + flag proceeds', () => {
    expect(() =>
      assertMutationTrust(root, { allowForeignRoot: true, env: {}, homeDir: fakeHome }),
    ).not.toThrow();
  });

  test('read path: evaluateRootTrust is not required — foreign root stays untrusted for mutation only', () => {
    // Documented contract: READ ops never call the guard. Untrusted decision must not
    // block a caller that simply doesn't invoke assert/ensure.
    const d = evaluateRootTrust(root, { env: {}, homeDir: fakeHome });
    expect(d.trusted).toBe(false);
    // no throw — reads ignore this
  });

  test('allow-record path works', async () => {
    plantAllowedRoot(root, fakeHome);
    await ensureMutationTrust(root, { env: {}, homeDir: fakeHome, interactive: false });
    // if it didn't throw, allow-record path succeeded
  });

  test('non-TTY interactive prompt attempt fails closed with instruction', async () => {
    await expect(
      ensureMutationTrust(root, {
        env: {},
        homeDir: fakeHome,
        interactive: true,
        isTty: false,
        requireTtyForPrompt: true,
      }),
    ).rejects.toThrow(/non-interactive session cannot prompt/);
    await expect(
      ensureMutationTrust(root, {
        env: {},
        homeDir: fakeHome,
        interactive: true,
        isTty: false,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('--allow-foreign-root'),
    });
  });

  test('TTY interactive confirm plants allow-list and proceeds', async () => {
    const decision = await ensureMutationTrust(root, {
      env: {},
      homeDir: fakeHome,
      interactive: true,
      isTty: true,
      confirm: () => true,
    });
    expect(decision.trusted).toBe(true);
    expect(decision.level).toBe('allow-list');
    // subsequent non-interactive call succeeds via allow-list
    await ensureMutationTrust(root, { env: {}, homeDir: fakeHome, interactive: false });
  });

  test('TTY interactive decline refuses with remedy', async () => {
    await expect(
      ensureMutationTrust(root, {
        env: {},
        homeDir: fakeHome,
        interactive: true,
        isTty: true,
        confirm: () => false,
      }),
    ).rejects.toThrow(/REFUSING mutation/);
  });
});
