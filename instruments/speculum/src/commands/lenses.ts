/**
 * `speculum lenses` — list available lenses and their egress note.
 */

import { listLenses } from "../lenses";
import { defaultAuditPath } from "../paths";

export async function lensesCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const lenses = listLenses();

  if (json || !process.stdout.isTTY) {
    console.log(
      JSON.stringify(
        {
          lenses: lenses.map((l) => ({
            name: l.name,
            summary: l.summary,
            egressNote: l.egressNote,
            selectionHint: l.selectionHint,
          })),
          auditPath: defaultAuditPath(),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log("speculum lenses");
  console.log("─".repeat(60));
  for (const l of lenses) {
    console.log(`  ${l.name}`);
    console.log(`    ${l.summary}`);
    console.log(`    selection: ${l.selectionHint}`);
    console.log(`    egress:    ${l.egressNote}`);
    console.log("");
  }
  console.log(`  audit log: ${defaultAuditPath()}`);
  console.log("");
  console.log(
    "Nothing is sent without an explicit `speculum lens <name>` command.",
  );
  console.log(
    "The scrubber fails closed: residual secrets or oversize payloads abort the send.",
  );
  console.log("");
}
