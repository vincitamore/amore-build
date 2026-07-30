import { setMaxListeners } from 'node:events';
import { createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';
import { Shell } from './shell/Shell';
import { ThemeProvider } from './ThemeProvider';
import { registerCodeGrammars } from './code-grammars';
import { resolveOrgRoot } from './daemon';
import { dlog, installCrashHandlers } from './debug';

// Every member is mounted at boot (keep-mounted-toggle-visible — no mount/unmount on switch), so
// each member's `useKeyboard` registers a listener on OpenTUI's key EventTarget at once. That's a
// bounded, expected count (~one per member + overlays), not a leak — raise the cap so Node doesn't
// warn. Set before the renderer is created so the key handler inherits it.
setMaxListeners(64);

installCrashHandlers(); // crash-context logging (DIOPTRA_TUI_DEBUG=1 → ~/.dioptra/tui-debug.log)
dlog('boot', 'createCliRenderer');

// Register extra tree-sitter grammars (rust/python/bash/go/…) so the code view highlights
// our project languages, not just the bundled TS/JS/Zig.
registerCodeGrammars();

// Refuse to start outside the org tree rather than scaffolding into a random cwd (mirrors the CLI).
// Resolve BEFORE createCliRenderer takes the terminal so the refusal is a clean stderr line + exit
// (a throw mid-render would leave the terminal in raw mode with a cryptic error).
try {
  resolveOrgRoot();
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(64);
}

// Mount immediately — the Shell ensures/spawns its own daemon and shows the animated loading
// skeleton while the graph fetches + lays out, then drops into the member-bar dashboard. The
// Shell root box fills the buffer with `width/height "100%"`, so no explicit sizing is needed here.
const renderer = await createCliRenderer({
  targetFps: 30,
  exitOnCtrlC: true,
  useMouse: true,
  enableMouseMovement: true,
});

// Crash-context breadcrumb: log every raw resize event (no React churn — plain stdout listener).
// Resize is a prime native-UAF suspect (buffer realloc racing the render walk); at crash time the
// debug log then shows whether a resize burst preceded the death moment (A0 investigation, 2026-07-02).
process.stdout.on('resize', () => dlog('resize', `${process.stdout.columns}x${process.stdout.rows}`));

function quit(): void {
  try {
    (renderer as { destroy?: () => void }).destroy?.();
  } catch {
    // ignore teardown errors
  }
  process.exit(0);
}

createRoot(renderer).render(
  <ThemeProvider>
    <Shell onQuit={quit} />
  </ThemeProvider>,
);
