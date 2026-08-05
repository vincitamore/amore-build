/**
 * Stuck-loop probe for Amore tool vocabulary.
 * Fingerprints use rawInput fields: command, target_file, path, pattern, etc.
 */

import type { Db } from "../store/db";
import { toolUses } from "../store/queries";
import { wilson95 } from "../stats";
import type { Probe, ProbeOptions, ProbeResult } from "./types";
import { queryOptsFromProbe } from "./types";

const WINDOW_SIZE = 6;
const THRESHOLD = 3;

/** Polling / status tools that legitimately repeat. */
const POLLING_EXEMPT = new Set([
  "get_command_or_subagent_output",
  "todo_write",
]);

function parseInput(toolInputJson: string | null): unknown {
  if (toolInputJson === null) return null;
  try {
    return JSON.parse(toolInputJson);
  } catch {
    return null;
  }
}

function getString(o: unknown, key: string): string | null {
  if (typeof o !== "object" || o === null) return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

function getNumber(o: unknown, key: string): number | null {
  if (typeof o !== "object" || o === null) return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "number" ? v : null;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/**
 * Fingerprint one tool call for near-identical repeat detection.
 * Returns null for polling-exempt tools.
 */
export function computeFingerprint(toolName: string, input: unknown): string | null {
  if (POLLING_EXEMPT.has(toolName)) return null;

  switch (toolName) {
    case "run_terminal_command": {
      const cmd = getString(input, "command") ?? "";
      let norm = cmd.replace(/\s+/g, " ").trim();
      norm = norm.replace(/\|\s*head\s+-n?\s*\d+\s*$/i, "|head");
      norm = norm.replace(/\|\s*tail\s+-n?\s*\d+\s*$/i, "|tail");
      return `run_terminal_command|${norm}`;
    }
    case "search_replace": {
      const fp = getString(input, "file_path") ?? getString(input, "path") ?? "";
      const old = (getString(input, "old_string") ?? "").slice(0, 80);
      return `search_replace|${fp}|${old}`;
    }
    case "read_file": {
      const fp = getString(input, "target_file") ?? getString(input, "file_path") ?? "";
      const offset = getNumber(input, "offset") ?? 0;
      return `read_file|${fp}|band${Math.floor(offset / 200)}`;
    }
    case "write": {
      const fp = getString(input, "file_path") ?? getString(input, "path") ?? "";
      return `write|${fp}`;
    }
    case "grep": {
      const pattern = getString(input, "pattern") ?? "";
      const path = getString(input, "path") ?? "";
      const glob = getString(input, "glob") ?? "";
      return `grep|${pattern}|${path}|${glob}`;
    }
    case "list_dir": {
      const target = getString(input, "target_directory") ?? getString(input, "path") ?? "";
      return `list_dir|${target}`;
    }
    case "spawn_subagent":
    case "Task": {
      const typ = getString(input, "subagent_type") ?? "";
      const desc = (getString(input, "description") ?? "").slice(0, 60);
      return `subagent|${typ}|${desc}`;
    }
    default: {
      const sorted = sortKeys(input);
      return `${toolName}|${JSON.stringify(sorted).slice(0, 200)}`;
    }
  }
}

function targetPath(toolName: string, input: unknown): string | null {
  if (toolName === "search_replace" || toolName === "write") {
    return getString(input, "file_path") ?? getString(input, "path");
  }
  return null;
}

export const stuckLoop: Probe = (db: Db, opts: ProbeOptions = {}): ProbeResult => {
  const queryOpts = queryOptsFromProbe(opts);
  const sessions = new Map<
    string,
    Array<{
      ts: string;
      toolName: string;
      fp: string | null;
      targetPath: string | null;
      projectPath: string;
    }>
  >();
  let totalEvents = 0;

  for (const t of toolUses(db, { ...queryOpts, includeSubagents: true })) {
    totalEvents++;
    const input = parseInput(t.toolInput);
    const fp = computeFingerprint(t.toolName, input);
    let arr = sessions.get(t.sessionId);
    if (!arr) {
      arr = [];
      sessions.set(t.sessionId, arr);
    }
    arr.push({
      ts: t.ts,
      toolName: t.toolName,
      fp,
      targetPath: targetPath(t.toolName, input),
      projectPath: t.projectPath,
    });
  }

  const detectedLoops: Array<{
    sessionId: string;
    projectPath: string;
    fingerprint: string;
    toolName: string;
    startTs: string;
    endTs: string;
    count: number;
  }> = [];
  const byTool = new Map<string, number>();
  const sessionLoopCounts = new Map<string, { project: string; loops: number }>();

  for (const [sessionId, calls] of sessions) {
    if (calls.length < THRESHOLD) continue;
    const emitted = new Set<string>();
    const fpCounts = new Map<string, number>();
    const recentWindow: string[] = [];

    for (let i = 0; i < calls.length; i++) {
      const c = calls[i]!;

      // Recovery credit: edit/write to a path softens shell loops that hit that path.
      if ((c.toolName === "search_replace" || c.toolName === "write") && c.targetPath) {
        for (const [fp, count] of fpCounts) {
          if (fp.startsWith("run_terminal_command|") && fp.includes(c.targetPath)) {
            fpCounts.set(fp, Math.max(0, count - 1));
          }
        }
      }
      if (c.fp === null) continue;

      recentWindow.push(c.fp);
      if (recentWindow.length > WINDOW_SIZE) {
        const dropped = recentWindow.shift()!;
        fpCounts.set(dropped, Math.max(0, (fpCounts.get(dropped) ?? 0) - 1));
      }
      fpCounts.set(c.fp, (fpCounts.get(c.fp) ?? 0) + 1);

      const count = fpCounts.get(c.fp) ?? 0;
      if (count >= THRESHOLD && !emitted.has(c.fp)) {
        emitted.add(c.fp);
        const startIdx = i - recentWindow.length + 1 + recentWindow.indexOf(c.fp);
        const startCall = calls[Math.max(0, startIdx)] ?? c;
        detectedLoops.push({
          sessionId,
          projectPath: c.projectPath,
          fingerprint: c.fp,
          toolName: c.toolName,
          startTs: startCall.ts,
          endTs: c.ts,
          count,
        });
        byTool.set(c.toolName, (byTool.get(c.toolName) ?? 0) + 1);
        let sl = sessionLoopCounts.get(sessionId);
        if (!sl) {
          sl = { project: c.projectPath, loops: 0 };
          sessionLoopCounts.set(sessionId, sl);
        }
        sl.loops++;
      }
    }
  }

  const ci = wilson95(sessionLoopCounts.size, sessions.size);
  return {
    probe: "stuck-loop",
    value: sessionLoopCounts.size,
    ciLow: ci.lower,
    ciHigh: ci.upper,
    n: sessions.size,
    partial: false,
    unit: "session",
    summary: `${detectedLoops.length} loops detected across ${sessionLoopCounts.size} of ${sessions.size} sessions [heuristic]`,
    data: {
      totalEvents,
      totalSessions: sessions.size,
      totalLoops: detectedLoops.length,
      byTool: Array.from(byTool.entries())
        .map(([tool, loops]) => ({ tool, loops }))
        .sort((a, b) => b.loops - a.loops),
      loops: detectedLoops.slice(0, 50),
    },
    heuristic: true,
  };
};
