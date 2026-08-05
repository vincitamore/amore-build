/**
 * Fail-closed scrubber for lens payloads.
 *
 * Before any model call, the constructed prompt is redacted: secret-shaped
 * strings, absolute home paths, and email addresses become typed placeholders.
 * The scrubber returns counts by class. Any scrubber error, any residual
 * secret-shaped content that cannot be confidently redacted, or a payload
 * over the size cap aborts the lens. Nothing partial is ever sent.
 */

import { homedir } from "node:os";
import { SENSITIVE_PATTERNS } from "./probes/sensitive-content";

/** Hard cap on prompt-file bytes. Larger selections are refused, never truncated. */
export const LENS_PAYLOAD_CAP_BYTES = 100 * 1024;

export type ScrubClass =
  | "secret"
  | "email"
  | "home-path"
  | "password-assignment";

export interface ScrubCounts {
  secret: number;
  email: number;
  "home-path": number;
  "password-assignment": number;
}

export interface ScrubReport {
  /** True when the payload is safe to send after redaction. */
  ok: boolean;
  /** Redacted text when ok; original text only when ok is false may be partial. */
  text: string;
  counts: ScrubCounts;
  /** Byte length of the returned text (UTF-8). */
  bytes: number;
  /** Human-readable refusal reason when ok is false. */
  refuseReason: string | null;
  /** Per-pattern residual findings that blocked send (fail-closed). */
  residual: Array<{ pattern: string; count: number }>;
}

export interface ScrubOptions {
  /** Max UTF-8 bytes allowed after redaction. Default LENS_PAYLOAD_CAP_BYTES. */
  maxBytes?: number;
  /** Override home directory for path redaction (tests). */
  homeDir?: string;
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** password= / passwd: / secret: assignment shapes (value redacted). */
const PASSWORD_ASSIGN_RE =
  /\b(password|passwd|pwd|secret|token)\s*[=:]\s*([^\s"'`,;]{6,})/gi;

function emptyCounts(): ScrubCounts {
  return { secret: 0, email: 0, "home-path": 0, "password-assignment": 0 };
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf-8");
}

function placeholder(kind: string): string {
  return `[REDACTED:${kind}]`;
}

/**
 * Build a home-path regex for the current platform's home directory and common
 * absolute-home forms. Paths are redacted as a unit.
 */
function homePathPatterns(home: string): RegExp[] {
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match home + path continuation (or just home when word-boundary-ish).
  const homeRe = new RegExp(
    `${escaped}(?:[\\\\/][^\\s"'\`\\]\\),;]*)?`,
    "gi",
  );
  // Also catch Unix-style /home/<user>/... and /Users/<user>/... when home is known.
  const unixUsers = /(?:^|[\s"'`=(])(\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/[^\s"'`\]),;]*)?)/g;
  // Windows C:\Users\<name>\...
  const winUsers =
    /(?:^|[\s"'`=(])([A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\[^\s"'`\]),;]*)?)/gi;
  return [homeRe, unixUsers, winUsers];
}

/**
 * Redact secret-shaped strings using the same pattern bank the sensitive-content
 * probe uses, plus password-assignment shapes. Each match becomes a typed
 * placeholder so the model still sees that a secret was present without the value.
 */
function redactSecrets(text: string, counts: ScrubCounts): string {
  let out = text;
  for (const p of SENSITIVE_PATTERNS) {
    const flags = p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`;
    const re = new RegExp(p.re.source, flags);
    let n = 0;
    out = out.replace(re, () => {
      n++;
      return placeholder(p.name);
    });
    counts.secret += n;
  }

  out = out.replace(PASSWORD_ASSIGN_RE, (_m, key: string) => {
    counts["password-assignment"]++;
    return `${String(key)}=${placeholder("password")}`;
  });

  return out;
}

function redactEmails(text: string, counts: ScrubCounts): string {
  return text.replace(EMAIL_RE, () => {
    counts.email++;
    return placeholder("email");
  });
}

function redactHomePaths(text: string, home: string, counts: ScrubCounts): string {
  let out = text;
  for (const re of homePathPatterns(home)) {
    out = out.replace(re, (match, group1?: string) => {
      // Some patterns capture a group; prefer the path segment.
      const raw = group1 ?? match;
      const leading = group1 && match !== group1 ? match.slice(0, match.indexOf(group1)) : "";
      counts["home-path"]++;
      return `${leading}${placeholder("home-path")}`;
    });
  }
  return out;
}

/**
 * After redaction, re-scan for residual secret-shaped content. Any hit means
 * the class could not be confidently redacted — fail closed.
 */
function residualSecrets(text: string): Array<{ pattern: string; count: number }> {
  const residual: Array<{ pattern: string; count: number }> = [];
  for (const p of SENSITIVE_PATTERNS) {
    const flags = p.re.flags.includes("g") ? p.re.flags : `${p.re.flags}g`;
    const matches = text.match(new RegExp(p.re.source, flags));
    if (matches && matches.length > 0) {
      residual.push({ pattern: p.name, count: matches.length });
    }
  }
  // Residual password assignments that still look live (not already placeholder).
  const pwdFlags = PASSWORD_ASSIGN_RE.flags.includes("g")
    ? PASSWORD_ASSIGN_RE.flags
    : `${PASSWORD_ASSIGN_RE.flags}g`;
  const pwdRe = new RegExp(PASSWORD_ASSIGN_RE.source, pwdFlags);
  let pwdCount = 0;
  let m: RegExpExecArray | null;
  while ((m = pwdRe.exec(text)) !== null) {
    const val = m[2] ?? "";
    if (!val.includes("REDACTED")) pwdCount++;
  }
  if (pwdCount > 0) {
    residual.push({ pattern: "password-assignment", count: pwdCount });
  }
  return residual;
}

/**
 * Scrub a full prompt payload. Fail-closed: on error or residual secrets or
 * oversize, returns ok:false and refuseReason. Callers must not send when !ok.
 */
export function scrubPayload(input: string, opts: ScrubOptions = {}): ScrubReport {
  const maxBytes = opts.maxBytes ?? LENS_PAYLOAD_CAP_BYTES;
  const home = opts.homeDir ?? homedir();
  const counts = emptyCounts();

  try {
    if (typeof input !== "string") {
      return {
        ok: false,
        text: "",
        counts,
        bytes: 0,
        refuseReason: "scrubber error: payload is not a string",
        residual: [],
      };
    }

    let text = input;
    text = redactSecrets(text, counts);
    text = redactEmails(text, counts);
    text = redactHomePaths(text, home, counts);

    const residual = residualSecrets(text);
    if (residual.length > 0) {
      const summary = residual.map((r) => `${r.pattern}×${r.count}`).join(", ");
      return {
        ok: false,
        text,
        counts,
        bytes: utf8Bytes(text),
        refuseReason: `scrubber fail-closed: residual unredactable content (${summary})`,
        residual,
      };
    }

    const bytes = utf8Bytes(text);
    if (bytes > maxBytes) {
      return {
        ok: false,
        text,
        counts,
        bytes,
        refuseReason:
          `payload ${bytes} bytes exceeds lens cap ${maxBytes} bytes; ` +
          `narrow the slice (--session, --since/--until, --last-n); never silently truncated`,
        residual: [],
      };
    }

    return {
      ok: true,
      text,
      counts,
      bytes,
      refuseReason: null,
      residual: [],
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      text: "",
      counts,
      bytes: 0,
      refuseReason: `scrubber error: ${msg}`,
      residual: [],
    };
  }
}

/** Format scrub counts for human CLI output. */
export function formatScrubReport(report: ScrubReport): string {
  const parts = (Object.entries(report.counts) as Array<[ScrubClass, number]>)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`);
  const countsLine = parts.length > 0 ? parts.join("  ") : "none";
  const lines = [
    `scrub: ${report.ok ? "ok" : "REFUSED"}`,
    `  counts: ${countsLine}`,
    `  bytes:  ${report.bytes}`,
  ];
  if (report.refuseReason) {
    lines.push(`  reason: ${report.refuseReason}`);
  }
  return lines.join("\n");
}
