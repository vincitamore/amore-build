/**
 * `speculum decisions` — list / chain / impact over derived decisions + event_links.
 * Local only. Every row is heuristic — method banners are required.
 */

import { openDb, type Db } from "../store/db";
import {
  listDecisions,
  getDecision,
  decisionSummary,
  chainUpstream,
  chainDownstream,
  type DecisionRow,
} from "../decisions";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseBound(s: string | undefined, endOfDay: boolean): string | undefined {
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s}T23:59:59.999Z` : `${s}T00:00:00.000Z`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function bareArgs(args: string[]): string[] {
  const skipVal = new Set([
    "--session",
    "--category",
    "--since",
    "--until",
    "--project",
    "--limit",
    "--depth",
  ]);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (
      a === "--json" ||
      a === "--summary" ||
      a === "--help" ||
      a === "-h"
    ) {
      continue;
    }
    if (skipVal.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

export function decisionsHelpText(): string {
  return `speculum decisions [subcommand] [options]

Derived decisions table + typed event_links walks. Heuristic — not compliance.
Every decision and heuristic link carries a method banner.

Subcommands:
  list                 List decisions (default)
  chain <id|eventId>   Upstream walk over event_links from a decision/event
  impact <id|eventId>  Downstream walk over event_links
  summary              Category / method rollup

Options:
  --session ID         Exact session filter
  --category C         operator_correction | plan_step | task_outcome | tool_recovery
  --project P          Project path substring
  --since D            Inclusive lower bound
  --until D            Inclusive upper bound
  --limit N            Max list rows (default 50)
  --depth N            Max chain/impact depth (default 8)
  --summary            Alias for summary subcommand
  --json               Machine-readable output

HEURISTIC: extracted decisions and non-tool_call_id links are pattern-derived.
`;
}

function resolveSeedEventId(db: Db, raw: string): {
  seedEventId: number | null;
  decision: DecisionRow | null;
} {
  // Decision id form: dec:<eventId>:<category>
  const dec = getDecision(db, raw);
  if (dec) {
    return { seedEventId: dec.sourceEventId, decision: dec };
  }
  // Bare event id or e:N
  const s = raw.startsWith("e:") ? raw.slice(2) : raw;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) {
    return { seedEventId: Math.trunc(n), decision: null };
  }
  // dec: prefix without exact match — try parse event id from it
  const m = /^dec:(\d+):/.exec(raw);
  if (m) {
    return { seedEventId: Number(m[1]), decision: null };
  }
  return { seedEventId: null, decision: null };
}

function printDecision(d: DecisionRow): void {
  console.log(
    `  ${d.id}  [${d.category}]  ${d.ts}  maker=${d.decisionMaker ?? "—"}  outcome=${d.outcome ?? "—"}`,
  );
  console.log(`    method: ${d.method}  conf=${d.confidence ?? "—"}  e=${d.sourceEventId ?? "—"}`);
  if (d.scenario) console.log(`    scenario: ${d.scenario.slice(0, 120)}`);
  if (d.reasoning) console.log(`    evidence: ${d.reasoning.slice(0, 120)}`);
}

export async function decisionsCommand(args: string[]): Promise<void> {
  if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(decisionsHelpText());
    return;
  }

  const bare = bareArgs(args);
  const json = hasFlag(args, "--json");
  const wantSummary = hasFlag(args, "--summary") || bare[0] === "summary";
  let sub = bare[0] ?? "list";
  let rest = bare.slice(1);

  if (wantSummary && sub !== "chain" && sub !== "impact") {
    sub = "summary";
  }
  if (sub !== "list" && sub !== "chain" && sub !== "impact" && sub !== "summary") {
    // Treat first bare as filter-less list, or as decision id for show-ish list
    rest = [sub, ...rest];
    sub = "list";
  }

  const limitRaw = opt(args, "--limit");
  const limit = limitRaw ? Math.max(1, Number(limitRaw) || 50) : 50;
  const depthRaw = opt(args, "--depth");
  const depth = depthRaw ? Math.max(1, Number(depthRaw) || 8) : 8;

  const listOpts = {
    sessionId: opt(args, "--session"),
    category: opt(args, "--category"),
    project: opt(args, "--project"),
    since: parseBound(opt(args, "--since"), false),
    until: parseBound(opt(args, "--until"), true),
    limit,
  };

  const db = openDb();
  try {
    if (sub === "summary") {
      const s = decisionSummary(db);
      const payload = {
        ...s,
        note: "HEURISTIC — method banners on every decision; re-derived on ingest",
      };
      if (json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log("");
      console.log("speculum decisions summary");
      console.log("─".repeat(72));
      console.log(`  total: ${s.total}  (heuristic distillation, re-derived on ingest)`);
      console.log("  by category:");
      for (const [k, v] of Object.entries(s.byCategory)) {
        console.log(`    ${k}: ${v}`);
      }
      console.log("  by method:");
      for (const [k, v] of Object.entries(s.byMethod)) {
        console.log(`    ${k}: ${v}`);
      }
      console.log("");
      return;
    }

    if (sub === "list") {
      const rows = listDecisions(db, listOpts);
      if (json) {
        console.log(
          JSON.stringify(
            {
              decisions: rows,
              note: "HEURISTIC — each method field is a required banner",
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log("");
      console.log("speculum decisions");
      console.log("─".repeat(72));
      console.log(
        `  ${rows.length} decision(s)  ·  HEURISTIC (method banner on every row)`,
      );
      if (rows.length === 0) {
        console.log("  (none — re-ingest to rebuild derived tables)");
        console.log("");
        return;
      }
      console.log("");
      for (const d of rows) printDecision(d);
      console.log("");
      return;
    }

    if (sub === "chain" || sub === "impact") {
      const raw = rest[0];
      if (!raw) {
        console.error(`usage: speculum decisions ${sub} <decisionId|eventId>`);
        process.exit(1);
      }
      const { seedEventId, decision } = resolveSeedEventId(db, raw);
      if (seedEventId === null) {
        console.error(`could not resolve seed event from: ${raw}`);
        process.exit(1);
      }
      const nodes =
        sub === "chain"
          ? chainUpstream(db, seedEventId, depth)
          : chainDownstream(db, seedEventId, depth);
      const payload = {
        subcommand: sub,
        seed: raw,
        seedEventId,
        decision,
        nodes,
        note: "Walk uses durable event_links (method-labeled). HEURISTIC where method ≠ tool_call_id.",
      };
      if (json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log("");
      console.log(`speculum decisions ${sub}  seed=e:${seedEventId}`);
      console.log("─".repeat(72));
      if (decision) {
        console.log(`  decision: ${decision.id}  [${decision.category}]  method=${decision.method}`);
      }
      console.log(`  depth cap: ${depth}  nodes: ${nodes.length}`);
      for (const n of nodes) {
        const via =
          n.viaKind != null
            ? `  via ${n.viaKind} (${n.viaMethod ?? "?"})`
            : "  (seed)";
        console.log(`  d${n.depth}  e:${n.eventId}${via}`);
      }
      console.log("");
      console.log(
        "  note: link methods are labels — tool_call_id is deterministic; others are heuristic.",
      );
      console.log("");
      return;
    }

    console.error(`unknown decisions subcommand: ${sub}`);
    console.log(decisionsHelpText());
    process.exit(1);
  } finally {
    db.close();
  }
}
