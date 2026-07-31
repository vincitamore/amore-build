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
 */
import './index.tsx';
