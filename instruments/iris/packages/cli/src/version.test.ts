import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { IRIS_VERSION, versionLine } from './version';
import pkg from '../package.json';

const INDEX = join(import.meta.dir, 'index.ts');
const IRIS_BIN = join(import.meta.dir, 'iris.ts');

describe('version', () => {
  test('versionLine matches package.json (not hardcoded)', () => {
    expect(IRIS_VERSION).toBe(pkg.version);
    expect(versionLine()).toBe(`iris ${pkg.version}`);
    expect(versionLine()).toMatch(/^iris \d+\.\d+\.\d+/);
  });

  test('cli --version prints iris <x.y.z> and exits 0', () => {
    const r = Bun.spawnSync(['bun', 'run', INDEX, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(`iris ${pkg.version}`);
  });

  test('cli -V prints the same line', () => {
    const r = Bun.spawnSync(['bun', 'run', INDEX, '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(`iris ${pkg.version}`);
  });

  test('cli version (bare verb) prints the same line', () => {
    const r = Bun.spawnSync(['bun', 'run', INDEX, 'version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(`iris ${pkg.version}`);
  });

  test('workspace bin iris.ts --version works without house or daemon', () => {
    const r = Bun.spawnSync(['bun', 'run', IRIS_BIN, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: join(import.meta.dir, '..', '..', '..', '..'), // outside any house
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString().trim()).toBe(`iris ${pkg.version}`);
  });
});
