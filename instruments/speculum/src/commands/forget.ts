import { openDb } from "../store/db";
import { forgetSession } from "../ingest/forget";

export async function forgetCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const sessionPrefix = args.find((a) => !a.startsWith("--"));

  if (!sessionPrefix) {
    console.error(
      "usage: speculum forget <session-id-or-prefix> [--json]\n  deletes index rows for that session; source files on disk are untouched",
    );
    process.exit(1);
  }

  const db = openDb();
  try {
    const result = forgetSession(db, sessionPrefix);
    if (!result.ok) {
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.error(result.message);
        if (result.matchedSessions.length > 1) {
          for (const id of result.matchedSessions.slice(0, 12)) console.error(`  - ${id}`);
        }
      }
      process.exit(1);
    }

    if (json || !process.stdout.isTTY) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log("");
    console.log(`speculum forget — ${result.sessionId}`);
    console.log("─".repeat(60));
    console.log(`  ${result.message}`);
    console.log("");
  } finally {
    db.close();
  }
}
