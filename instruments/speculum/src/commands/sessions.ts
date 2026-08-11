/**
 * `speculum sessions` — filtered, paged session listing over the derived index.
 * Local only; never egresses.
 */

export async function sessionsCommand(_args: string[]): Promise<void> {
  console.error("sessions: not implemented");
  process.exit(70);
}
