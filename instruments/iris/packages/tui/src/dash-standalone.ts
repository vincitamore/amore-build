#!/usr/bin/env bun
/**
 * Compiled-binary entry for the OpenTUI dash only.
 *
 * Built as `dist/iris-dash-{os}-{arch}[.exe]` via scripts/build-compile.ts --with-dash.
 * Relies on Bun embedding OpenTUI's platform native lib (`opentui.dll` / `.so` / `.dylib`)
 * through the package's `import … with { type: "file" }` export.
 *
 * Daemon auto-spawn: set `$IRIS_DAEMON_BIN` to the multi-tool
 * `iris-{os}-{arch}`, or place it beside this binary (see resolveDaemonCommand).
 *
 * TTY required for a usable interactive session; headless boots may paint
 * without a real terminal and should not be treated as a smoke pass alone.
 *
 * --version is handled before the TUI boots so release/CI can assert the
 * compile-time companion stamp without needing a TTY or org root.
 */
declare const __COMPANION_VERSION__: string | undefined;

import cliPkg from '../../cli/package.json';

const dashArgv = process.argv.slice(2);
if (dashArgv[0] === '--version' || dashArgv[0] === '-V' || dashArgv[0] === 'version') {
  const v =
    (typeof __COMPANION_VERSION__ !== 'undefined' && __COMPANION_VERSION__) ||
    (typeof cliPkg.version === 'string' && cliPkg.version) ||
    '0.0.0';
  process.stdout.write(`iris-dash ${v}\n`);
  process.exit(0);
}

await import('./index.tsx');