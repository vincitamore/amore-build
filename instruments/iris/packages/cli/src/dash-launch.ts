/**
 * Launch the OpenTUI dashboard — the span. Resolve the TUI entry (sibling
 * package, org-root fallback), wrap the child's stderr in a crash log, and
 * propagate its exit code (annotating native crashes).
 *
 * Consumed by bare `iris` / `iris dash` (not a global `iris` bin).
 * Org-write verbs live under `iris <verb>` via
 * `@amore/regula`; the span names the viewing surface.
 */
import { EXIT, fail } from './contract';

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Resolve the TUI entry the dash WOULD spawn: the sibling `tui` package first,
 * falling back to the org-root-relative path. Returns the resolved path even when
 * it does not exist on disk (matching the original's "looked at ${entry}" report).
 * Single-sources the resolution so glass `--print-entry` can report the target
 * without launching.
 */
export async function resolveTuiEntry(): Promise<string> {
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');
  const { resolveOrgRoot } = await import('./org-root');
  let entry = join(import.meta.dir, '../../tui/src/index.tsx'); // sibling package (resolved path)
  if (!existsSync(entry)) {
    const org = resolveOrgRoot();
    if (org) entry = join(org, 'instruments/iris/packages/tui/src/index.tsx'); // fallback via org root
  }
  return entry;
}

/**
 * Launch the interactive OpenTUI dashboard. It takes over the terminal (raw mode,
 * mouse) — not the JSON contract — so it is a spawned process, not a verb. Never
 * returns: always ends in `process.exit`.
 */
export async function launchDash(passthroughArgs: string[] = []): Promise<never> {
  const { join, dirname } = await import('node:path');
  const { existsSync, mkdirSync, openSync, appendFileSync, closeSync } = await import('node:fs');
  const entry = await resolveTuiEntry();
  if (!existsSync(entry)) {
    emit(fail('NOT_FOUND', `TUI entry not found (looked at ${entry})`, 'dash'));
    process.exit(EXIT.INTERNAL);
  }
  // Capture the TUI's stderr to a crash log. A native segfault bypasses Bun's JS handlers, but
  // Bun's own crash handler still prints a stack trace (and a symbolicated remap URL) to stderr —
  // which the alt-screen exit/terminal reset would otherwise eat. stdout stays inherited (the
  // render). On exit we record the code; a huge code (e.g. Windows access violation 0xC0000005 =
  // 3221225477) flags a native crash. Pair with <iris-home>/tui-debug.log (the dlog breadcrumbs).
  const { resolveIrisHome } = await import('@amore/regula');
  const crashLog = join(resolveIrisHome(), 'tui-crash.log');
  let errFd: number | undefined;
  try {
    mkdirSync(dirname(crashLog), { recursive: true });
    appendFileSync(crashLog, `\n===== dash start ${new Date().toISOString()} =====\n`);
    errFd = openSync(crashLog, 'a');
  } catch {
    // best-effort — fall back to inherited stderr if the log can't be opened
  }
  const proc = Bun.spawn(['bun', entry, ...passthroughArgs], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: errFd ?? 'inherit',
  });
  const code = await proc.exited;
  if (errFd !== undefined) {
    try {
      const native = typeof code === 'number' && code > 1_000_000;
      appendFileSync(
        crashLog,
        `===== dash exit code=${code}${native ? ' (NATIVE CRASH — likely segfault / access violation)' : ''} ${new Date().toISOString()} =====\n`,
      );
      closeSync(errFd);
    } catch {
      // best-effort
    }
  }
  process.exit(code);
}
