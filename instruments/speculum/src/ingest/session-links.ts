/**
 * Evidence-only cross-session links (resumed_from, shared_artifact) into
 * session_links. Links are extracted from what the session record actually
 * states — never inferred from similarity or proximity.
 * Re-derived on every ingest rebuild; heuristic methods carry banners.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../store/db";
import { sessionsRoot } from "../paths";
import { extractArtifactIds } from "../decisions/links";

/**
 * Artifacts seen in more than this many distinct sessions are treated as a
 * background commons (package.json, etc.) and generate no pair edges.
 */
export const ARTIFACT_UBIQUITY_MAX = 8;

/** Method banner for path-derived shared_artifact edges (always heuristic). */
export const SHARED_ARTIFACT_METHOD =
  `artifact_path; plausible; ubiquity<=${ARTIFACT_UBIQUITY_MAX}`;

/**
 * Strong file extensions observed on real corpus paths (last path segment).
 * Numeric "extensions" (grok-4.5 → .5) and code-method tails (console.log →
 * .log, math.max → .max) are intentionally absent.
 */
const STRONG_FILE_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "mdx",
  "sql",
  "rs",
  "py",
  "toml",
  "yaml",
  "yml",
  "lock",
  "txt",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "svg",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "bat",
  "cmd",
  "wasm",
  "vue",
  "svelte",
  "go",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "cc",
  "rb",
  "php",
  "lua",
  "zig",
  "r",
  "cs",
  "fs",
  "ex",
  "exs",
  "clj",
  "scala",
  "swift",
  "m",
  "mm",
  "plist",
  "proto",
  "graphql",
  "gql",
  "csv",
  "tsv",
  "xml",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "patch",
  "diff",
  "rst",
  "tex",
  "ipynb",
  "dll",
  "exe",
  "so",
  "dylib",
  "rlib",
  "bin",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "npmrc",
  "env",
  // note: "map" omitted — dotted code refs like rows.map / array.map
  // look like source-map files; real *.js.map is rare in this corpus.
]);

/** Path segment charset (after extractArtifactIds normalizes backslashes). */
const PATH_SEGMENT_RE = /^[A-Za-z0-9._@+()[\]~-]+$/;
/** Windows drive segment, e.g. "c:". */
const DRIVE_SEGMENT_RE = /^[A-Za-z]:$/;

/**
 * True when an extracted artifact identity looks like a real file path rather
 * than escaped-newline residue, prose, version numbers, or dotted code refs.
 *
 * Designed from live corpus junk classes (fix-round-1 excluded list +
 * sub-threshold samples): `/ntriggered-by`, `/n/n`, `/npipeline`, `e.g`,
 * `console.log`, `2.1`, spaced prose paths, etc.
 *
 * Keep: strong-extension basenames (`package.json`, `schema.sql`), multi-segment
 * paths with no whitespace (`context/current-state.md`, `instruments/speculum/src`).
 */
export function isPlausibleArtifact(raw: string): boolean {
  if (!raw || raw.length < 3 || raw.length > 512) return false;
  // Whitespace / control → prose or broken extract.
  if (/[\s\r\n\t]/.test(raw)) return false;
  // Escaped-newline fragments: JSON `\n` becomes a leading `/n…` after path
  // normalize (live: `/ntriggered-by`, `/npipeline`, `/n/n`, `/n2.`, `/n-`).
  // Do NOT ban mid-path `/n` — that rejects real paths like `shared/notes.md`.
  if (raw.startsWith("/n")) return false;
  // Markdown / separator noise folded into paths.
  if (raw.includes("---")) return false;
  // Mid-path escaped-newline runs: `/n/n` or `/n---` embedded after content.
  if (raw.includes("/n/n") || raw.includes("/n---")) return false;

  const segments = raw.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;

  for (const seg of segments) {
    if (DRIVE_SEGMENT_RE.test(seg)) continue;
    if (!PATH_SEGMENT_RE.test(seg)) return false;
    // Lone `n` / `n2` / `n2.` segments from `/n/n` and `/n2.` residue.
    if (/^n\d*\.?$/i.test(seg)) return false;
  }

  const last = segments[segments.length - 1]!;
  if (hasStrongFileExtension(last)) return true;

  // Multi-segment directory-style paths (no file ext on leaf) — only when every
  // segment is path-like and at least one is substantial (avoids `/n/n`→n/n).
  if (segments.length >= 2) {
    const meaningful = segments.filter((s) => !DRIVE_SEGMENT_RE.test(s));
    if (meaningful.length < 1) return false;
    if (meaningful.every((s) => s.length < 2)) return false;
    // Reject version-like leaves without a real extension (`…/2.1`).
    if (/^\d+(\.\d+)+$/.test(last)) return false;
    return true;
  }

  // Single segment without strong extension: prose / code / version tokens.
  return false;
}

function hasStrongFileExtension(name: string): boolean {
  // Last `.ext` only; compound `.d.ts` → ts (in allowlist).
  const m = name.match(/\.([A-Za-z][A-Za-z0-9]{0,15})$/);
  if (!m) return false;
  const ext = m[1]!.toLowerCase();
  if (/^\d+$/.test(ext)) return false;
  return STRONG_FILE_EXT.has(ext);
}

/** Closed vocabulary for session_links.kind. */
export type SessionLinkKind = "resumed_from" | "shared_artifact";

export interface SessionLinkRow {
  sourceSession: string;
  targetSession: string;
  kind: SessionLinkKind;
  method: string;
  confidence: number;
  heuristic: 0 | 1;
  evidence: string;
}

export interface RebuildSessionLinksOpts {
  /** Override sessions corpus root (tests / --sessions-dir). */
  sessionsDir?: string;
}

export interface RebuildSessionLinksStats {
  resumedFrom: number;
  sharedArtifact: number;
  total: number;
}

interface AggEdge {
  methods: Set<string>;
  confidence: number;
  heuristic: 0 | 1;
  /** artifact path → underlying link count (shared_artifact only). */
  artifacts: Map<string, number>;
  /** free-form evidence lines when no artifact map (resumed_from). */
  evidenceLines: string[];
}

function edgeKey(source: string, target: string, kind: SessionLinkKind): string {
  return `${source}\0${target}\0${kind}`;
}

function ensureAgg(
  map: Map<string, AggEdge>,
  source: string,
  target: string,
  kind: SessionLinkKind,
): AggEdge {
  const k = edgeKey(source, target, kind);
  let a = map.get(k);
  if (!a) {
    a = {
      methods: new Set(),
      confidence: 0,
      heuristic: 0,
      artifacts: new Map(),
      evidenceLines: [],
    };
    map.set(k, a);
  }
  return a;
}

function foldMethod(
  agg: AggEdge,
  method: string,
  confidence: number,
  heuristic: 0 | 1,
): void {
  if (method) agg.methods.add(method);
  if (confidence > agg.confidence) agg.confidence = confidence;
  if (heuristic === 1) agg.heuristic = 1;
}

function methodBanner(methods: Set<string>): string {
  return Array.from(methods).sort().join("+") || "unknown";
}

function sharedArtifactEvidence(artifacts: Map<string, number>): string {
  const entries = Array.from(artifacts.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const top = entries.slice(0, 3).map(([p, n]) => `${p}×${n}`);
  const more = entries.length > 3 ? ` +${entries.length - 3} more` : "";
  return `${entries.length} artifact(s), ${total} link(s): ${top.join(", ")}${more}`;
}

/**
 * Read summary.json parent_session_id when the harness recorded a fork/resume
 * lineage. Returns null when the file is missing or the field is absent.
 */
export function readRecordedParentSessionId(
  sessionsDir: string,
  projectPath: string,
  sessionId: string,
): string | null {
  const summaryPath = join(
    sessionsDir,
    encodeURIComponent(projectPath),
    sessionId,
    "summary.json",
  );
  if (!existsSync(summaryPath)) return null;
  try {
    const raw = readFileSync(summaryPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const parent = parsed.parent_session_id;
    if (typeof parent === "string") {
      const id = parent.trim();
      return id.length > 0 ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract resumed_from edges from summary.json parent_session_id.
 * Direction: prior session → continued session (temporal).
 * method=recorded, heuristic=0 — the record states the link.
 */
export function extractResumedFromLinks(
  db: Db,
  sessionsDir: string,
): SessionLinkRow[] {
  const sessions = db
    .query<{ id: string; project_path: string }, []>(
      "SELECT id, project_path FROM sessions",
    )
    .all();
  const known = new Set(sessions.map((s) => s.id));
  const out: SessionLinkRow[] = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    const parent = readRecordedParentSessionId(
      sessionsDir,
      s.project_path,
      s.id,
    );
    if (!parent || parent === s.id) continue;
    // Both endpoints must be present in the index (forgotten/missing prior skips).
    if (!known.has(parent)) continue;
    const k = edgeKey(parent, s.id, "resumed_from");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      sourceSession: parent,
      targetSession: s.id,
      kind: "resumed_from",
      method: "recorded",
      confidence: 1,
      heuristic: 0,
      evidence: `parent_session_id=${parent}`,
    });
  }
  return out;
}

type ToolEventRow = {
  id: number;
  session_id: string;
  ts: string;
  kind: string;
  tool_input: string | null;
  tool_output: string | null;
  tool_call_id: string | null;
};

export interface ArtifactUbiquityRow {
  artifact: string;
  sessionCount: number;
  /** True when sessionCount > ARTIFACT_UBIQUITY_MAX (commons; no pair edges). */
  excluded: boolean;
  /** False when the identity fails isPlausibleArtifact. */
  plausible: boolean;
}

/**
 * Count distinct sessions per extracted artifact identity (tool events).
 * Used by shared_artifact extraction and by measurement of excluded commons.
 * Includes implausible identities so measurement can audit the filter.
 */
export function listArtifactUbiquity(db: Db): ArtifactUbiquityRow[] {
  // Unfiltered identities so measurement can audit the plausibility gate.
  const sessionsByArt = collectArtifactSessions(db, false);
  const rows: ArtifactUbiquityRow[] = [];
  for (const [artifact, sessions] of sessionsByArt) {
    const sessionCount = sessions.size;
    const plausible = isPlausibleArtifact(artifact);
    rows.push({
      artifact,
      sessionCount,
      excluded: sessionCount > ARTIFACT_UBIQUITY_MAX,
      plausible,
    });
  }
  rows.sort((a, b) => {
    if (b.sessionCount !== a.sessionCount) return b.sessionCount - a.sessionCount;
    return a.artifact.localeCompare(b.artifact);
  });
  return rows;
}

/**
 * artifact → set of session ids that mention it (tool_use + matching results).
 * When `plausibleOnly`, drops identities that fail isPlausibleArtifact (edge path).
 */
function collectArtifactSessions(
  db: Db,
  plausibleOnly: boolean,
): Map<string, Set<string>> {
  const events = loadToolEvents(db);
  const resultsByCall = indexResultsByCall(events);
  const sessionsByArt = new Map<string, Set<string>>();

  for (const ev of events) {
    if (ev.kind !== "tool_use") continue;
    for (const art of artifactsForUse(ev, resultsByCall, plausibleOnly)) {
      let set = sessionsByArt.get(art);
      if (!set) {
        set = new Set();
        sessionsByArt.set(art, set);
      }
      set.add(ev.session_id);
    }
  }
  return sessionsByArt;
}

function loadToolEvents(db: Db): ToolEventRow[] {
  return db
    .query<ToolEventRow, []>(
      `SELECT id, session_id, ts, kind, tool_input, tool_output, tool_call_id
       FROM events
       WHERE kind IN ('tool_use', 'tool_result')
       ORDER BY ts, id`,
    )
    .all();
}

function indexResultsByCall(events: readonly ToolEventRow[]): Map<string, ToolEventRow> {
  const resultsByCall = new Map<string, ToolEventRow>();
  for (const ev of events) {
    if (ev.kind !== "tool_result" || !ev.tool_call_id) continue;
    resultsByCall.set(`${ev.session_id}\0${ev.tool_call_id}`, ev);
  }
  return resultsByCall;
}

function artifactsForUse(
  ev: ToolEventRow,
  resultsByCall: Map<string, ToolEventRow>,
  plausibleOnly: boolean,
): Set<string> {
  const arts = new Set([
    ...extractArtifactIds(ev.tool_input),
    ...extractArtifactIds(ev.tool_output),
  ]);
  const res = ev.tool_call_id
    ? resultsByCall.get(`${ev.session_id}\0${ev.tool_call_id}`)
    : undefined;
  if (res) {
    for (const a of extractArtifactIds(res.tool_output)) arts.add(a);
    for (const a of extractArtifactIds(res.tool_input)) arts.add(a);
  }
  if (!plausibleOnly) return arts;
  // Session-link edge path only: drop implausible extracts before pairing.
  const out = new Set<string>();
  for (const a of arts) {
    if (isPlausibleArtifact(a)) out.add(a);
  }
  return out;
}

/**
 * Cross-session shared_artifact edges.
 *
 * 1. Collapse any event_links whose endpoints already sit in different sessions
 *    (defensive; current event-link builder is intra-session only).
 * 2. Scan tool events for artifact paths (same extractors as event USED links),
 *    then keep only isPlausibleArtifact identities; first session to mention a
 *    path is the generator; a later different session that mentions it is the
 *    consumer → one aggregated edge per session pair. Artifacts appearing in
 *    more than ARTIFACT_UBIQUITY_MAX distinct sessions are excluded as a
 *    background commons (no pair edges).
 *
 * Path-token extraction is heuristic: every shared_artifact row from this
 * path sets heuristic=1 and method SHARED_ARTIFACT_METHOD.
 *
 * Direction: generator session → consumer session.
 */
export function extractSharedArtifactLinks(db: Db): SessionLinkRow[] {
  const agg = new Map<string, AggEdge>();

  // --- (1) existing event_links that already span sessions ---
  const crossLinks = db
    .query<
      {
        source_session: string;
        target_session: string;
        method: string;
        confidence: number;
        heuristic: number;
        kind: string;
      },
      []
    >(
      `SELECT s.session_id AS source_session,
              t.session_id AS target_session,
              el.method,
              el.confidence,
              el.heuristic,
              el.kind
       FROM event_links el
       JOIN events s ON s.id = el.source_event_id
       JOIN events t ON t.id = el.target_event_id
       WHERE s.session_id != t.session_id`,
    )
    .all();

  for (const row of crossLinks) {
    // Prefer USED-style artifact methods; still fold other cross-session kinds
    // that name a real recorded link between sessions.
    const method =
      row.kind === "USED"
        ? SHARED_ARTIFACT_METHOD
        : `${row.kind}:${row.method}; plausible; ubiquity<=${ARTIFACT_UBIQUITY_MAX}`;
    const a = ensureAgg(agg, row.source_session, row.target_session, "shared_artifact");
    // Path-token / link collapse is always heuristic.
    foldMethod(a, method, row.confidence, 1);
    const label = `event_link:${row.kind}`;
    a.artifacts.set(label, (a.artifacts.get(label) ?? 0) + 1);
  }

  // --- (2) artifact-path scan: plausible only, then ubiquity threshold ---
  const events = loadToolEvents(db);
  const resultsByCall = indexResultsByCall(events);

  // Pass A: distinct sessions per plausible artifact (for commons exclusion).
  const sessionsByArt = new Map<string, Set<string>>();
  // Pass B material: ordered mentions (tool_use only).
  type Mention = { sessionId: string; ts: string; eventId: number; arts: Set<string> };
  const mentions: Mention[] = [];

  for (const ev of events) {
    if (ev.kind !== "tool_use") continue;
    const arts = artifactsForUse(ev, resultsByCall, true);
    if (arts.size === 0) continue;
    mentions.push({
      sessionId: ev.session_id,
      ts: ev.ts,
      eventId: ev.id,
      arts,
    });
    for (const art of arts) {
      let set = sessionsByArt.get(art);
      if (!set) {
        set = new Set();
        sessionsByArt.set(art, set);
      }
      set.add(ev.session_id);
    }
  }

  // First session (by global event order) that mentions each non-commons artifact.
  type ArtGen = { sessionId: string; ts: string; eventId: number };
  const firstArtifact = new Map<string, ArtGen>();

  for (const m of mentions) {
    for (const art of m.arts) {
      const sessionCount = sessionsByArt.get(art)?.size ?? 0;
      if (sessionCount > ARTIFACT_UBIQUITY_MAX) continue; // commons — no pairs

      const prior = firstArtifact.get(art);
      if (!prior) {
        firstArtifact.set(art, {
          sessionId: m.sessionId,
          ts: m.ts,
          eventId: m.eventId,
        });
        continue;
      }
      if (prior.sessionId === m.sessionId) continue;
      // Consumer session uses an artifact first seen in a different session.
      const a = ensureAgg(
        agg,
        prior.sessionId,
        m.sessionId,
        "shared_artifact",
      );
      foldMethod(a, SHARED_ARTIFACT_METHOD, 0.9, 1);
      a.artifacts.set(art, (a.artifacts.get(art) ?? 0) + 1);
    }
  }

  const out: SessionLinkRow[] = [];
  for (const [k, a] of agg) {
    const [source, target, kind] = k.split("\0") as [string, string, SessionLinkKind];
    if (source === target) continue;
    out.push({
      sourceSession: source,
      targetSession: target,
      kind,
      method: methodBanner(a.methods),
      confidence: a.confidence,
      // Path-token extraction is always heuristic for shared_artifact.
      heuristic: 1,
      evidence: sharedArtifactEvidence(a.artifacts),
    });
  }
  return out;
}

function persistSessionLinks(db: Db, links: readonly SessionLinkRow[]): void {
  const stmt = db.prepare(
    `INSERT INTO session_links
       (source_session, target_session, kind, method, confidence, heuristic, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_session, target_session, kind) DO UPDATE SET
       method = excluded.method,
       confidence = excluded.confidence,
       heuristic = excluded.heuristic,
       evidence = excluded.evidence`,
  );
  for (const l of links) {
    stmt.run(
      l.sourceSession,
      l.targetSession,
      l.kind,
      l.method,
      l.confidence,
      l.heuristic,
      l.evidence,
    );
  }
}

/** Wipe + re-derive session_links from the settled index (and on-disk summaries). */
export function rebuildSessionLinks(
  db: Db,
  opts: RebuildSessionLinksOpts = {},
): RebuildSessionLinksStats {
  db.run("DELETE FROM session_links");

  const sessionsDir = opts.sessionsDir ?? sessionsRoot();
  const resumed = extractResumedFromLinks(db, sessionsDir);
  const shared = extractSharedArtifactLinks(db);

  persistSessionLinks(db, [...resumed, ...shared]);

  return {
    resumedFrom: resumed.length,
    sharedArtifact: shared.length,
    total: resumed.length + shared.length,
  };
}

/** List session_links for CLI / tests. */
export function listSessionLinks(
  db: Db,
  opts: { sessionId?: string; kind?: string; limit?: number } = {},
): SessionLinkRow[] {
  const wheres: string[] = [];
  const params: (string | number)[] = [];
  if (opts.sessionId) {
    wheres.push("(source_session = ? OR target_session = ?)");
    params.push(opts.sessionId, opts.sessionId);
  }
  if (opts.kind) {
    wheres.push("kind = ?");
    params.push(opts.kind);
  }
  const limit = opts.limit ?? 500;
  const sql = `
    SELECT source_session, target_session, kind, method, confidence, heuristic, evidence
    FROM session_links
    ${wheres.length ? `WHERE ${wheres.join(" AND ")}` : ""}
    ORDER BY kind, source_session, target_session
    LIMIT ${Math.trunc(limit)}
  `;
  return db
    .query<
      {
        source_session: string;
        target_session: string;
        kind: string;
        method: string;
        confidence: number;
        heuristic: number;
        evidence: string;
      },
      (string | number)[]
    >(sql)
    .all(...params)
    .map((r) => ({
      sourceSession: r.source_session,
      targetSession: r.target_session,
      kind: r.kind as SessionLinkKind,
      method: r.method,
      confidence: r.confidence,
      heuristic: r.heuristic === 1 ? 1 : 0,
      evidence: r.evidence,
    }));
}
