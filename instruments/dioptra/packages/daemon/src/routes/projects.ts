// ─────────────────────────────────────────────────────────────────────────────
// /api/projects family — projects::list_projects / get_tree / get_file. All
// construction lives in deps.projects (the projects module); these handlers map
// its return contract to HTTP:
//   - listProjects → 200 [{name,hasReadme,hasClaude},...] (Regime A).
//   - getTree      → null → 404 (empty) · 'forbidden' → 403 (empty) · else 200
//     TreeEntry[].
//   - getProjectFile → null → 404 · 'forbidden' → 403 · else 200 ProjectFileWire
//     (language is present as null when the extension is unknown).
// ─────────────────────────────────────────────────────────────────────────────

import type { DaemonDeps } from '../contract.ts';
import { emptyStatus, json } from './http.ts';

export function listProjects(deps: DaemonDeps): Response {
  return json(deps.projects.listProjects(deps.config.orgRoot));
}

export function projectTree(deps: DaemonDeps, name: string): Response {
  const r = deps.projects.getTree(deps.config.orgRoot, name);
  if (r === null) return emptyStatus(404);
  if (r === 'forbidden') return emptyStatus(403);
  return json(r);
}

export function projectFile(deps: DaemonDeps, name: string, path: string): Response {
  const r = deps.projects.getProjectFile(deps.config.orgRoot, name, path);
  if (r === null) return emptyStatus(404);
  if (r === 'forbidden') return emptyStatus(403);
  return json(r);
}
