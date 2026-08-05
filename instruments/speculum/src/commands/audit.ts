/**
 * `speculum audit [-n N]` — tail the append-only lens audit log.
 */

import { defaultAuditPath, readAuditTail } from "../audit";

export async function auditCommand(args: string[]): Promise<void> {
  let n = 20;
  const nIdx = args.indexOf("-n");
  if (nIdx >= 0 && args[nIdx + 1]) {
    const parsed = Number.parseInt(args[nIdx + 1]!, 10);
    if (Number.isFinite(parsed) && parsed > 0) n = parsed;
  }
  // Also accept --n N
  const nLong = args.indexOf("--n");
  if (nLong >= 0 && args[nLong + 1]) {
    const parsed = Number.parseInt(args[nLong + 1]!, 10);
    if (Number.isFinite(parsed) && parsed > 0) n = parsed;
  }

  const path = defaultAuditPath();
  const json = args.includes("--json");
  const rows = readAuditTail(path, n);

  if (json || !process.stdout.isTTY) {
    console.log(JSON.stringify({ path, n, records: rows }, null, 2));
    return;
  }

  console.log("");
  console.log(`speculum audit  (last ${n})`);
  console.log(`  path: ${path}`);
  console.log("─".repeat(60));
  if (rows.length === 0) {
    console.log("  (empty)");
    console.log("");
    return;
  }
  for (const r of rows) {
    const sel =
      r.selection.sessionId ??
      (r.selection.lastN ? `last-n=${r.selection.lastN}` : "…");
    const usage =
      r.usage && typeof r.usage.total_tokens === "number"
        ? ` tokens=${r.usage.total_tokens}`
        : "";
    console.log(
      `  ${r.ts}  ${r.lens}  ${r.decision}  bytes=${r.payloadBytes}  sel=${sel}` +
        (r.modelId ? `  model=${r.modelId}` : "") +
        usage +
        (r.reason ? `  (${r.reason.slice(0, 80)})` : ""),
    );
  }
  console.log("");
}
