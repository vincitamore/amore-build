// ─────────────────────────────────────────────────────────────────────────────
// GET /api/launch-presets — a fixed 1-element array of agent-shell presets for
// the dash. Item key order: id, name, icon, description, cwd, initial_input.
// `cwd` is an ABSOLUTE Windows path resolved against org_root with BACKSLASHES;
// `initial_input` ends in a CR (\r).
// ─────────────────────────────────────────────────────────────────────────────

import type { DaemonConfig } from '../contract.ts';
import { json } from './http.ts';

/** Join path segments and force Windows backslashes (org_root.join(...) →
 *  to_string_lossy() on Windows). Normalizes any mixed separators to `\`. */
function backslashPath(...parts: string[]): string {
  return parts.join('/').replace(/\//g, '\\');
}

export function launchPresets(config: DaemonConfig): Response {
  const orgRoot = config.orgRoot;
  const presets = [
    {
      id: 'agent',
      name: 'agent',
      icon: '✵',
      description: 'Agent shell at org root',
      cwd: backslashPath(orgRoot),
      initial_input: 'claude --system-prompt "."\r',
    },
  ];
  return json(presets);
}
