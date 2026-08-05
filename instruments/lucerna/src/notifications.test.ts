import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendNotification,
  readNotifications,
  rotateNotificationsIfNeeded,
  notificationsPath,
  NOTIFICATIONS_ROTATE_AT,
  NOTIFICATIONS_KEEP_LINES,
} from "./notifications.ts";

describe("notifications queue", () => {
  test("append and read JSONL entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-notif-"));
    try {
      appendNotification(dir, {
        level: "info",
        kind: "dream-action",
        message: "executed survey-org",
        ref: "forge/dreams/x-survey-org.md",
      });
      appendNotification(dir, {
        level: "warn",
        kind: "budget-token-ceiling",
        message: "daily token ceiling reached",
      });
      const entries = readNotifications(dir);
      expect(entries.length).toBe(2);
      expect(entries[0]!.kind).toBe("dream-action");
      expect(entries[0]!.level).toBe("info");
      expect(entries[0]!.ref).toBe("forge/dreams/x-survey-org.md");
      expect(entries[0]!.ts).toBeTruthy();
      expect(entries[1]!.kind).toBe("budget-token-ceiling");

      const raw = readFileSync(notificationsPath(dir), "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines.length).toBe(2);
      for (const line of lines) {
        const obj = JSON.parse(line);
        expect(typeof obj.ts).toBe("string");
        expect(["info", "warn", "error"]).toContain(obj.level);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rotation keeps newest lines when exceeding cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-notif-rot-"));
    try {
      mkdirSync(dir, { recursive: true });
      const path = notificationsPath(dir);
      const lines: string[] = [];
      for (let i = 0; i < NOTIFICATIONS_ROTATE_AT + 10; i++) {
        lines.push(
          JSON.stringify({
            ts: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}`,
            level: "info",
            kind: "fill",
            message: `line-${i}`,
          }),
        );
      }
      writeFileSync(path, lines.join("\n") + "\n", "utf-8");
      rotateNotificationsIfNeeded(dir);
      const kept = readNotifications(dir);
      expect(kept.length).toBe(NOTIFICATIONS_KEEP_LINES);
      expect(kept[0]!.message).toBe(
        `line-${NOTIFICATIONS_ROTATE_AT + 10 - NOTIFICATIONS_KEEP_LINES}`,
      );
      expect(kept[kept.length - 1]!.message).toBe(
        `line-${NOTIFICATIONS_ROTATE_AT + 9}`,
      );
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("append triggers rotation past threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-notif-auto-"));
    try {
      mkdirSync(dir, { recursive: true });
      const path = notificationsPath(dir);
      const seed: string[] = [];
      for (let i = 0; i < NOTIFICATIONS_ROTATE_AT; i++) {
        seed.push(
          JSON.stringify({
            ts: "2026-01-01T00:00:00",
            level: "info",
            kind: "seed",
            message: `s-${i}`,
          }),
        );
      }
      writeFileSync(path, seed.join("\n") + "\n", "utf-8");
      appendNotification(dir, {
        level: "error",
        kind: "overflow",
        message: "the newest",
      });
      const kept = readNotifications(dir);
      expect(kept.length).toBe(NOTIFICATIONS_KEEP_LINES);
      expect(kept[kept.length - 1]!.kind).toBe("overflow");
      expect(kept[kept.length - 1]!.message).toBe("the newest");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
