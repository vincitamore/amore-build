/**
 * `speculum summarize` — generate one-line titles for untitled sessions by
 * sending a scrubbed, compacted digest through the local amore binary.
 * Opt-in egress: scrub fails closed, every run is audited, results land in
 * generated_titles (which ingest --full never wipes).
 */

export async function summarizeCommand(_args: string[]): Promise<void> {
  console.error("summarize: not implemented");
  process.exit(70);
}
