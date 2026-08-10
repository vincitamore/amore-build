import { describe, expect, test } from "bun:test";
import {
  buildOriginsReport,
  classifyCwd,
  decodeCwdPath,
  type CwdOrigin,
} from "./cwd-class";

/** Real-tree samples from recon (encoded dir names + decoded project_path forms). */
const SAMPLES: { input: string; want: CwdOrigin; note: string }[] = [
  // harness — encoded
  {
    input: "%2Ftmp%2Fchat-mode-build-refuse-274164",
    want: "harness",
    note: "encoded chat-mode refuse",
  },
  {
    input: "%2Ftmp%2Fchat-mode-conv-ok-453228",
    want: "harness",
    note: "encoded chat-mode conv-ok",
  },
  {
    input: "C%3A%5CUsers%5CAlexMoyer%5CAppData%5CLocal%5CTemp%5Camore-sf1-resume-smoke",
    want: "harness",
    note: "encoded sf1 resume smoke",
  },
  {
    input: "C%3A%5CUsers%5CAlexMoyer%5CAppData%5CLocal%5CTemp%5Csf1-smoke",
    want: "harness",
    note: "encoded sf1-smoke under Temp",
  },
  {
    input: "C%3A%5CUsers%5CAlexMoyer%5Csf1-smoke",
    want: "harness",
    note: "encoded sf1-smoke under home",
  },
  // harness — decoded
  {
    input: "/tmp/chat-mode-build-refuse-409888",
    want: "harness",
    note: "decoded chat-mode refuse",
  },
  {
    input: "C:\\Users\\AlexMoyer\\AppData\\Local\\Temp\\amore-sf1-resume-smoke",
    want: "harness",
    note: "decoded resume-smoke",
  },
  {
    input: "C:\\Users\\AlexMoyer\\sf1-smoke",
    want: "harness",
    note: "decoded sf1-smoke",
  },
  // experiment — encoded
  {
    input:
      "C%3A%5CUsers%5CAlexMoyer%5CAppData%5CLocal%5CTemp%5Carcus-identity-study%5CA-sen-01-r1-Fz7FoM",
    want: "experiment",
    note: "encoded identity-study arm",
  },
  {
    input:
      "C%3A%5CUsers%5CAlexMoyer%5CAppData%5CLocal%5CTemp%5Carcus-model-comparison%5Cdeployed-0eujTL",
    want: "experiment",
    note: "encoded model-comparison arm",
  },
  {
    input:
      "C%3A%5CUsers%5CAlexMoyer%5CDocuments%5Copus%5Cprojects%5Cncu-grants%5Cresearch%5Cglm%5Cidentity-study%5Carms%5Carcus",
    want: "experiment",
    note: "Documents-hosted identity-study arm still experiment",
  },
  // experiment — decoded
  {
    input:
      "C:\\Users\\AlexMoyer\\AppData\\Local\\Temp\\arcus-identity-study\\A-sen-02-r1-FaTNwz",
    want: "experiment",
    note: "decoded identity-study",
  },
  // operator — encoded
  {
    input: "C%3A%5CUsers%5CAlexMoyer%5CDocuments%5Camore",
    want: "operator",
    note: "encoded Documents/amore",
  },
  {
    input: "C%3A%5CUsers%5CAlexMoyer%5CDocuments%5Camore-build",
    want: "operator",
    note: "encoded Documents/amore-build",
  },
  {
    input: "C%3A%5CUsers%5CAlexMoyer%5CDocuments%5Carcus",
    want: "operator",
    note: "encoded Documents/arcus",
  },
  // operator — decoded
  {
    input: "C:\\Users\\AlexMoyer\\Documents\\amore-build\\instruments\\iris\\packages\\tui",
    want: "operator",
    note: "decoded nested workspace",
  },
  {
    input: "/home/user/projects/widget",
    want: "operator",
    note: "unix non-temp workspace",
  },
  // unknown
  {
    input: "%2Ftmp",
    want: "unknown",
    note: "encoded bare /tmp",
  },
  {
    input: "/tmp",
    want: "unknown",
    note: "decoded bare /tmp",
  },
  {
    input: "",
    want: "unknown",
    note: "empty",
  },
];

describe("decodeCwdPath", () => {
  test("decodes URL-encoded Windows path", () => {
    expect(decodeCwdPath("C%3A%5CUsers%5CAlexMoyer%5CDocuments%5Camore")).toBe(
      "C:\\Users\\AlexMoyer\\Documents\\amore",
    );
  });

  test("passes through already-decoded paths", () => {
    expect(decodeCwdPath("/tmp/chat-mode-build-refuse-1")).toBe(
      "/tmp/chat-mode-build-refuse-1",
    );
  });
});

describe("classifyCwd", () => {
  for (const s of SAMPLES) {
    test(`${s.note}: ${s.input.slice(0, 60)}`, () => {
      expect(classifyCwd(s.input)).toBe(s.want);
    });
  }
});

describe("buildOriginsReport", () => {
  test("counts rows and distinct roots per class", () => {
    const rows = [
      { project_path: "C:\\Users\\AlexMoyer\\Documents\\amore", agent: "primary" },
      { project_path: "C:\\Users\\AlexMoyer\\Documents\\amore", agent: "subagent" },
      { project_path: "C:\\Users\\AlexMoyer\\Documents\\arcus", agent: "primary" },
      {
        project_path:
          "C:\\Users\\AlexMoyer\\AppData\\Local\\Temp\\arcus-identity-study\\A-sen-01",
        agent: "primary",
      },
      { project_path: "/tmp/chat-mode-build-refuse-1", agent: "primary" },
      { project_path: "/tmp/chat-mode-build-refuse-1", agent: "subagent" },
      { project_path: "/tmp", agent: "primary" },
    ];
    const report = buildOriginsReport(rows);
    expect(report.operator).toEqual({ rows: 3, roots: 2 });
    expect(report.experiment).toEqual({ rows: 1, roots: 1 });
    expect(report.harness).toEqual({ rows: 2, roots: 1 });
    expect(report.unknown).toEqual({ rows: 1, roots: 1 });
  });

  test("empty input → zero buckets", () => {
    expect(buildOriginsReport([])).toEqual({
      operator: { rows: 0, roots: 0 },
      experiment: { rows: 0, roots: 0 },
      harness: { rows: 0, roots: 0 },
      unknown: { rows: 0, roots: 0 },
    });
  });
});
