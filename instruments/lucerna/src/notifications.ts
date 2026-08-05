/**
 * House-local notification queue for operator-facing cycle outcomes.
 *
 * Path: <house>/instruments/lucerna/notifications.jsonl
 * Append-only JSONL; writer truncates to the newest 200 lines when exceeding 500.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { localTimestamp } from "./time.ts";
import { RUNTIME_FILES } from "./paths.ts";

export type NotificationLevel = "info" | "warn" | "error";

export interface LucernaNotification {
  ts: string;
  level: NotificationLevel;
  kind: string;
  message: string;
  ref?: string;
}

/** Soft cap: when line count exceeds this, keep the newest KEEP_LINES. */
export const NOTIFICATIONS_ROTATE_AT = 500;
export const NOTIFICATIONS_KEEP_LINES = 200;

export function notificationsPath(runtimeDir: string): string {
  return join(runtimeDir, RUNTIME_FILES.notifications);
}

export function appendNotification(
  runtimeDir: string,
  entry: Omit<LucernaNotification, "ts"> & { ts?: string },
): void {
  mkdirSync(runtimeDir, { recursive: true });
  const path = notificationsPath(runtimeDir);
  const line: LucernaNotification = {
    ts: entry.ts ?? localTimestamp(),
    level: entry.level,
    kind: entry.kind,
    message: entry.message.replace(/\s+/g, " ").trim(),
  };
  if (entry.ref) line.ref = entry.ref;

  appendFileSync(path, JSON.stringify(line) + "\n", "utf-8");
  rotateNotificationsIfNeeded(runtimeDir);
}

export function readNotifications(runtimeDir: string): LucernaNotification[] {
  const path = notificationsPath(runtimeDir);
  if (!existsSync(path)) return [];
  const out: LucernaNotification[] = [];
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as LucernaNotification;
        if (obj && typeof obj.kind === "string" && typeof obj.message === "string") {
          out.push(obj);
        }
      } catch {
        /* skip bad lines */
      }
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * When the file has more than NOTIFICATIONS_ROTATE_AT lines, keep the newest
 * NOTIFICATIONS_KEEP_LINES (atomic tmp+rename).
 */
export function rotateNotificationsIfNeeded(runtimeDir: string): void {
  const path = notificationsPath(runtimeDir);
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= NOTIFICATIONS_ROTATE_AT) return;
  const kept = lines.slice(-NOTIFICATIONS_KEEP_LINES);
  const tmp = path + ".tmp";
  writeFileSync(tmp, kept.join("\n") + "\n", "utf-8");
  renameSync(tmp, path);
}
