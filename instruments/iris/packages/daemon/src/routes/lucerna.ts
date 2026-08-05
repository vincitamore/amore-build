// routes/lucerna.ts — Lucerna state-surface routes under /api/lucerna/*.
// Thin HTTP dispatch over proxies/lucerna.ts + lucerna-review.ts.
//
//   GET  /api/lucerna/health | status | log?n= | notifications?n= | pulse
//   GET  /api/lucerna/dreams?pending= | dream?id= | proposals?pending= | proposal?id=
//   POST /api/lucerna/halt | wake | sleep | start | stop | enable
//   POST /api/lucerna/dreams/review | proposals/apply | proposals/close
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
import {
  listDreams,
  showDream,
  listProposals,
  showProposal,
  reviewDream,
  applyProposal,
  closeProposal,
  pendingReviewCounts,
} from '../proxies/lucerna-review.ts';

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

function truthyParam(v: string | null): boolean {
  if (v === null) return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'pending';
}

async function readJsonBody(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; res: Response }> {
  try {
    const text = await req.text();
    if (!text.trim()) return { ok: true, body: {} };
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return {
      ok: false,
      res: jsonStatus({ available: true, ok: false, reason: 'invalid-json' }, 400),
    };
  }
}

function idFromBodyOrQuery(body: unknown, url: URL): string | null {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const o = body as Record<string, unknown>;
    if (typeof o.id === 'string' && o.id.trim()) return o.id.trim();
    if (typeof o.path === 'string' && o.path.trim()) return o.path.trim();
  }
  const q = url.searchParams.get('id') ?? url.searchParams.get('path');
  return q && q.trim() ? q.trim() : null;
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
      case '/api/lucerna/pulse': {
        const pulse = readPulse(orgRoot);
        const c = pendingReviewCounts(orgRoot);
        return json({
          ...pulse,
          pendingReview: { dreams: c.dreams, proposals: c.proposals, total: c.total },
        });
      }
      case '/api/lucerna/dreams': {
        const pendingOnly = truthyParam(url.searchParams.get('pending'));
        return json(listDreams(orgRoot, { pendingOnly }));
      }
      case '/api/lucerna/dream': {
        const id = url.searchParams.get('id') ?? url.searchParams.get('path');
        if (!id || !id.trim()) {
          return jsonStatus(
            { available: true, found: false, reason: 'usage', message: 'id query param required' },
            400,
          );
        }
        return json(showDream(orgRoot, id.trim()));
      }
      case '/api/lucerna/proposals': {
        const pendingOnly = truthyParam(url.searchParams.get('pending'));
        return json(listProposals(orgRoot, { pendingOnly }));
      }
      case '/api/lucerna/proposal': {
        const id = url.searchParams.get('id') ?? url.searchParams.get('path');
        if (!id || !id.trim()) {
          return jsonStatus(
            { available: true, found: false, reason: 'usage', message: 'id query param required' },
            400,
          );
        }
        return json(showProposal(orgRoot, id.trim()));
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
      case '/api/lucerna/dreams/review': {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return parsed.res;
        const id = idFromBodyOrQuery(parsed.body, url);
        if (!id) {
          return jsonStatus(
            { available: true, ok: false, reason: 'usage', message: 'body.id required' },
            400,
          );
        }
        return json(reviewDream(orgRoot, id));
      }
      case '/api/lucerna/proposals/apply': {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return parsed.res;
        const id = idFromBodyOrQuery(parsed.body, url);
        if (!id) {
          return jsonStatus(
            { available: true, ok: false, reason: 'usage', message: 'body.id required' },
            400,
          );
        }
        return json(applyProposal(orgRoot, id));
      }
      case '/api/lucerna/proposals/close': {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return parsed.res;
        const id = idFromBodyOrQuery(parsed.body, url);
        if (!id) {
          return jsonStatus(
            { available: true, ok: false, reason: 'usage', message: 'body.id required' },
            400,
          );
        }
        return json(closeProposal(orgRoot, id));
      }
    }
    return emptyStatus(404);
  }

  return emptyStatus(404);
}
