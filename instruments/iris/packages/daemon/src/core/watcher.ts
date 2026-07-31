// ─────────────────────────────────────────────────────────────────────────────
// core/watcher.ts — keep the boot-frozen index current from a recursive fs.watch.
//
// THE ONE-ADMISSION-FILTER RULE (the reason this module exists as written):
// every watcher event is admitted through the SAME `shouldExclude` the walk uses
// (core/walk.ts). The legacy Rust daemon's watcher carried its own `is_excluded`
// — a stale 6-entry fork of `should_exclude` — so events bypassed the walk's
// exclusions and contaminated the index. That whole class is contract-banned:
// `classifyEvents` calls `shouldExclude` and nothing else decides admission, and
// the walk-diff fallback (reconcile) re-expresses itself through `applyChanges`,
// so there is exactly ONE index-update path and ONE admission filter.
//
// EMPIRICAL win32 notes (Bun 1.x, live-probed 2026-07-03):
//   - `fs.watch(root, { recursive: true })` DOES fire for arbitrarily-nested file
//     creates/edits/deletes on Windows (native recursion, no per-dir re-arm).
//   - event filenames arrive RELATIVE to the watched dir with BACKSLASH separators
//     (`tasks\\foo.md`, `knowledge\\deep\\b.md`) — normalized here to org-relative
//     forward-slash paths.
//   - a create fires TWO events (`rename` then `change`) for one path; a delete
//     fires `rename`; a modify fires `change`. The classifier is event-TYPE-blind
//     (it stats the path) and the debounce Set dedupes the create pair to one delta.
//   - a stray ancestor-dir `change` event can appear when several writes coalesce
//     inside one debounce window; under the DIR rule below that yields a reconcile,
//     which is correct (just occasionally slower). Isolated single writes do NOT
//     produce a companion dir event, so the batch path is the common case.
// ─────────────────────────────────────────────────────────────────────────────

import { statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { ChangeSet, IndexedDoc, OrgIndex } from '../contract';
import { applyChanges, reconcile } from './index-build';
import { shouldExclude } from './walk';

/** Distinct classified paths above which we stop per-path work and reconcile
 *  (git-checkout / bun-install storms). */
const RECONCILE_THRESHOLD = 200;
const DEFAULT_DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 2000;

export type Classification =
  | { kind: 'batch'; changes: ChangeSet }
  | { kind: 'reconcile' }
  | { kind: 'noop' };

/**
 * Normalize one raw fs.watch filename to an org-relative forward-slash path.
 * Handles both the observed relative-backslash form (`tasks\\foo.md`) and a
 * defensive absolute form (`<orgRoot>\\tasks\\foo.md`). Returns '' for the org
 * root itself. Only the orgRoot prefix compare is case-folded (Windows paths);
 * the returned path keeps its real case (it is a doc key).
 */
export function normalizeToRel(raw: string, orgRoot: string): string {
  let p = raw.replace(/\\/g, '/');
  const root = orgRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const pl = p.toLowerCase();
  const rl = root.toLowerCase();
  if (pl === rl) {
    p = '';
  } else if (pl.startsWith(`${rl}/`)) {
    p = p.slice(root.length + 1);
  }
  return p.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * PURE-DECISION classifier (the unit-testable core, separated from the fs.watch
 * plumbing). Given a debounced batch of raw event filenames, the live doc set, and
 * the org root, decide one of: apply an admitted `.md` delta (`batch`), fall back
 * to a full re-walk (`reconcile`), or do nothing (`noop`). Reads disk (`statSync`)
 * to tell file-vs-dir-vs-gone, but the branching logic is a pure function of
 * (paths, docs, on-disk state).
 *
 * Every admission passes through the ONE filter `shouldExclude` — see the legacy
 * `is_excluded` fork bug in this file's header.
 */
export function classifyEvents(
  paths: Array<string | null | undefined>,
  docs: Map<string, IndexedDoc>,
  orgRoot: string,
): Classification {
  const rels = new Set<string>();
  for (const raw of paths) {
    if (raw === null || raw === undefined) return { kind: 'reconcile' }; // unknown scope
    const rel = normalizeToRel(raw, orgRoot);
    if (rel === '') continue; // the org root itself — no doc scope
    rels.add(rel);
  }
  if (rels.size === 0) return { kind: 'noop' };
  if (rels.size > RECONCILE_THRESHOLD) return { kind: 'reconcile' };

  const updated: string[] = [];
  const removed: string[] = [];
  for (const rel of rels) {
    let stat: ReturnType<typeof statSync> | null;
    try {
      stat = statSync(join(orgRoot, rel));
    } catch {
      stat = null; // deleted or renamed away
    }

    if (stat === null) {
      if (docs.has(rel)) {
        removed.push(rel);
      } else {
        // A dir holding tracked docs may vanish with no per-file events (win32
        // dir rename) → reconcile; an unknown vanished path is noise → drop.
        const prefix = `${rel}/`;
        for (const key of docs.keys()) {
          if (key.startsWith(prefix)) return { kind: 'reconcile' };
        }
      }
      continue;
    }

    if (stat.isDirectory()) {
      if (shouldExclude(rel, true)) continue; // excluded dir event → drop
      return { kind: 'reconcile' }; // admitted dir event can move many docs at once
    }

    if (stat.isFile()) {
      if (rel.endsWith('.md') && !shouldExclude(rel, false)) updated.push(rel);
      continue; // non-md or excluded file → drop
    }
    // sockets/symlinks/etc. → drop
  }

  if (updated.length === 0 && removed.length === 0) return { kind: 'noop' };
  return { kind: 'batch', changes: { updated, removed } };
}

/**
 * Watch `orgRoot` recursively and keep `index` current. Events are collected and
 * processed after $IRIS_WATCH_DEBOUNCE_MS of quiet (default 300ms), with a
 * bounded max-wait (2000ms) so a sustained burst still flushes. Each flush routes
 * its batch through `classifyEvents` → `applyChanges`/`reconcile` — the single
 * update path. On a watcher 'error' it logs and stops (no re-arm machinery: the
 * daemon restarts cheaply — second-system guard). `stop()` closes the watcher and
 * clears both timers.
 */
export function startWatcher(index: OrgIndex, orgRoot: string): { stop(): void } {
  const envMs = Number(process.env.IRIS_WATCH_DEBOUNCE_MS);
  const debounceMs = Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_DEBOUNCE_MS;

  let pending = new Set<string | null>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function clearTimers(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimers();
    try {
      watcher.close();
    } catch {
      // already closed / never opened
    }
  }

  function flush(): void {
    clearTimers();
    if (pending.size === 0) return;
    const batch = [...pending];
    pending = new Set();

    const cls = classifyEvents(batch, index.docs, orgRoot);
    if (cls.kind === 'noop') return;
    if (cls.kind === 'reconcile') {
      const s = reconcile(index, orgRoot);
      console.log(
        `[daemon] reindex (reconcile): ${s.updated} updated, ${s.removed} removed, ` +
          `${s.parseFailures} failures, ${s.ms}ms`,
      );
      return;
    }
    const s = applyChanges(index, orgRoot, cls.changes);
    console.log(
      `[daemon] reindex: ${s.updated} updated, ${s.removed} removed, ` +
        `${s.parseFailures} failures, ${s.ms}ms`,
    );
  }

  function schedule(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, debounceMs);
    if (maxWaitTimer === null) maxWaitTimer = setTimeout(flush, MAX_WAIT_MS);
  }

  let watcher: FSWatcher;
  try {
    // encoding:'utf8' → filename is string | null (never a Buffer).
    watcher = watch(orgRoot, { recursive: true, encoding: 'utf8' }, (_event, filename) => {
      if (stopped) return;
      pending.add(filename ?? null);
      schedule();
    });
  } catch (err) {
    console.error(`[daemon] watcher error: ${err instanceof Error ? err.message : String(err)}`);
    return { stop() {} };
  }

  watcher.on('error', (err) => {
    console.error(`[daemon] watcher error: ${err instanceof Error ? err.message : String(err)}`);
    stop();
  });

  return { stop };
}
