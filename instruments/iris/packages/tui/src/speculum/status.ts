/**
 * Soft-state module for the Sessions member status strip.
 * Pure derivation + a thin spawn wrapper — no UI, no polling.
 */
import { runSpeculum } from './speculum-spawn';

export type SessionsState = 'not-installed' | 'error' | 'empty' | 'ready';

/** Jump target accepted by the Sessions container (picker/list arrives with exploration). */
export type SessionFocus = {
  sessionId: string;
  eventId?: string | number;
  ts?: string;
};

/** Subset of `speculum status --json` used by derivation + strip flavor. */
export type StatusJson = {
  counts?: { sessions?: number; events?: number; usageRows?: number };
  ingest?: { lastIngestedAt?: string | null };
  staleness?: {
    thresholdHours?: number;
    hoursSinceNewestSession?: number | null;
    stale?: boolean;
    message?: string;
  };
};

export type StatusResultInput = {
  ok: boolean;
  error?: { kind: string; message?: string };
  json?: StatusJson;
} | null;

export type DerivedSessionsState = {
  state: SessionsState;
  sessions: number;
  detail?: string;
};

export const INSTALL_RECIPE = 'amore init --with-speculum';
export const EMPTY_DETAIL = "no ingested sessions — run 'speculum ingest'";

/**
 * Coarsen an ISO timestamp into a glanceable age
 * (`Xm ago` / `Xh ago` / `Xd ago`, or `never` when missing/unparseable).
 */
export function formatIngestAge(
  lastIngestedAt: string | null | undefined,
  now = Date.now(),
): string {
  if (lastIngestedAt == null || lastIngestedAt === '') return 'never';
  const ts = new Date(lastIngestedAt).getTime();
  if (Number.isNaN(ts)) return 'never';
  const ms = Math.max(0, now - ts);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Map a spawn result (or null = still loading) to soft state.
 * Returns `null` while loading so the holder can render a brief loading line
 * without inventing a fifth SessionsState.
 */
export function deriveSessionsState(result: StatusResultInput): DerivedSessionsState | null {
  if (result === null) return null;

  if (!result.ok) {
    if (result.error?.kind === 'not-installed') {
      return { state: 'not-installed', sessions: 0, detail: INSTALL_RECIPE };
    }
    const kind = result.error?.kind ?? 'error';
    const message = result.error?.message ?? 'unknown error';
    return { state: 'error', sessions: 0, detail: `${kind}: ${message}` };
  }

  // Undefined / missing counts → treat as empty (honest zero, not "unknown ready").
  const sessions = result.json?.counts?.sessions ?? 0;
  if (sessions === 0) {
    return { state: 'empty', sessions: 0, detail: EMPTY_DETAIL };
  }

  const age = formatIngestAge(result.json?.ingest?.lastIngestedAt);
  const staleBit = result.json?.staleness?.stale ? ' · stale' : '';
  return {
    state: 'ready',
    sessions,
    detail: `installed · ${sessions} sessions · last ingest ${age}${staleBit}`,
  };
}

/** Thin wrapper: `status --json` → deriveSessionsState. */
export async function fetchStatusState(): Promise<DerivedSessionsState | null> {
  const r = await runSpeculum<StatusJson>('status', ['--json']);
  return deriveSessionsState(r);
}
