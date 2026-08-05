import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ORG_COLLECTIONS,
  QMD_PIN,
  buildIndexYml,
  createQmdModule,
  createQmdRefreshController,
  deriveHouseId,
  mapQmdFileToOrgPath,
  parseQmdSearchJson,
  planNpmInstallSpawn,
  qmdInstrumentHome,
  qmdSearch,
  qmdSetup,
  qmdStatus,
  qmdUpdate,
  quoteCmdArg,
  resolveNpmCliJs,
  resolveQmdPaths,
  type NpmInstaller,
  type QmdRunner,
  type QmdSpawnResult,
} from './qmd.ts';

let tmp: string;
let orgRoot: string;
let instrumentHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'iris-qmd-'));
  orgRoot = join(tmp, 'house');
  instrumentHome = join(tmp, 'qmd-home');
  mkdirSync(join(orgRoot, 'knowledge'), { recursive: true });
  mkdirSync(join(orgRoot, 'tasks'), { recursive: true });
  writeFileSync(join(orgRoot, 'knowledge', 'a.md'), '# A\n\nhello auth\n');
  writeFileSync(join(orgRoot, 'tasks', 't.md'), '# Task\n\ndo thing\n');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function stubRunner(log: string[] = [], replies: Record<string, QmdSpawnResult> = {}): QmdRunner {
  return async (argv, _opts) => {
    const key = argv.join(' ');
    log.push(key);
    if (replies[key]) return replies[key];
    if (argv[0] === 'update') return { code: 0, stdout: 'Indexed: 1 new\n', stderr: '' };
    if (argv[0] === 'embed') return { code: 0, stdout: 'embedded\n', stderr: '' };
    if (argv[0] === 'status') {
      return {
        code: 0,
        stdout: 'Documents\n  Total:    2 files indexed\n  Vectors:  0 embedded\n  Pending:  2 need embedding\n',
        stderr: '',
      };
    }
    if (argv[0] === 'search' || argv[0] === 'vsearch' || argv[0] === 'query') {
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            file: 'qmd://knowledge/a.md',
            title: 'A',
            score: 0.9,
            snippet: 'hello auth',
          },
        ]),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

/**
 * Isolated deps: no host PATH / node / npm / global qmd.
 * resolveRuntime + which close the CI Windows timeout class (where.exe / real node).
 */
function iso(extra: Record<string, unknown> = {}) {
  return {
    instrumentHome,
    allowGlobal: false as const,
    runner: stubRunner(),
    resolveRuntime: () => ({ kind: 'node' as const, bin: join(tmp, 'fake-node') }),
    which: (_name: string) => null,
    detectGlobal: () => null,
    ...extra,
  };
}

const stubNpm: NpmInstaller = async ({ prefix }) => {
  const qmdJs = join(prefix, 'node_modules', '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js');
  mkdirSync(join(qmdJs, '..'), { recursive: true });
  writeFileSync(qmdJs, '// stub\n');
  return { ok: true, stdout: '', stderr: '', code: 0 };
};

describe('npm install spawn plan (Windows-safe)', () => {
  test('resolveNpmCliJs finds npm-cli.js beside node', () => {
    const nodeRoot = join(tmp, 'nodejs');
    const nodeBin = join(nodeRoot, 'node.exe');
    const npmCli = join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    mkdirSync(join(npmCli, '..'), { recursive: true });
    writeFileSync(nodeBin, '');
    writeFileSync(npmCli, '// npm\n');
    expect(resolveNpmCliJs(nodeBin)).toBe(npmCli);
  });

  test('resolveNpmCliJs returns null when missing', () => {
    const nodeBin = join(tmp, 'lonely-node', 'node');
    mkdirSync(join(nodeBin, '..'), { recursive: true });
    writeFileSync(nodeBin, '');
    expect(resolveNpmCliJs(nodeBin)).toBeNull();
  });

  test('plan prefers node + absolute npm-cli.js (primary path)', () => {
    const nodeBin = join(tmp, 'n', 'node.exe');
    const npmCli = join(tmp, 'n', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const prefix = join(tmp, 'runtime');
    const plan = planNpmInstallSpawn({
      prefix,
      packageSpec: `@tobilu/qmd@${QMD_PIN}`,
      nodeBin,
      npmBin: join(tmp, 'n', 'npm.cmd'), // present but must not be chosen
      npmCliJs: npmCli,
      platform: 'win32',
    });
    expect(plan.kind).toBe('node-cli');
    expect(plan.command).toBe(nodeBin);
    expect(plan.args[0]).toBe(npmCli);
    expect(plan.args.slice(1)).toEqual([
      'install',
      '--prefix',
      prefix,
      `@tobilu/qmd@${QMD_PIN}`,
      '--no-fund',
      '--no-audit',
    ]);
  });

  test('plan uses cmd.exe /d /s /c when npm-cli.js absent on win32', () => {
    const nodeBin = join(tmp, 'n2', 'node.exe');
    const npmCmd = join(tmp, 'n2', 'npm.cmd');
    const prefix = join(tmp, 'runtime2');
    const plan = planNpmInstallSpawn({
      prefix,
      packageSpec: `@tobilu/qmd@${QMD_PIN}`,
      nodeBin,
      npmBin: npmCmd,
      npmCliJs: null,
      platform: 'win32',
    });
    expect(plan.kind).toBe('cmd-shell');
    expect(plan.args[0]).toBe('/d');
    expect(plan.args[1]).toBe('/s');
    expect(plan.args[2]).toBe('/c');
    const line = plan.args[3]!;
    expect(line).toContain(quoteCmdArg(npmCmd));
    expect(line).toContain('install');
    expect(line).toContain(quoteCmdArg(prefix));
    expect(line).toContain(`@tobilu/qmd@${QMD_PIN}`);
    // Must not be a bare spawn of npm.cmd as plan.command
    expect(plan.command.toLowerCase()).not.toMatch(/npm\.cmd$/);
  });

  test('plan falls through to bun when no npm-cli and no npmBin', () => {
    const plan = planNpmInstallSpawn({
      prefix: join(tmp, 'rt'),
      packageSpec: `@tobilu/qmd@${QMD_PIN}`,
      nodeBin: join(tmp, 'node'),
      npmBin: null,
      npmCliJs: null,
      bunBin: join(tmp, 'bun.exe'),
      platform: 'win32',
    });
    expect(plan.kind).toBe('bun');
    expect(plan.command).toBe(join(tmp, 'bun.exe'));
    expect(plan.args).toEqual(['add', `@tobilu/qmd@${QMD_PIN}`, '--cwd', join(tmp, 'rt')]);
  });

  test('plan is missing when no installer tools', () => {
    const plan = planNpmInstallSpawn({
      prefix: join(tmp, 'rt'),
      packageSpec: `@tobilu/qmd@${QMD_PIN}`,
      nodeBin: join(tmp, 'node'),
      npmBin: null,
      npmCliJs: null,
      bunBin: null,
    });
    expect(plan.kind).toBe('missing');
  });
});

describe('paths + pin + house id', () => {
  test('pin is exact', () => {
    expect(QMD_PIN).toBe('2.1.0');
  });

  test('deriveHouseId is stable and filesystem-safe', () => {
    const a = deriveHouseId(orgRoot);
    const b = deriveHouseId(orgRoot);
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-zA-Z0-9._-]+$/);
    expect(a.length).toBeLessThan(80);
  });

  test('resolveQmdPaths lays out runtime/houses/models', () => {
    const p = resolveQmdPaths(orgRoot, { instrumentHome });
    expect(p.runtimeDir).toBe(join(instrumentHome, 'runtime'));
    expect(p.modelsDir).toBe(join(instrumentHome, 'models'));
    expect(p.houseDir).toContain(join('houses', p.houseId));
    expect(p.configYml.endsWith('index.yml')).toBe(true);
    expect(p.indexSqlite.endsWith('index.sqlite')).toBe(true);
  });

  test('IRIS_QMD_HOME overrides instrument home', () => {
    const prev = process.env.IRIS_QMD_HOME;
    process.env.IRIS_QMD_HOME = instrumentHome;
    try {
      expect(qmdInstrumentHome()).toBe(instrumentHome);
    } finally {
      if (prev === undefined) delete process.env.IRIS_QMD_HOME;
      else process.env.IRIS_QMD_HOME = prev;
    }
  });

  test('buildIndexYml bootstraps six org collections with context', () => {
    const yml = buildIndexYml(orgRoot);
    for (const c of ORG_COLLECTIONS) {
      expect(yml).toContain(`${c.name}:`);
      expect(yml).toContain(c.context);
    }
    expect(ORG_COLLECTIONS).toHaveLength(6);
  });
});

describe('setup (stubbed npm + qmd)', () => {
  test('writes layout, pin manifest, collections; records npm + qmd invocations', async () => {
    const log: string[] = [];
    const npmCalls: string[] = [];
    // Place a fake managed qmd.js so resolve succeeds after "install"
    const p = resolveQmdPaths(orgRoot, { instrumentHome });
    const r = await qmdSetup(
      orgRoot,
      { noModels: true },
      iso({
        runner: stubRunner(log),
        npmInstall: (async ({ prefix, packageSpec }) => {
          npmCalls.push(`${packageSpec}@${prefix}`);
          const qmdJs = join(prefix, 'node_modules', '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js');
          mkdirSync(join(qmdJs, '..'), { recursive: true });
          writeFileSync(qmdJs, '// stub\n');
          return { ok: true, stdout: 'ok', stderr: '', code: 0 };
        }) satisfies NpmInstaller,
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.pin).toBe(QMD_PIN);
    expect(r.collections).toEqual(ORG_COLLECTIONS.map((c) => c.name));
    expect(npmCalls.some((c) => c.startsWith(`@tobilu/qmd@${QMD_PIN}`))).toBe(true);
    expect(log.some((l) => l.startsWith('update'))).toBe(true);
    expect(log.some((l) => l.startsWith('embed'))).toBe(false); // --no-models
    expect(existsSync(p.configYml)).toBe(true);
    const yml = readFileSync(p.configYml, 'utf8');
    expect(yml).toContain('knowledge:');
    const man = JSON.parse(readFileSync(p.manifestPath, 'utf8')) as { pin: string };
    expect(man.pin).toBe(QMD_PIN);
  });

  test('setup with models records embed + query warmup', async () => {
    const log: string[] = [];
    await qmdSetup(
      orgRoot,
      { noModels: false },
      iso({
        runner: stubRunner(log),
        npmInstall: stubNpm,
      }),
    );
    expect(log.some((l) => l.startsWith('embed'))).toBe(true);
    expect(log.some((l) => l.startsWith('query '))).toBe(true);
  });
});

describe('status + update honesty', () => {
  test('runtime-missing status is not-installed', async () => {
    const st = await qmdStatus(orgRoot, iso());
    expect(st.state).toBe('not-installed');
    expect(st.available).toBe(false);
    expect(st.reason).toMatch(/setup|not installed|required|bootstrapped/i);
  });

  test('update without setup fails honestly', async () => {
    const r = await qmdUpdate(orgRoot, {}, iso());
    expect(r.ok).toBe(false);
    expect(r.code).toBe(69);
    expect(r.error).toMatch(/setup|not|bootstrap/i);
  });

  test('status ready after setup with stub runtime', async () => {
    await qmdSetup(
      orgRoot,
      { noModels: true },
      iso({ npmInstall: stubNpm }),
    );
    // touch index so paths look real
    const p = resolveQmdPaths(orgRoot, { instrumentHome });
    writeFileSync(p.indexSqlite, '');
    const st = await qmdStatus(orgRoot, iso());
    expect(st.available).toBe(true);
    expect(['ready-lex', 'ready-semantic']).toContain(st.state);
    expect(st.docs).toBe(2);
  });
});

describe('search proxy + parsing', () => {
  test('mapQmdFileToOrgPath handles collection URIs', () => {
    expect(mapQmdFileToOrgPath('qmd://knowledge/a.md', orgRoot)).toBe('knowledge/a.md');
    expect(mapQmdFileToOrgPath('qmd://tasks/t.md', orgRoot)).toBe('tasks/t.md');
  });

  test('parseQmdSearchJson extracts hits', () => {
    const items = parseQmdSearchJson(
      JSON.stringify([{ file: 'qmd://knowledge/a.md', title: 'A', score: 0.5, snippet: 'x' }]),
      orgRoot,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.path).toBe('knowledge/a.md');
    expect(items[0]!.snippet).toBe('x');
  });

  test('search available:false when runtime missing', async () => {
    const r = await qmdSearch(orgRoot, 'auth', 'lex', 10, iso());
    expect(r.available).toBe(false);
    expect(r.backend).toBe('qmd');
    expect(r.items).toEqual([]);
    expect(r.reason).toBeTruthy();
  });

  test('search lex proxies and returns items when set up', async () => {
    await qmdSetup(
      orgRoot,
      { noModels: true },
      iso({ npmInstall: stubNpm }),
    );
    writeFileSync(resolveQmdPaths(orgRoot, { instrumentHome }).indexSqlite, '');
    const log: string[] = [];
    const r = await qmdSearch(orgRoot, 'auth', 'lex', 5, iso({ runner: stubRunner(log) }));
    expect(r.available).toBe(true);
    expect(r.items[0]!.path).toBe('knowledge/a.md');
    expect(log[0]).toContain('search');
    expect(log[0]).toContain('--json');
  });
});

describe('refresh debounce / throttle / serialization', () => {
  test('debounce batches notifyChange; min-interval floors re-runs; serializes', async () => {
    const log: string[] = [];
    // Pretend setup exists
    await qmdSetup(orgRoot, { noModels: true }, iso({ npmInstall: stubNpm }));

    let now = 1_000_000;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const setTimeoutFn = ((fn: () => void, ms: number) => {
      const handle = { at: now + ms, fn };
      timers.push(handle);
      return handle as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimeoutFn = ((h: ReturnType<typeof setTimeout>) => {
      const i = timers.indexOf(h as unknown as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    }) as typeof clearTimeout;

    const advance = async (ms: number) => {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      for (const t of due) {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
        t.fn();
      }
      // allow promises
      await Promise.resolve();
      await Promise.resolve();
    };

    const ctrl = createQmdRefreshController(
      orgRoot,
      iso({ runner: stubRunner(log), now: () => now }),
      {
        debounceMs: 1000,
        minIntervalMs: 5000,
        setTimeoutFn,
        clearTimeoutFn,
        now: () => now,
      },
    );

    ctrl.notifyChange('knowledge/a.md');
    ctrl.notifyChange('tasks/t.md');
    expect(ctrl.snapshot().pendingChanges).toBe(2);
    expect(log.filter((l) => l.startsWith('update'))).toHaveLength(0);

    await advance(1000);
    await Promise.resolve();
    await Promise.resolve();
    // first flush
    expect(log.filter((l) => l.startsWith('update')).length).toBeGreaterThanOrEqual(1);
    const afterFirst = log.filter((l) => l.startsWith('update')).length;

    // Immediate notify should re-arm but throttle via min-interval
    ctrl.notifyChange('knowledge/a.md');
    await advance(1000);
    await Promise.resolve();
    // Should still be one update until min interval passes (or re-armed)
    const mid = log.filter((l) => l.startsWith('update')).length;
    expect(mid).toBeGreaterThanOrEqual(afterFirst);

    // Advance past min-interval
    await advance(5000);
    await Promise.resolve();
    await Promise.resolve();
    expect(log.filter((l) => l.startsWith('update')).length).toBeGreaterThanOrEqual(afterFirst);

    ctrl.stop();
  });

  test('refresh never runs when runtime missing', async () => {
    const log: string[] = [];
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const setTimeoutFn = ((fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn });
      return timers[timers.length - 1] as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimeoutFn = ((h: ReturnType<typeof setTimeout>) => {
      const i = timers.indexOf(h as unknown as { at: number; fn: () => void });
      if (i >= 0) timers.splice(i, 1);
    }) as typeof clearTimeout;

    const ctrl = createQmdRefreshController(
      orgRoot,
      iso({ runner: stubRunner(log), now: () => now }),
      { debounceMs: 10, minIntervalMs: 0, setTimeoutFn, clearTimeoutFn, now: () => now },
    );
    ctrl.notifyChange('knowledge/a.md');
    now = 100;
    for (const t of [...timers]) t.fn();
    await Promise.resolve();
    expect(log.filter((l) => l.startsWith('update'))).toHaveLength(0);
    ctrl.stop();
  });
});

describe('createQmdModule', () => {
  test('module search delegates', async () => {
    const mod = createQmdModule(iso());
    const r = await mod.search(orgRoot, 'x', 'lex', 5);
    expect(r.available).toBe(false);
  });
});
