// ─────────────────────────────────────────────────────────────────────────────
// http.ts — shared response helpers enforcing the legacy wire conventions
// (spec/legacy-shapes.md §0). Every response — success OR error — carries the
// global tower-http CORS headers; there is no envelope; JSON is compact with no
// trailing newline; error bodies are bare (empty) except the search 400.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The permissive CORS pair present on EVERY legacy response (mod.rs CorsLayer:
 * allow_origin(Any) → `access-control-allow-origin: *`; the `vary` triple is
 * tower-http's default). Applied uniformly here so errors carry it too.
 */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  vary: 'origin, access-control-request-method, access-control-request-headers',
};

/**
 * A 200 JSON response. `serde_json::to_vec` is compact — `JSON.stringify` with
 * no replacer/space matches it (no spaces after `:`/`,`, no trailing newline).
 * Object key order is the caller's responsibility (Regime A = struct order;
 * Regime B docs are pre-ordered by the core serializer).
 */
export function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * A bare status code with an EMPTY body and NO content-type — the legacy error
 * arm (`Result<Json<T>, StatusCode>` → status only). Used for 404 (unindexed /
 * missing) and 403 (traversal), plus unknown routes.
 */
export function emptyStatus(status: number): Response {
  return new Response(null, { status, headers: { ...CORS_HEADERS } });
}

/** A text/plain body with an explicit status — the sole non-empty error case
 *  (search's missing-`q` 400: axum QueryRejection). */
export function text(status: number, body: string, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': contentType, ...CORS_HEADERS },
  });
}

/** Raw bytes with a mime type + extra headers (the assets route). */
export function raw(bytes: Uint8Array, mime: string, extra: Record<string, string>): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': mime, ...extra, ...CORS_HEADERS },
  });
}

/**
 * RFC3339 UTC with exactly 9 fractional-second digits and a literal `+00:00`
 * offset, e.g. `2026-07-02T17:25:26.955000000+00:00` — matches the SHAPE of
 * `chrono::Utc::now().to_rfc3339()`. The value is a parity IGNORE path (wall
 * clock); we derive from epoch-ms and pad the milliseconds to 9 digits.
 */
export function rfc3339Nanos(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const frac = p(d.getUTCMilliseconds(), 3) + '000000'; // ms → 9 digits
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${frac}+00:00`
  );
}
