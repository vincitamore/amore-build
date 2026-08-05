// dream-link.ts — match agentic dream artifacts (session manifests, light
// reports, proposals) so one dream shows as one pipeline with its products.
// Shared by the Lucerna review proxy and the Forge Dreams view.

/**
 * Minimal fields needed to join a report/proposal to a session manifest
 * (or reconstructed pipeline). Path is org-relative POSIX.
 */
export interface DreamLinkFields {
  /** Basename id (no .md / .manifest.md) or pipeline slug. */
  id: string;
  path: string;
  pipeline?: string;
  created?: string;
  dreamAction?: string;
  tags?: string[];
  /** Discriminator when known; proposals omit kind or use 'proposal'. */
  kind?: 'manifest' | 'light' | 'proposal';
}

/**
 * Parse session stamp from a manifest id / filename stem:
 * `YYYYMMDD-HHmmss-<action>` (protocol) or looser `YYYYMMDD-<action>`.
 */
export function parseManifestStamp(
  id: string,
): { ymd: string; hms?: string; action: string } | null {
  const full = id.match(/^(\d{8})-(\d{6})-(.+)$/);
  if (full) return { ymd: full[1], hms: full[2], action: full[3] };
  const loose = id.match(/^(\d{8})-(.+)$/);
  if (loose && !/^\d{6}$/.test(loose[2].slice(0, 6))) {
    return { ymd: loose[1], action: loose[2] };
  }
  return null;
}

function ymdDashed(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

function sameCalendarDay(created: string | undefined, ymd: string): boolean {
  if (!created) return false;
  const compact = created.replace(/-/g, '').slice(0, 8);
  return compact === ymd;
}

/** Basename stem: strip .manifest.md then .md. */
export function dreamStemFromPath(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() || path;
  if (base.endsWith('.manifest.md')) return base.slice(0, -'.manifest.md'.length);
  if (base.endsWith('.md')) return base.slice(0, -3);
  return base;
}

/**
 * Whether an artifact (light report or similar) belongs to a session
 * manifest / dream pipeline. Primary: shared `pipeline`. Fallback for older
 * artifacts: same basename id, or action+date from the session stamp vs
 * report filename / dream-action / created.
 *
 * Works for proposals when they carry `pipeline` (or legacy path/date cues).
 */
export function artifactBelongsToManifest(
  artifact: DreamLinkFields,
  man: DreamLinkFields,
): boolean {
  // 1. pipeline linkage (preferred — writer stamps the same pipeline on both)
  if (artifact.pipeline && man.pipeline && artifact.pipeline === man.pipeline) return true;
  if (artifact.pipeline && man.id && artifact.pipeline === man.id) return true;
  if (man.pipeline && artifact.id && man.pipeline === artifact.id) return true;
  if (man.pipeline && artifact.pipeline) {
    const a = man.pipeline.replace(/^dream-/, '');
    const b = artifact.pipeline.replace(/^dream-/, '');
    if (a && a === b) return true;
  }

  // 2. identical basename id
  if (artifact.id && man.id && artifact.id === man.id) return true;

  // 3. legacy: action + date from session stamp vs artifact fields/filename
  const stampId = man.id || dreamStemFromPath(man.path);
  const stamp = parseManifestStamp(stampId);
  if (!stamp) return false;
  const action = stamp.action.toLowerCase();
  const idL = (artifact.id || dreamStemFromPath(artifact.path)).toLowerCase();

  if (man.id && idL === man.id.toLowerCase()) return true;
  if (idL.includes(action) && idL.includes(stamp.ymd)) return true;

  if (artifact.dreamAction?.toLowerCase() === action && sameCalendarDay(artifact.created, stamp.ymd)) {
    return true;
  }

  const pipeAction = (artifact.pipeline ?? man.pipeline ?? '')
    .replace(/^dream-/, '')
    .toLowerCase();
  if (pipeAction && pipeAction === action) {
    if (sameCalendarDay(artifact.created, stamp.ymd) || sameCalendarDay(man.created, stamp.ymd)) {
      if (
        artifact.pipeline ||
        artifact.dreamAction?.toLowerCase() === action ||
        idL.includes(action)
      ) {
        return true;
      }
    }
  }

  const tags = artifact.tags ?? [];
  if (
    man.created &&
    artifact.created &&
    man.created.slice(0, 10) === artifact.created.slice(0, 10) &&
    (idL.includes(action) ||
      artifact.dreamAction?.toLowerCase() === action ||
      tags.some((t) => t.toLowerCase() === action))
  ) {
    return true;
  }

  if (idL.includes(action) && idL.includes(ymdDashed(stamp.ymd))) return true;

  return false;
}

/**
 * @deprecated Prefer {@link artifactBelongsToManifest}. Kept as the Lucerna
 * review name for call-site clarity (light report ↔ session manifest).
 */
export function lightBelongsToManifest(
  light: DreamLinkFields,
  man: DreamLinkFields,
): boolean {
  return artifactBelongsToManifest(light, man);
}
