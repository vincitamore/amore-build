// GET /api/health — routes::health. Static {status, timestamp} (Regime A).
import { json, rfc3339Nanos } from './http.ts';

/** {"status":"ok","timestamp":"<RFC3339-nanos, now>"}. `timestamp` advances every
 *  call (parity IGNORE); shape is the 9-fractional-digit `+00:00` form. */
export function health(): Response {
  return json({ status: 'ok', timestamp: rfc3339Nanos(Date.now()) });
}
