// routes/lucerna.ts — Lucerna state-surface routes under /api/lucerna/*.
// Thin HTTP dispatch over proxies/lucerna.ts.
//
//   GET  /api/lucerna/health | status | log?n= | notifications?n= | pulse
//   POST /api/lucerna/halt | wake | sleep | start | stop | enable
//
// Method/path mismatches → 404 empty (daemon convention).

import type { DaemonConfig } from '../contract.ts';
import { json, emptyStatus, CORS_HEADERS } from './http.ts';
import {
  readHealth,
  readStatus,
  readLog,
  readNotifications,
  readPulse,
  writeHalt,
  writeWake,
  writeSleep,
  writeEnablement,
  startLucerna,
  stopLucerna,
  type LucernaEnablement,
} from '../proxies/lucerna.ts';

function jsonStatus(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function parseEnableBody(body: unknown): Partial<LucernaEnablement> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const patch: Partial<LucernaEnablement> = {};
  if (typeof o.dreamsEnabled === 'boolean') patch.dreamsEnabled = o.dreamsEnabled;
  if (typeof o.autoCommitLive === 'boolean') patch.autoCommitLive = o.autoCommitLive;
  if (Object.keys(patch).length === 0) return null;
  return patch;
}

export async function lucernaRoute(config: DaemonConfig, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const sub = url.pathname;
  const method = req.method;
  const orgRoot = config.orgRoot;

  if (method === 'GET') {
    switch (sub) {
      case '/api/lucerna/health':
        return json(readHealth(orgRoot));
      case '/api/lucerna/status':
        return json(readStatus(orgRoot));
      case '/api/lucerna/log': {
        const raw = url.searchParams.get('n');
        const parsed = raw !== null ? Number.parseInt(raw, 10) : 50;
        const n = Number.isNaN(parsed) ? 50 : parsed;
        return json(readLog(orgRoot, n));
      }
      case '/api/lucerna/notifications': {
        const raw = url.searchParams.get('n');
        const parsed = raw !== null ? Number.parseInt(raw, 10) : 50;
        const n = Number.isNaN(parsed) ? 50 : parsed;
        return json(readNotifications(orgRoot, n));
      }
      case '/api/lucerna/pulse':
        return json(readPulse(orgRoot));
    }
    return emptyStatus(404);
  }

  if (method === 'POST') {
    switch (sub) {
      case '/api/lucerna/halt':
        return json(writeHalt(orgRoot));
      case '/api/lucerna/wake':
        return json(writeWake(orgRoot));
      case '/api/lucerna/sleep':
        return json(writeSleep(orgRoot));
      case '/api/lucerna/start':
        return json(await startLucerna(orgRoot));
      case '/api/lucerna/stop':
        return json(await stopLucerna(orgRoot));
      case '/api/lucerna/enable': {
        let body: unknown = {};
        try {
          const text = await req.text();
          if (text.trim()) body = JSON.parse(text);
        } catch {
          return jsonStatus({ available: true, ok: false, reason: 'invalid-json' }, 400);
        }
        const patch = parseEnableBody(body);
        if (!patch) {
          return jsonStatus(
            {
              available: true,
              ok: false,
              reason: 'usage',
              message: 'body requires dreamsEnabled and/or autoCommitLive boolean',
            },
            400,
          );
        }
        return json(writeEnablement(orgRoot, patch));
      }
    }
    return emptyStatus(404);
  }

  return emptyStatus(404);
}
