import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMANDS, resolveCommand } from './commands.ts';
import {
  QMD_PIN,
  qmdExit,
  qmdSetupHuman,
  qmdStatusHuman,
  runQmdSetup,
  runQmdStatus,
  runQmdUpdate,
  setQmdTestDeps,
} from './qmd.ts';
import type { QmdRunner } from '../../daemon/src/proxies/qmd.ts';

let tmp: string;
let orgRoot: string;
let instrumentHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'iris-cli-qmd-'));
  orgRoot = join(tmp, 'house');
  instrumentHome = join(tmp, 'qmd-home');
  mkdirSync(join(orgRoot, 'knowledge'), { recursive: true });
  writeFileSync(join(orgRoot, 'knowledge', 'a.md'), '# A\n');
});

afterEach(() => {
  setQmdTestDeps(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

function stubRunner(): QmdRunner {
  return async (argv) => {
    if (argv[0] === 'update') return { code: 0, stdout: 'ok', stderr: '' };
    if (argv[0] === 'embed') return { code: 0, stdout: 'ok', stderr: '' };
    if (argv[0] === 'status') {
      return {
        code: 0,
        stdout: 'Documents\n  Total:    1 files indexed\n  Vectors:  0 embedded\n  Pending:  1 need embedding\n',
        stderr: '',
      };
    }
    if (argv[0] === 'query') return { code: 0, stdout: '[]', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

describe('iris qmd verbs', () => {
  test('commands resolve setup/status/update', () => {
    expect(resolveCommand(['qmd', 'setup'])).toMatchObject({
      spec: { name: 'qmd setup' },
    });
    expect(resolveCommand(['qmd', 'status'])).toMatchObject({
      spec: { name: 'qmd status' },
    });
    expect(resolveCommand(['qmd', 'update'])).toMatchObject({
      spec: { name: 'qmd update' },
    });
  });

  test('boolean flags registered', () => {
    const setup = COMMANDS.find((c) => c.name === 'qmd setup')!;
    expect(setup.booleanFlags).toEqual(expect.arrayContaining(['no-models', 'use-global']));
    const upd = COMMANDS.find((c) => c.name === 'qmd update')!;
    expect(upd.booleanFlags).toContain('embed');
  });

  /** Hermetic deps: never walk host PATH or spawn real node/npm (CI Windows). */
  function hermetic(extra: Record<string, unknown> = {}) {
    return {
      instrumentHome,
      allowGlobal: false as const,
      runner: stubRunner(),
      resolveRuntime: () => ({ kind: 'node' as const, bin: join(tmp, 'fake-node') }),
      which: (_name: string) => null as string | null,
      detectGlobal: () => null as string | null,
      ...extra,
    };
  }

  test('setup --no-models --json shape', async () => {
    setQmdTestDeps(
      hermetic({
        npmInstall: async ({ prefix, packageSpec }: { prefix: string; packageSpec: string }) => {
          expect(packageSpec).toBe(`@tobilu/qmd@${QMD_PIN}`);
          const qmdJs = join(prefix, 'node_modules', '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js');
          mkdirSync(join(qmdJs, '..'), { recursive: true });
          writeFileSync(qmdJs, '// stub\n');
          return { ok: true, stdout: '', stderr: '', code: 0 };
        },
      }),
    );
    const payload = await runQmdSetup(orgRoot, {
      positional: [],
      flags: { 'no-models': true },
    });
    expect(payload.ok).toBe(true);
    expect(payload.pin).toBe(QMD_PIN);
    expect(payload.collections).toEqual(
      expect.arrayContaining(['knowledge', 'tasks', 'inbox', 'forge', 'context', 'reminders']),
    );
    expect(Array.isArray(payload.steps)).toBe(true);
    expect(qmdExit(payload)).toBe(0);
    expect(qmdSetupHuman(payload)).toMatch(/qmd setup ok/);
  });

  test('status --json when missing runtime', async () => {
    setQmdTestDeps(hermetic());
    const payload = await runQmdStatus(orgRoot, { positional: [], flags: {} });
    expect(payload.state).toBe('not-installed');
    expect(payload.available).toBe(false);
    expect(qmdStatusHuman(payload)).toMatch(/qmd:/);
  });

  test('update without setup exits unavailable path', async () => {
    setQmdTestDeps(hermetic());
    const payload = await runQmdUpdate(orgRoot, { positional: [], flags: {} });
    expect(payload.ok).toBe(false);
    expect(qmdExit(payload)).toBe(69);
  });
});

describe('search mode re-enable', () => {
  test('accepts lex|vec|query|index; rejects bogus', async () => {
    const spec = COMMANDS.find((c) => c.name === 'search')!;
    await expect(
      spec.run({
        orgRoot: '/nonexistent',
        args: { positional: ['q'], flags: { mode: 'bogus' } },
      }),
    ).rejects.toThrow(/mode/);
    // valid modes fail later on daemon — but mode validation passes (daemon error)
    // We only assert USAGE for invalid mode strings.
    expect(spec.flags.mode).toMatch(/index\|lex\|vec\|query/);
  });
});
