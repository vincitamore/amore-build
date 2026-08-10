/**
 * `speculum search <query>` — sparse FTS5 over the local derived index.
 * Local only; no network, no model. Hybrid = RRF of FTS + recency (not embeddings).
 */

import { openDb, type Db } from "../store/db";
import {
  createSearchBackend,
  type SearchHit,
  type SearchOpts,
} from "../store/search";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Parse --since / --until as local calendar dates (YYYY-MM-DD) or full ISO. */
function parseBound(s: string | undefined, endOfDay: boolean): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function collectQuery(args: string[]): string {
  const flagsWithValue = new Set([
    "--limit",
    "--since",
    "--until",
    "--project",
    "--session",
  ]);
  const bare: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json" || a === "--fts-only" || a === "--help" || a === "-h") continue;
    if (flagsWithValue.has(a)) {
      i++; // skip value
      continue;
    }
    if (a.startsWith("--")) continue;
    bare.push(a);
  }
  return bare.join(" ").trim();
}

export function buildSearchHits(
  db: Db,
  query: string,
  opts: SearchOpts = {},
): SearchHit[] {
  return createSearchBackend(db).search(query, opts);
}

function printTable(hits: SearchHit[], query: string, opts: SearchOpts): void {
  console.log("");
  console.log("speculum search");
  console.log("─".repeat(72));
  console.log(
    `  query: ${query || "(empty → recency)"}  ·  hybrid = FTS BM25 ⊕ recency RRF (k=60), not embeddings`,
  );
  if (opts.since || opts.until) {
    console.log(`  window: ${opts.since ?? "…"} → ${opts.until ?? "…"}`);
  }
  if (opts.project) console.log(`  project: ${opts.project}`);
  if (opts.ftsOnly) console.log("  mode: fts-only (no recency fusion)");
  console.log(`  hits: ${hits.length}`);
  if (hits.length === 0) {
    console.log("  (no matches)");
    console.log("");
    return;
  }
  console.log("");
  for (const h of hits) {
    const score = h.score.toFixed(4);
    const tool = h.toolName ? ` tool=${h.toolName}` : "";
    console.log(
      `  [${score}] ${h.backend.padEnd(7)} e=${h.eventId} ${h.kind}${tool}  ${h.ts}`,
    );
    console.log(`           sess=${h.sessionId.slice(0, 8)}…  ${h.projectPath}`);
    const snip = (h.snippet || "").replace(/\s+/g, " ").trim();
    if (snip) console.log(`           ${snip.slice(0, 120)}`);
  }
  console.log("");
}

export async function searchCommand(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(`speculum search <query> [options]

Sparse full-text search over the local derived index (FTS5 BM25).
Default ranking fuses FTS relevance with recency via RRF (k=60) —
sparse-recency hybrid, not embeddings.

Options:
  --limit N       Max hits (default 20)
  --since D       Inclusive lower bound (YYYY-MM-DD or ISO)
  --until D       Inclusive upper bound (YYYY-MM-DD or ISO)
  --project P     Substring filter on project path
  --session ID    Exact session id
  --fts-only      Pure BM25 order (skip recency fusion)
  --json          Machine-readable hits array
`);
    return;
  }

  const query = collectQuery(args);
  if (!query && !hasFlag(args, "--json")) {
    // Allow empty only for explicit tooling; human path wants a query.
    // Still run (recency) so --json scripts can list recent rows if desired.
  }

  const limitRaw = opt(args, "--limit");
  const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10) || 20) : 20;
  const since = parseBound(opt(args, "--since"), false);
  const until = parseBound(opt(args, "--until"), true);
  const project = opt(args, "--project");
  const sessionId = opt(args, "--session");
  const ftsOnly = hasFlag(args, "--fts-only");
  const json = hasFlag(args, "--json");

  if (!query) {
    console.error("usage: speculum search <query> [--limit N] [--since D] [--until D] [--json]");
    process.exit(1);
  }

  const searchOpts: SearchOpts = {
    limit,
    since,
    until,
    project: project ?? null,
    sessionId: sessionId ?? null,
    ftsOnly,
  };

  const db = openDb();
  try {
    const hits = buildSearchHits(db, query, searchOpts);
    if (json || !process.stdout.isTTY) {
      console.log(
        JSON.stringify(
          {
            query,
            opts: {
              limit,
              since,
              until,
              project: project ?? null,
              sessionId: sessionId ?? null,
              ftsOnly,
              method: ftsOnly ? "fts-bm25" : "rrf-fts-recency",
              note: "Sparse FTS5 + optional recency RRF. Not embeddings.",
            },
            hits,
          },
          null,
          2,
        ),
      );
      return;
    }
    printTable(hits, query, searchOpts);
  } finally {
    db.close();
  }
}
