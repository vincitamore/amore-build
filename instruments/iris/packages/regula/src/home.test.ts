import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import {
  IRIS_HOME_ENV,
  LEGACY_DIR_NAME,
  MIGRATED_FROM_MARKER,
  MIGRATION_LOCK_NAME,
  MOVED_POINTER,
  defaultIrisHome,
  legacyIrisHome,
  migrateLegacyHome,
  resetIrisHomeCache,
  resolveIrisHome,
  resolveIrisHomeDetailed,
} from './home';

function tempUserHome(): string {
  const base = join(tmpdir(), `iris-home-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

function writeLegacyTree(legacy: string, files: Record<string, string>): void {
  mkdirSync(legacy, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const full = join(legacy, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf-8');
  }
}

describe('resolveIrisHome order', () => {
  let userHome: string;
  const logs: string[] = [];

  beforeEach(() => {
    resetIrisHomeCache();
    userHome = tempUserHome();
    logs.length = 0;
  });

  afterEach(() => {
    resetIrisHomeCache();
    rmSync(userHome, { recursive: true, force: true });
  });

  test('IRIS_HOME env wins over new and legacy', () => {
    const envHome = join(userHome, 'custom-iris');
    const legacy = legacyIrisHome(userHome);
    const neu = defaultIrisHome(userHome, {});
    writeLegacyTree(legacy, { 'a.txt': 'legacy' });
    mkdirSync(neu, { recursive: true });
    writeFileSync(join(neu, 'b.txt'), 'new');

    const r = resolveIrisHomeDetailed({
      userHome,
      env: { [IRIS_HOME_ENV]: envHome },
      log: (l) => logs.push(l),
    });
    expect(r.source).toBe('env');
    expect(r.path).toBe(resolve(envHome));
    expect(existsSync(envHome)).toBe(true);
  });

  test('new home preferred when present (no re-migrate)', () => {
    const legacy = legacyIrisHome(userHome);
    const neu = defaultIrisHome(userHome, {});
    writeLegacyTree(legacy, { 'old.txt': 'old' });
    mkdirSync(neu, { recursive: true });
    writeFileSync(join(neu, 'keep.txt'), 'keep');

    const r = resolveIrisHomeDetailed({
      userHome,
      env: {},
      log: (l) => logs.push(l),
    });
    expect(r.source).toBe('new');
    expect(r.path).toBe(neu);
    expect(existsSync(join(legacy, 'old.txt'))).toBe(true);
    expect(existsSync(join(neu, 'old.txt'))).toBe(false);
  });

  test('legacy present → migrate → use new home', () => {
    const legacy = legacyIrisHome(userHome);
    const neu = defaultIrisHome(userHome, {});
    writeLegacyTree(legacy, {
      'config.json': '{"theme":"dark"}',
      'nested/x.txt': 'payload',
    });

    const r = resolveIrisHomeDetailed({
      userHome,
      env: {},
      log: (l) => logs.push(l),
    });
    expect(r.source).toBe('migrated');
    expect(r.path).toBe(neu);
    expect(r.migrated).toBe(true);
    expect(readFileSync(join(neu, 'config.json'), 'utf-8')).toBe('{"theme":"dark"}');
    expect(readFileSync(join(neu, 'nested/x.txt'), 'utf-8')).toBe('payload');
    expect(existsSync(join(neu, MIGRATED_FROM_MARKER))).toBe(true);
    expect(existsSync(join(legacy, MOVED_POINTER))).toBe(true);
    // Legacy not deleted
    expect(existsSync(join(legacy, 'config.json'))).toBe(true);
    expect(logs.some((l) => l.includes('home migrated'))).toBe(true);
  });

  test('neither present → create fresh new home', () => {
    const neu = defaultIrisHome(userHome, {});
    const r = resolveIrisHomeDetailed({
      userHome,
      env: {},
      log: (l) => logs.push(l),
    });
    expect(r.source).toBe('fresh');
    expect(r.path).toBe(neu);
    expect(existsSync(neu)).toBe(true);
  });

  test('AMORE_HOME relocates the default instrument home', () => {
    const amore = join(userHome, 'alt-amore');
    const r = resolveIrisHomeDetailed({
      userHome,
      env: { AMORE_HOME: amore },
      log: (l) => logs.push(l),
    });
    expect(r.path).toBe(join(amore, 'instruments', 'iris'));
    expect(r.source).toBe('fresh');
  });
});

describe('migration copy + verify + markers', () => {
  let userHome: string;

  beforeEach(() => {
    resetIrisHomeCache();
    userHome = tempUserHome();
  });

  afterEach(() => {
    resetIrisHomeCache();
    rmSync(userHome, { recursive: true, force: true });
  });

  test('file count and byte sizes match; markers written', () => {
    const legacy = join(userHome, LEGACY_DIR_NAME);
    const neu = join(userHome, '.amore', 'instruments', 'iris');
    const bodyA = 'aaa';
    const bodyB = 'bbbbbb';
    writeLegacyTree(legacy, { 'a.txt': bodyA, 'sub/b.txt': bodyB });

    const result = migrateLegacyHome(legacy, neu);
    expect(result.ok).toBe(true);

    const marker = JSON.parse(readFileSync(join(neu, MIGRATED_FROM_MARKER), 'utf-8')) as {
      files: number;
      bytes: number;
      from: string;
    };
    expect(marker.files).toBe(2);
    expect(marker.bytes).toBe(bodyA.length + bodyB.length);
    expect(marker.from).toBe(resolve(legacy));

    const pointer = readFileSync(join(legacy, MOVED_POINTER), 'utf-8');
    expect(pointer).toContain(neu);
    expect(pointer).toContain('no longer the active');
  });
});

describe('migration lock / race', () => {
  let userHome: string;

  beforeEach(() => {
    resetIrisHomeCache();
    userHome = tempUserHome();
  });

  afterEach(() => {
    resetIrisHomeCache();
    rmSync(userHome, { recursive: true, force: true });
  });

  test('held lock without appearing home returns failure (caller falls back)', () => {
    const legacy = join(userHome, LEGACY_DIR_NAME);
    const neu = join(userHome, '.amore', 'instruments', 'iris');
    writeLegacyTree(legacy, { 'x.txt': 'x' });
    const instruments = join(userHome, '.amore', 'instruments');
    mkdirSync(instruments, { recursive: true });
    const lockPath = join(instruments, MIGRATION_LOCK_NAME);
    const fd = openSync(lockPath, 'wx');
    try {
      const logs: string[] = [];
      // Short wait path: lock held, new home never appears.
      const result = migrateLegacyHome(legacy, neu, (l) => logs.push(l));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/lock held/i);
      expect(existsSync(neu)).toBe(false);
    } finally {
      closeSync(fd);
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  test('resolve falls back to legacy when migration fails', () => {
    const legacy = legacyIrisHome(userHome);
    writeLegacyTree(legacy, { 'keep.txt': 'data' });
    const instruments = join(userHome, '.amore', 'instruments');
    mkdirSync(instruments, { recursive: true });
    const lockPath = join(instruments, MIGRATION_LOCK_NAME);
    const fd = openSync(lockPath, 'wx');
    const logs: string[] = [];
    try {
      const r = resolveIrisHomeDetailed({
        userHome,
        env: {},
        log: (l) => logs.push(l),
      });
      expect(r.source).toBe('legacy-fallback');
      expect(r.path).toBe(legacy);
      expect(r.migrationError).toBeTruthy();
      expect(logs.some((l) => l.includes('migration failed'))).toBe(true);
      // No silent split: still only legacy has the file
      expect(readFileSync(join(legacy, 'keep.txt'), 'utf-8')).toBe('data');
    } finally {
      closeSync(fd);
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe('no stray home-path literals', () => {
  test('workspace source allows .iris home segment only in home.ts', () => {
    // Walk iris packages source; forbid legacy home directory literals outside home.ts.
    // Allowed: home.ts (the resolution module). Docs and scripts are outside this package walk.
    // Also allowed: .iris-index.json (daemon index cache filename, not the user home).
    const packagesRoot = resolve(import.meta.dir, '../..');
    const offenders: string[] = [];
    // Match path-segment uses of the legacy home dir name, not words like "iris".
    const banned = [
      /['"`]\.iris['"`]/, // '.iris' / ".iris" / `.iris`
      /~\/\.iris/, // ~/.iris
      /\.iris[/\\]/, // .iris/ or .iris\
      /\.iris['"`]/, // trailing in strings like ~/.iris"
    ];

    function walk(dir: string): void {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        if (ent.name === 'node_modules' || ent.name === 'dist') continue;
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ent.name)) continue;
        // Sole resolution module may name the legacy path.
        if (ent.name === 'home.ts' && full.endsWith(`${sep}home.ts`)) continue;
        // This test file mentions patterns under test.
        if (ent.name === 'home.test.ts') continue;
        const text = readFileSync(full, 'utf-8');
        // Strip the daemon index cache name so it does not trip the scan.
        const scrubbed = text.replace(/\.iris-index\.json/g, '.INDEX-CACHE.json');
        for (const re of banned) {
          if (re.test(scrubbed)) {
            const rel = relative(packagesRoot, full);
            offenders.push(`${rel} matches ${re}`);
            break;
          }
        }
      }
    }

    walk(packagesRoot);
    expect(offenders).toEqual([]);
  });
});

describe('resolveIrisHome convenience', () => {
  let userHome: string;

  beforeEach(() => {
    resetIrisHomeCache();
    userHome = tempUserHome();
  });

  afterEach(() => {
    resetIrisHomeCache();
    rmSync(userHome, { recursive: true, force: true });
  });

  test('returns path string', () => {
    const p = resolveIrisHome({ userHome, env: {} });
    expect(typeof p).toBe('string');
    expect(p).toContain(join('instruments', 'iris'));
  });
});

