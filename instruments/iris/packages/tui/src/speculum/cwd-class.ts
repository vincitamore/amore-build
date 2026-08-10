/**
 * Classify session project paths (cwd roots) by origin.
 *
 * Pure string predicate mirrored from the speculum instrument's cwd-class —
 * no runtime dependency on that package. Paths may arrive decoded
 * (`sessions.project_path`) or URL-encoded (`%5C`, `%2F`, `%3A` as on-disk
 * dir names under the sessions tree). Classification is over the decoded form.
 */

export type CwdOrigin = 'operator' | 'experiment' | 'harness' | 'unknown';

export type OriginBucket = { rows: number; roots: number };

export type OriginsReport = {
  operator: OriginBucket;
  experiment: OriginBucket;
  harness: OriginBucket;
  unknown: OriginBucket;
};

/** Decode a possibly URL-encoded path; return the input when not encoded. */
export function decodeCwdPath(projectPathOrEncoded: string): string {
  const raw = projectPathOrEncoded.trim();
  if (!raw) return raw;
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function basenameOf(norm: string): string {
  const parts = norm.split('/').filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : norm;
}

function isTempLike(normLower: string): boolean {
  if (normLower === '/tmp' || normLower.startsWith('/tmp/')) return true;
  if (normLower.includes('/appdata/local/temp/')) return true;
  if (normLower.includes('/appdata/local/temp')) return true;
  if (normLower.startsWith('/var/tmp/') || normLower === '/var/tmp') return true;
  return false;
}

/**
 * Classify one project path / encoded cwd dir name.
 *
 * Rules (order matters):
 * - harness: basename `chat-mode-*`, or path/basename contains `sf1-smoke` / `resume-smoke`
 * - experiment: path contains `identity-study` or `arcus-model-comparison`
 * - unknown: bare `/tmp`, other unclassifiable temp leftovers
 * - operator: real workspaces (Documents, non-temp project dirs) — default for non-temp paths
 */
export function classifyCwd(projectPathOrEncoded: string): CwdOrigin {
  const raw = projectPathOrEncoded.trim();
  if (!raw) return 'unknown';

  const decoded = decodeCwdPath(raw);
  const norm = normalizePath(decoded);
  const lower = norm.toLowerCase();
  const base = basenameOf(lower);

  if (base.startsWith('chat-mode-') || lower.includes('/chat-mode-')) {
    return 'harness';
  }
  if (
    base.includes('sf1-smoke') ||
    base.includes('resume-smoke') ||
    lower.includes('sf1-smoke') ||
    lower.includes('resume-smoke')
  ) {
    return 'harness';
  }

  if (lower.includes('identity-study') || lower.includes('arcus-model-comparison')) {
    return 'experiment';
  }

  if (lower === '/tmp') return 'unknown';
  if (isTempLike(lower)) return 'unknown';

  return 'operator';
}

export type SessionOriginRow = {
  project_path: string;
  agent?: string;
};

/** Count session rows and distinct project_path roots per origin class. */
export function buildOriginsReport(rows: readonly SessionOriginRow[]): OriginsReport {
  const empty = (): OriginBucket => ({ rows: 0, roots: 0 });
  const report: OriginsReport = {
    operator: empty(),
    experiment: empty(),
    harness: empty(),
    unknown: empty(),
  };
  const rootsByClass: Record<CwdOrigin, Set<string>> = {
    operator: new Set(),
    experiment: new Set(),
    harness: new Set(),
    unknown: new Set(),
  };

  for (const row of rows) {
    const path = row.project_path ?? '';
    const origin = classifyCwd(path);
    report[origin].rows += 1;
    rootsByClass[origin].add(path);
  }

  for (const key of Object.keys(rootsByClass) as CwdOrigin[]) {
    report[key].roots = rootsByClass[key]!.size;
  }
  return report;
}
