import { spawn } from 'node:child_process';

/**
 * Copy text to the OS clipboard — app-driven, so it captures the EXACT content (no terminal-side
 * linear selection that drags in pane borders / adjacent panes). Windows: `clip.exe`; macOS:
 * `pbcopy`; Linux: `xclip`. Returns false if no copy tool could be spawned.
 *
 * (OSC52 — writing `]52;c;<base64>` to stdout — would also work and reach a remote/SSH clipboard,
 * but emitting an escape sequence mid-render risks corrupting the alt-screen; left for a follow-up
 * that suspends rendering around the write. clip.exe covers the Windows-primary case cleanly.)
 */
export function copyText(text: string): boolean {
  const cmd = process.platform === 'win32' ? 'clip.exe' : process.platform === 'darwin' ? 'pbcopy' : 'xclip';
  const args = process.platform === 'linux' ? ['-selection', 'clipboard'] : [];
  try {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {}); // swallow the async ENOENT emit so a missing tool can't crash the process
    // A missing copy tool leaves `pid` undefined synchronously (verified on Bun) — report that as a
    // real failure instead of the old optimistic true (which flashed "✓ copied" on Linux w/o xclip).
    if (p.pid === undefined) return false;
    p.stdin?.write(text, 'utf8');
    p.stdin?.end();
    return true;
  } catch {
    return false;
  }
}
