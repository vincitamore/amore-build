// Thin fetch wrapper: fires one case against a base URL and normalizes the
// response into the golden-record body model (json / raw / binary). Read-only
// (GET) by contract for the current harness phase.

import type { BodyKind } from './manifest';

export class HttpError extends Error {
  constructor(
    public code: 'UNAVAILABLE' | 'TIMEOUT' | 'INTERNAL',
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface FetchedResponse {
  status: number;
  contentType: string | null;
  bodyKind: BodyKind;
  body: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Is this byte buffer valid UTF-8? (decides raw vs binary storage). */
function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch `base + path`. JSON responses are parsed (bodyKind=json); anything else
 * is stored raw (UTF-8 text) or base64 (binary). Network failures raise
 * HttpError so the caller can map to the UNAVAILABLE/TIMEOUT exit codes.
 */
export async function fetchCase(
  base: string,
  method: string,
  path: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<FetchedResponse> {
  const url = base.replace(/\/$/, '') + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method, signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) throw new HttpError('TIMEOUT', `request to ${url} timed out after ${timeoutMs}ms`);
    throw new HttpError('UNAVAILABLE', `no response from ${url}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }

  const contentType = res.headers.get('content-type');
  const buf = new Uint8Array(await res.arrayBuffer());

  const looksJson = (contentType ?? '').includes('json');
  if (looksJson || buf.length === 0) {
    // Empty body (e.g. a 404 with no payload) is modeled as json:null so the
    // differ compares status + a null body rather than an empty raw string.
    if (buf.length === 0) {
      return { status: res.status, contentType, bodyKind: 'json', body: null };
    }
    const text = new TextDecoder('utf-8').decode(buf);
    try {
      return { status: res.status, contentType, bodyKind: 'json', body: JSON.parse(text) };
    } catch {
      return { status: res.status, contentType, bodyKind: 'raw', body: text };
    }
  }

  if (isUtf8(buf)) {
    return { status: res.status, contentType, bodyKind: 'raw', body: new TextDecoder('utf-8').decode(buf) };
  }
  return { status: res.status, contentType, bodyKind: 'binary', body: Buffer.from(buf).toString('base64') };
}
