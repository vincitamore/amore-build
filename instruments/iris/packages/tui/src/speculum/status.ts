/**
 * Soft-state module for the Sessions member status strip.
 * Pure derivation + a thin spawn wrapper — no UI, no polling.
 */
import { openQueryService } from './query-service';
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
  /** Total session directories (primary + subagent). */
  sessions: number;
  /** Present when the query-service split is available (schemaOK index). */
  primarySessions?: number;
  /** Present when the query-service split is available (schemaOK index). */
  subagentSessions?: number;
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
 * Ready-state strip line. When primary/subagent split is known, surface it;
 * otherwise report total as session dirs (not "sessions") so the flat count
 * is not mistaken for primary-only.
 */
export function formatReadyStripDetail(opts: {
  sessions: number;
  primarySessions?: number;
  subagentSessions?: number;
  lastIngestedAt?: string | null;
  stale?: boolean;
  now?: number;
}): string {
  const age = formatIngestAge(opts.lastIngestedAt, opts.now);
  const staleBit = opts.stale ? ' · stale' : '';
  const hasSplit =
    typeof opts.primarySessions === 'number' &&
    typeof opts.subagentSessions === 'number' &&
    Number.isFinite(opts.primarySessions) &&
    Number.isFinite(opts.subagentSessions);
  if (hasSplit) {
    return (
      `installed · ${opts.sessions} session dirs · ` +
      `${opts.primarySessions} primary · ${opts.subagentSessions} subagent` +
      ` · last ingest ${age}${staleBit}`
    );
  }
  return `installed · ${opts.sessions} session dirs · last ingest ${age}${staleBit}`;
}

/**
 * Map a spawn result (or null = still loading) to soft state.
 * Returns `null` while loading so the holder can render a brief loading line
 * without inventing a fifth SessionsState.
 * Does not invent a primary/subagent split — that comes from fetchStatusState
 * enriching via the query-service when the index is readable.
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

  return {
    state: 'ready',
    sessions,
    detail: formatReadyStripDetail({
      sessions,
      lastIngestedAt: result.json?.ingest?.lastIngestedAt,
      stale: Boolean(result.json?.staleness?.stale),
    }),
  };
}

/**
 * Prefer the query-service split when the derived index is openable and schemaOK.
 * Falls back to CLI-only "session dirs" copy when the index is missing/mismatched
 * — never invents primary/subagent numbers.
 */
export function enrichWithSessionSplit(
  derived: DerivedSessionsState,
  open: typeof openQueryService = openQueryService,
): DerivedSessionsState {
  if (derived.state !== 'ready') return derived;
  try {
    const qs = open();
    try {
      if (!qs.schemaOK()) return derived;
      const st = qs.status();
      // Prefer index totals when available (same corpus the stages read).
      const sessions = st.sessions;
      if (sessions === 0) {
        return { state: 'empty', sessions: 0, detail: EMPTY_DETAIL };
      }
      const primarySessions = st.primarySessions;
      const subagentSessions = st.subagentSessions;
      return {
        state: 'ready',
        sessions,
        primarySessions,
        subagentSessions,
        detail: formatReadyStripDetail({
          sessions,
          primarySessions,
          subagentSessions,
          lastIngestedAt: st.lastIngestedAt ?? undefined,
          stale: st.stale,
        }),
      };
    } finally {
      qs.close();
    }
  } catch {
    // Missing index / open failure — keep CLI-derived honest fallback.
    return derived;
  }
}

/** Thin wrapper: `status --json` → deriveSessionsState → optional query-service split. */
export async function fetchStatusState(): Promise<DerivedSessionsState | null> {
  const r = await runSpeculum<StatusJson>('status', ['--json']);
  const derived = deriveSessionsState(r);
  if (!derived) return null;
  return enrichWithSessionSplit(derived);
}
