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

  test("budget-token-ceiling appends once per local date", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-notif-ceil-"));
    try {
      appendNotification(dir, {
        ts: "2026-06-09T10:00:00",
        level: "warn",
        kind: "budget-token-ceiling",
        message: "daily token ceiling reached (1/1)",
      });
      appendNotification(dir, {
        ts: "2026-06-09T11:00:00",
        level: "warn",
        kind: "budget-token-ceiling",
        message: "daily token ceiling reached (2/1)",
      });
      appendNotification(dir, {
        ts: "2026-06-10T09:00:00",
        level: "warn",
        kind: "budget-token-ceiling",
        message: "daily token ceiling reached (rolled)",
      });
      const entries = readNotifications(dir).filter(
        (e) => e.kind === "budget-token-ceiling",
      );
      expect(entries.length).toBe(2);
      expect(entries[0]!.ts.startsWith("2026-06-09")).toBe(true);
      expect(entries[1]!.ts.startsWith("2026-06-10")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("budget-daily-exhausted appends once per local date; other kinds do not dedup", () => {
    const dir = mkdtempSync(join(tmpdir(), "lucerna-notif-daily-"));
    try {
      appendNotification(dir, {
        ts: "2026-06-09T10:00:00",
        level: "info",
        kind: "budget-daily-exhausted",
        message: "daily budget exhausted (12/12)",
      });
      appendNotification(dir, {
        ts: "2026-06-09T11:00:00",
        level: "info",
        kind: "budget-daily-exhausted",
        message: "daily budget exhausted (12/12)",
      });
      appendNotification(dir, {
        ts: "2026-06-09T10:00:00",
        level: "error",
        kind: "governance-breach",
        message: "first",
      });
      appendNotification(dir, {
        ts: "2026-06-09T11:00:00",
        level: "error",
        kind: "governance-breach",
        message: "second",
      });
      const entries = readNotifications(dir);
      expect(entries.filter((e) => e.kind === "budget-daily-exhausted").length).toBe(1);
      expect(entries.filter((e) => e.kind === "governance-breach").length).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
