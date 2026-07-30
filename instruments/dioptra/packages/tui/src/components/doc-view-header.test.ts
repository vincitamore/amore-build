import { test, expect } from "bun:test";
import { docViewHeaderLabel, pathBaseName } from "./doc-view-header";

test("pathBaseName handles Windows and POSIX", () => {
  expect(pathBaseName("tasks/durable-live-dreams-enablement-for-dashboard-start.md")).toBe(
    "durable-live-dreams-enablement-for-dashboard-start.md",
  );
  expect(pathBaseName("C:/tmp/house/tasks/foo.md")).toBe("foo.md");
  expect(pathBaseName("/home/a/b/c.ts")).toBe("c.ts");
});

test("docViewHeaderLabel uses full basename+ext even when body H1 differs", () => {
  // extractTitle would return the H1 ("Dream: durable LIVE/…"); header must not.
  const path = "tasks/durable-live-dreams-enablement-for-dashboard-start.md";
  const label = docViewHeaderLabel(path);
  expect(label).toBe("durable-live-dreams-enablement-for-dashboard-start.md");
  expect(label).toContain(".md");
  expect(label).not.toMatch(/^Dream:/);
});

test("docViewHeaderLabel depth prefix and edit mode", () => {
  expect(docViewHeaderLabel("knowledge/a.md", { depth: 1 })).toBe("‹ a.md");
  expect(docViewHeaderLabel("src/config.ts", { editing: true })).toBe("Edit · config.ts");
  expect(docViewHeaderLabel("src/config.ts", { depth: 2, editing: true })).toBe(
    "‹ Edit · config.ts",
  );
});

test("non-md and plain basenames still show full file name", () => {
  expect(docViewHeaderLabel("instruments/example/scripts/start-daemon.ps1")).toBe(
    "start-daemon.ps1",
  );
  expect(docViewHeaderLabel("readme")).toBe("readme");
});
