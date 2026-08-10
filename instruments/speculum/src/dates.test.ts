import { describe, expect, test } from "bun:test";
import { resolveTimeReference, resolveToDate } from "./dates";

/** Fixed reference: 2026-08-10T15:30:00.000Z (Monday). */
const NOW = new Date("2026-08-10T15:30:00.000Z");

describe("resolveTimeReference", () => {
  test("relative: N days ago", () => {
    const ref = resolveTimeReference("3 days ago", NOW);
    expect(ref).not.toBeNull();
    expect(ref!.label).toBe("3 days ago");
    expect(ref!.start.toISOString()).toBe("2026-08-07T00:00:00.000Z");
    expect(ref!.end!.toISOString()).toBe("2026-08-08T00:00:00.000Z");
  });

  test("relative: yesterday", () => {
    const ref = resolveTimeReference("yesterday", NOW);
    expect(ref).not.toBeNull();
    expect(ref!.start.toISOString()).toBe("2026-08-09T00:00:00.000Z");
    expect(ref!.end!.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  test("relative: today", () => {
    const ref = resolveTimeReference("today", NOW);
    expect(ref).not.toBeNull();
    expect(ref!.start.toISOString()).toBe("2026-08-10T00:00:00.000Z");
    expect(ref!.end!.toISOString()).toBe("2026-08-11T00:00:00.000Z");
  });

  test("relative: just now", () => {
    const ref = resolveTimeReference("just now", NOW);
    expect(ref).not.toBeNull();
    expect(ref!.start.getTime()).toBe(NOW.getTime());
    expect(ref!.end).toBeUndefined();
  });

  test("relative: last week", () => {
    // NOW is Monday 2026-08-10 → this week starts 2026-08-10; last week 2026-08-03..2026-08-10
    const ref = resolveTimeReference("last week", NOW);
    expect(ref).not.toBeNull();
    expect(ref!.start.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(ref!.end!.toISOString()).toBe("2026-08-10T00:00:00.000Z");
  });

  test("absolute: YYYY-MM-DD day window", () => {
    const ref = resolveTimeReference("2026-07-01", NOW);
    expect(ref).not.toBeNull();
    expect(ref!.start.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    expect(ref!.end!.toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });

  test("absolute: full ISO instant", () => {
    const ref = resolveTimeReference("2026-07-01T12:00:00.000Z", NOW);
    expect(ref).not.toBeNull();
    expect(ref!.start.toISOString()).toBe("2026-07-01T12:00:00.000Z");
  });

  test("unresolved returns null", () => {
    expect(resolveTimeReference("next aeon", NOW)).toBeNull();
    expect(resolveTimeReference("", NOW)).toBeNull();
  });

  test("resolveToDate convenience", () => {
    const d = resolveToDate("1 day ago", NOW);
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe("2026-08-09T00:00:00.000Z");
  });
});
