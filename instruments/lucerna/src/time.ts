/**
 * Local timestamps for lucerna state and health files.
 */

export function toLocalISO(date: Date = new Date()): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

export function localTimestamp(): string {
  return toLocalISO(new Date());
}

export function localDate(): string {
  return toLocalISO().slice(0, 10);
}

export function localFileTimestamp(): string {
  return toLocalISO().replace(/:/g, "-");
}
