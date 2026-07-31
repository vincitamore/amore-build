import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Crash-context logger. OFF unless IRIS_TUI_DEBUG is set. Writes synchronously (so the
// last line survives a native segfault) to ~/.iris/tui-debug.log. Used to identify what
// the TUI was doing at crash time — member switches, directory reads, render-rate bursts
// (a runaway re-render loop is a prime suspect for native-renderer crashes).

// On by default while we chase native segfaults — set IRIS_TUI_DEBUG=0 to silence.
const ENABLED = process.env.IRIS_TUI_DEBUG !== '0';
const DIR = join(homedir(), '.iris');
const FILE = join(DIR, 'tui-debug.log');
let started = false;

function ensure(): void {
  if (started) return;
  started = true;
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(FILE, `\n==== TUI start ${new Date().toISOString()} pid=${process.pid} ====\n`);
  } catch {
    // best-effort
  }
}

export function dlog(area: string, msg: string): void {
  if (!ENABLED) return;
  ensure();
  try {
    appendFileSync(FILE, `${Date.now()} ${area} ${msg}\n`);
  } catch {
    // best-effort
  }
}

// Per-area render-rate tracker: logs renders/sec (so a runaway loop shows as a huge number).
const rate = new Map<string, { n: number; t: number; logged: number }>();
export function tickRender(area: string): void {
  if (!ENABLED) return;
  const now = Date.now();
  let c = rate.get(area);
  if (!c) {
    c = { n: 0, t: now, logged: 0 };
    rate.set(area, c);
  }
  c.n += 1;
  // Burst alarm: if a single area renders absurdly fast, flag it immediately.
  if (c.n - c.logged >= 200 && now - c.t < 1000) {
    dlog('RENDER-BURST', `${area} ${c.n} renders in ${now - c.t}ms`);
    c.logged = c.n;
  }
  if (now - c.t >= 1000) {
    dlog('render', `${area} ${c.n}/s`);
    c.n = 0;
    c.t = now;
    c.logged = 0;
  }
}

/** Install process-level handlers (won't catch native segfaults, but catches JS faults). */
export function installCrashHandlers(): void {
  if (!ENABLED) return;
  ensure();
  process.on('uncaughtException', (e) => dlog('UNCAUGHT', String(e?.stack ?? e)));
  process.on('unhandledRejection', (e) => dlog('UNHANDLED', String(e)));
  process.on('exit', (code) => dlog('exit', `code=${code}`));
}
