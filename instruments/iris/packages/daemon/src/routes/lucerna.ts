// routes/lucerna.ts — Lucerna state-surface routes under /api/lucerna/*.
// Thin HTTP dispatch over proxies/lucerna.ts.
//
//   GET  /api/lucerna/health
//   GET  /api/lucerna/status
//   GET  /api/lucerna/log?n=
//   POST /api/lucerna/halt | /wake | /sleep
//
// Method/path mismatches → 404 empty (daemon convention).

import type { DaemonConfig } from '../contract.ts';
import { json, emptyStatus } from './http.ts';
import {
  readHealth,
  readStatus,
  readLog,
  writeHalt,
  writeWake,
  writeSleep,
} from '../proxies/lucerna.ts';

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
    }
    return emptyStatus(404);
  }

  return emptyStatus(404);
}
