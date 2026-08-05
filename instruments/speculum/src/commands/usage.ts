/**
 * Token / turn aggregation from turn_completed usage rows.
 * Counts and tokens only — no price table in v1 (provider prices vary per user).
 */

import { openDb, type Db } from "../store/db";

export interface UsageModelReport {
  model: string;
  turns: number;
  sessions: number;
  tokens: {
    input: number;
    output: number;
    cachedRead: number;
    reasoning: number;
    total: number;
  };
}

export interface UsageReport {
  window: { since: string | null; until: string | null };
  models: UsageModelReport[];
  totals: {
    turns: number;
    sessions: number;
    tokens: {
      input: number;
      output: number;
      cachedRead: number;
      reasoning: number;
      total: number;
    };
  };
  note: string;
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
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

export function buildUsageReport(
  db: Db,
  opts: { since?: string | null; until?: string | null; model?: string } = {},
): UsageReport {
  const wheres: string[] = ["1=1"];
  const params: (string | number)[] = [];
  if (opts.since) {
    wheres.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    wheres.push("ts <= ?");
    params.push(opts.until);
  }
  if (opts.model) {
    wheres.push("model_id LIKE '%' || ? || '%'");
    params.push(opts.model);
  }

  const rows = db
    .query<
      {
        model_id: string | null;
        session_id: string;
        input_tokens: number;
        output_tokens: number;
        cached_read_tokens: number;
        reasoning_tokens: number;
        total_tokens: number;
        num_turns: number;
      },
      (string | number)[]
    >(
      `SELECT model_id, session_id, input_tokens, output_tokens, cached_read_tokens,
              reasoning_tokens, total_tokens, num_turns
       FROM usage WHERE ${wheres.join(" AND ")}`,
    )
    .all(...params);

  const byModel = new Map<
    string,
    {
      turns: number;
      sessions: Set<string>;
      input: number;
      output: number;
      cachedRead: number;
      reasoning: number;
      total: number;
    }
  >();

  for (const r of rows) {
    const model = r.model_id || "(unknown)";
    let acc = byModel.get(model);
    if (!acc) {
      acc = {
        turns: 0,
        sessions: new Set(),
        input: 0,
        output: 0,
        cachedRead: 0,
        reasoning: 0,
        total: 0,
      };
      byModel.set(model, acc);
    }
    // Prefer num_turns when present; otherwise each usage row is one completed turn.
    acc.turns += r.num_turns > 0 ? r.num_turns : 1;
    acc.sessions.add(r.session_id);
    acc.input += r.input_tokens;
    acc.output += r.output_tokens;
    acc.cachedRead += r.cached_read_tokens;
    acc.reasoning += r.reasoning_tokens;
    acc.total += r.total_tokens > 0 ? r.total_tokens : r.input_tokens + r.output_tokens;
  }

  const models: UsageModelReport[] = Array.from(byModel.entries())
    .map(([model, a]) => ({
      model,
      turns: a.turns,
      sessions: a.sessions.size,
      tokens: {
        input: a.input,
        output: a.output,
        cachedRead: a.cachedRead,
        reasoning: a.reasoning,
        total: a.total,
      },
    }))
    .sort((a, b) => b.tokens.total - a.tokens.total);

  const totals = {
    turns: 0,
    sessions: new Set<string>(),
    tokens: { input: 0, output: 0, cachedRead: 0, reasoning: 0, total: 0 },
  };
  for (const r of rows) totals.sessions.add(r.session_id);
  for (const m of models) {
    totals.turns += m.turns;
    totals.tokens.input += m.tokens.input;
    totals.tokens.output += m.tokens.output;
    totals.tokens.cachedRead += m.tokens.cachedRead;
    totals.tokens.reasoning += m.tokens.reasoning;
    totals.tokens.total += m.tokens.total;
  }

  return {
    window: { since: opts.since ?? null, until: opts.until ?? null },
    models,
    totals: {
      turns: totals.turns,
      sessions: totals.sessions.size,
      tokens: totals.tokens,
    },
    note: "Token and turn counts only. No price table in v1 — provider prices vary per user.",
  };
}

export async function usageCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const since = parseBound(opt(args, "--since"), false);
  const until = parseBound(opt(args, "--until"), true);
  const model = opt(args, "--model");

  const db = openDb();
  try {
    const report = buildUsageReport(db, { since, until, model });
    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log("");
    console.log("speculum usage");
    console.log("─".repeat(60));
    console.log(`  ${report.note}`);
    if (report.window.since || report.window.until) {
      console.log(
        `  window: ${report.window.since ?? "…"} → ${report.window.until ?? "…"}`,
      );
    }
    console.log(
      `  totals: turns=${report.totals.turns} sessions=${report.totals.sessions} tokens=${report.totals.tokens.total} (in=${report.totals.tokens.input} out=${report.totals.tokens.output} cache=${report.totals.tokens.cachedRead} reason=${report.totals.tokens.reasoning})`,
    );
    if (report.models.length === 0) {
      console.log("  (no usage rows — ingest sessions that contain turn_completed events)");
    } else {
      console.log("  by model:");
      for (const m of report.models) {
        console.log(
          `    ${m.model.padEnd(36)} turns=${String(m.turns).padStart(4)}  tok=${m.tokens.total} (in=${m.tokens.input} out=${m.tokens.output} cache=${m.tokens.cachedRead} reason=${m.tokens.reasoning})`,
        );
      }
    }
    console.log("");
  } finally {
    db.close();
  }
}
