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

/** Per-origin row/root counts from `speculum status --json` (optional until companion refresh). */
export type OriginBucketJson = { rows?: number; roots?: number };

export type OriginsJson = {
  operator?: OriginBucketJson;
  experiment?: OriginBucketJson;
  harness?: OriginBucketJson;
  unknown?: OriginBucketJson;
};

/** Subset of `speculum status --json` used by derivation + strip flavor. */
export type StatusJson = {
  counts?: {
    sessions?: number;
    events?: number;
    usageRows?: number;
    /** Optional: some status builds nest origins under counts; prefer top-level. */
    origins?: OriginsJson;
  };
  /** Session origin split (operator / experiment / harness / unknown). */
  origins?: OriginsJson;
  ingest?: { lastIngestedAt?: string | null };
  staleness?: {
    thresholdHours?: number;
    hoursSinceNewestSession?: number | null;
    stale?: boolean;
    message?: string;
  };
};

/** Normalized origin row counts used by the strip. */
export type OriginsCounts = {
  operator: number;
  experiment: number;
  harness: number;
  unknown: number;
};

/** Coerce optional JSON origins into finite row counts; null when absent. */
export function readOriginsCounts(
  origins: OriginsJson | null | undefined,
): OriginsCounts | null {
  if (!origins || typeof origins !== 'object') return null;
  const n = (b: OriginBucketJson | undefined): number => {
    const v = b?.rows;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  // Require at least one class key so empty `{}` is not treated as a real split.
  if (
    origins.operator == null &&
    origins.experiment == null &&
    origins.harness == null &&
    origins.unknown == null
  ) {
    return null;
  }
  return {
    operator: n(origins.operator),
    experiment: n(origins.experiment),
    harness: n(origins.harness),
    unknown: n(origins.unknown),
  };
}

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
  /** Present when status --json carries origins (defensive optional). */
  origins?: OriginsCounts;
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
 * Ready-state strip line. When origins are known, the headline number is the
 * **operator** row count with the honest origin split. When primary/subagent
 * split is known, surface it. Fallback (no origins): total as session dirs
 * so a flat count is not mistaken for primary-only.
 *
 * Keep on one row — `formatLucernaDisplayLine` truncates, never wraps.
 */
export function formatReadyStripDetail(opts: {
  sessions: number;
  primarySessions?: number;
  subagentSessions?: number;
  origins?: OriginsCounts | null;
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
  const o = opts.origins ?? null;
  const hasOrigins =
    o != null &&
    Number.isFinite(o.operator) &&
    Number.isFinite(o.experiment) &&
    Number.isFinite(o.harness);

  if (hasOrigins && o) {
    let originBit =
      `${o.operator} operator · ${o.experiment} experiment · ${o.harness} harness`;
    if (o.unknown > 0) originBit += ` · ${o.unknown} unknown`;
    if (hasSplit) {
      return (
        `installed · ${originBit} · ` +
        `${opts.primarySessions} primary · ${opts.subagentSessions} subagent` +
        ` · last ingest ${age}${staleBit}`
      );
    }
    return `installed · ${originBit} · last ingest ${age}${staleBit}`;
  }

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

  // Defensive: accept top-level origins or a nested counts.origins if present.
  const origins =
    readOriginsCounts(result.json?.origins) ??
    readOriginsCounts(result.json?.counts?.origins) ??
    undefined;

  return {
    state: 'ready',
    sessions,
    origins,
    detail: formatReadyStripDetail({
      sessions,
      origins,
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
      // Origins come from CLI status JSON (not the query-service); preserve them.
      const origins = derived.origins;
      return {
        state: 'ready',
        sessions,
        primarySessions,
        subagentSessions,
        origins,
        detail: formatReadyStripDetail({
          sessions,
          primarySessions,
          subagentSessions,
          origins,
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
