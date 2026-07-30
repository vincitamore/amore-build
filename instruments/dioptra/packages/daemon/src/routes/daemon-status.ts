// ─────────────────────────────────────────────────────────────────────────────
// daemon-status.ts — GET /api/daemon/status: the daemon-identity handshake.
//
// NOT part of the 22-case parity surface (the legacy route reports its PTY
// sub-daemon — excluded tier, pty). It exists because the TUI's `isDaemonUp`
// (packages/tui/src/daemon.ts) probes this exact route and accepts only its
// shape — `{ port, attached_at_startup, live, binary_path, info }` — as proof
// that a *Vitrum* daemon (not a port squatter) is answering. Without it, the
// dash treats this daemon as down and tries to spawn the legacy binary over it.
//
// The payload is shape-valid and TRUTHFUL: this daemon manages no PTY
// sub-daemon (`live: false`, `attached_at_startup: false`, `binary_path:
// null`), and `info` carries this daemon's own identity — the build-stamp
// handshake the fine-tooth review called for (a client that wants to know
// WHICH implementation is serving reads `info.service`).
// ─────────────────────────────────────────────────────────────────────────────

import type { DaemonConfig } from '../contract.ts';
import { json } from './http.ts';

export function daemonStatus(config: DaemonConfig): Response {
  return json({
    port: config.port,
    attached_at_startup: false,
    live: false,
    binary_path: null,
    info: {
      service: 'dioptra-bun-daemon',
      pid: process.pid,
      port: config.port,
      // House-identity guard (2026-07-22): clients verify WHICH TREE this daemon
      // serves, not just which implementation — a daemon serving a foreign org
      // root is the cross-house wire-crossing class (foreign-root incident).
      org_root: config.orgRoot,
      started_at: Math.floor(config.startedAt / 1000),
      uptime_secs: Math.floor((Date.now() - config.startedAt) / 1000),
      version: '0.0.0',
      pty: false,
    },
  });
}
