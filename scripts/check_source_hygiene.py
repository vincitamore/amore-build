#!/usr/bin/env python3
"""Amore Build: keep process language out of shipped source.

Scans fork-owned instrument and template trees for tokens and comment
markers that belong in private process notes, not in public source. The
gate is stdlib-only and intentionally mechanical: word-boundary matches,
explicit allowlists for reviewed product exceptions, and severity classes
that separate hard failures from report-only soft signals.

Modes:
    --check [--root <dir>]   exit 1 if any error-severity finding exists
    --scan  [--root <dir>]   print all findings; always exit 0
    --self-test              run seeded corpora against every pattern class

    python scripts/check_source_hygiene.py --check
    python scripts/check_source_hygiene.py --scan
    python scripts/check_source_hygiene.py --self-test

Windows: `py scripts/...`; unix: `python3`.
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Public product surface scanned by this gate.
SCAN_ROOTS = ("instruments", "templates")

SCAN_EXCLUDES = {
    ".git", "node_modules", "dist", "target", ".sweep-scratch",
    "__pycache__", ".turbo", "coverage",
    # Run-captured dash frames: screenshots of real data, not shipped source.
    "e2e-frames", "e2e-pty-frames",
}
SCAN_SKIP_NAMES = {
    "Cargo.lock", "package-lock.json", "bun.lock", "bun.lockb",
}
BINARY_EXT = {
    ".png", ".ttf", ".tmtheme", ".woff", ".woff2", ".ico", ".otf",
    ".exe", ".dll", ".so", ".dylib", ".wasm", ".zip", ".gz", ".7z",
    ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".pdf", ".bin",
}
# Text-ish extensions we always attempt. Extension-less files under the
# roots are skipped (usually binaries or lock-ish artifacts).
SOURCE_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".rs", ".go", ".java", ".kt",
    ".md", ".mdx", ".txt", ".rst",
    ".json", ".jsonc", ".toml", ".yml", ".yaml",
    ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
    ".html", ".htm", ".css", ".scss",
    ".sql", ".graphql", ".proto",
}
CODE_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".rs", ".go", ".java", ".kt",
    ".sh", ".bash", ".zsh", ".ps1",
}

# ---------------------------------------------------------------------------
# Pattern classes
# ---------------------------------------------------------------------------

# Severity: "error" fails --check; "warn" is printed but does not fail.
CLASSES = {
    "private_tree": "error",
    "donor_name": "error",
    "org_path": "error",
    "wikilink": "error",
    "campaign": "error",
    "ai_authorship": "error",
    "dated_provenance": "warn",
    "soft_todo": "warn",
}

# Private-tree tokens. Word-boundary so "opusculum" does not trip "opus".
PRIVATE_TREE_RE = re.compile(r"\b(?:opus|materia)\b", re.IGNORECASE)

# Porting-donor name: banned in content and file names under scan roots.
# Content uses word boundaries. File-name segments split on non-alphanumeric
# so mercury_helper / mercury-helper count (underscore is a word char for \b).
DONOR_RE = re.compile(r"\bmercury\b", re.IGNORECASE)


def _name_has_donor(name: str) -> bool:
    """True when a path segment or basename embeds the donor name as a token."""
    for part in re.split(r"[^A-Za-z0-9]+", name):
        if part.lower() == "mercury":
            return True
    return False

# House-layout path fragments that are private process paths when they
# appear outside the product surfaces that define them.
ORG_PATH_PATTERNS = [
    (re.compile(r"inbox/"), "inbox/"),
    (re.compile(r"tasks/"), "tasks/"),
    (re.compile(r"forge/handles"), "forge/handles"),
    (re.compile(r"forge/output"), "forge/output"),
    (re.compile(r"knowledge/architecture"), "knowledge/architecture"),
]

# Wikilink syntax in code files (markdown may use them as product docs).
WIKILINK_RE = re.compile(r"\[\[[^\]]+\]\]")

# Campaign / pipeline vocabulary that must not land in shipped source.
CAMPAIGN_PATTERNS = [
    (re.compile(r"\bWave\s+1\b"), "Wave 1"),
    (re.compile(r"\bwave-1\b", re.IGNORECASE), "wave-1"),
    (re.compile(r"\bper\s+R\d+\b"), "per R<n> ruling ref"),
    (re.compile(r"\bthe synthesis\b", re.IGNORECASE), "the synthesis"),
    (re.compile(r"\bauriga\b", re.IGNORECASE), "auriga"),
    (re.compile(r"\boeconomia\b", re.IGNORECASE), "oeconomia"),
    # Work-unit / round labels used inside private campaign briefs (shipped
    # source is a standalone artifact; these are process ids, not content).
    # Case-sensitive: an ordinary lowercase "u-2"/"wu-04" phrase stays clean.
    (re.compile(r"\bWU-\d+\b"), "work-unit label (WU-<n>)"),
    (re.compile(r"\bU-\d+\b"), "work-unit label (U-<n>)"),
    (re.compile(r"\bR-(?:lens|count|UI-\d)\b"), "review-round label (R-<name>)"),
]

# Dated provenance comments (heuristic). Report-only: dates next to
# fixed/added/ported/changed language are often legitimate changelogs.
DATED_PROV_RE = re.compile(
    r"(?:fixed|added|ported|changed).{0,20}20\d\d-\d\d",
    re.IGNORECASE,
)

# Soft temporary markers without a tracker reference nearby.
# TODO is case-sensitive (avoids checkbox labels like "`[ ]` todo").
# "for now" / "temporary" are case-insensitive prose hedges.
SOFT_TODO_TODO_RE = re.compile(r"\bTODO\b")
SOFT_TODO_HEDGE_RE = re.compile(r"\b(?:for now|temporary)\b", re.IGNORECASE)
# Adjacent tracker reference: issue URL, #123, JIRA-ish KEY-123, GH-123.
TRACKER_RE = re.compile(
    r"(?:https?://\S+|#[0-9]+|\b[A-Z][A-Z0-9]+-\d+\b|\bGH-\d+\b|\bissue\s*#?\d+)",
    re.IGNORECASE,
)

# AI-authorship markers in comment / prose contexts.
AI_MARKERS = [
    (re.compile(r"Co-Authored-By", re.IGNORECASE), "Co-Authored-By"),
    (re.compile(r"Generated with", re.IGNORECASE), "Generated with"),
    (re.compile(r"\bClaude\b"), "Claude"),
    (re.compile(r"\bFable\b"), "Fable"),
    # Bare "Grok" / "grok" as authorship — allow-list covers product names.
    (re.compile(r"\bGrok\b", re.IGNORECASE), "Grok"),
]

# Legitimate Grok/GROK mentions that are product/env surface, not authorship.
GROK_ALLOW_RE = re.compile(
    r"(?:"
    r"Grok Build|GROK_|\$GROK|\.grok|grok-compat|grok_compat|"
    r"xai-grok|xai_grok|grok-build|grok_build|"
    r"grok-4|grok-native|grok\.com|groknight|grokday|"
    r"native grok|grok freight|grok rail|grok subagent|grok headless|"
    r"grok doctor|grok-doctor"
    r")",
    re.IGNORECASE,
)

# "Claude" as API/compat vocabulary is product surface, not authorship.
CLAUDE_ALLOW_RE = re.compile(
    r"(?:"
    r"Claude-compatible|Claude compatible|Claude API|"
    r"Anthropic|claude-3|claude-4|claude-opus|claude-sonnet"
    r")",
    re.IGNORECASE,
)

# Path prefixes where house-layout path tokens and wikilinks are product
# surface (house-aware instruments and the house template define them).
PRODUCT_LAYOUT_PREFIXES = (
    "instruments/iris/",
    "instruments/lucerna/",
    "templates/house/",
)
PRODUCT_LAYOUT_CLASSES = frozenset({"org_path", "wikilink"})

# The house template ships named skills/recipes (auriga, oeconomia, forge
# synthesis vocabulary). Campaign-token class is suppressed there so the
# scanner does not fail the product surface that defines those names.
# instruments/ still fully enforces campaign tokens.
PRODUCT_CAMPAIGN_PREFIXES = (
    "templates/house/",
)

# Explicitly-reviewed exceptions: (posix-rel-path, content-signature) pairs.
# Signatures are line-content fragments (case-insensitive). Add only with a
# reason; this is the human-sign-off surface for pre-existing or product-
# legitimate hits that the patterns would otherwise flag.
REVIEWED_EXCEPTIONS: list[tuple[str, str, str]] = [
    # --- reviewed product-surface exceptions (do not add new ones casually) ---
    # house AGENTS recipe table documents public recipe ids shipped with the
    # forge harness (names are product surface, not campaign process notes).
    (
        "templates/house/AGENTS.md",
        "`auriga`",
        "product recipe id in house AGENTS recipe table",
    ),
    (
        "templates/house/AGENTS.md",
        "`oeconomia`",
        "product recipe id in house AGENTS recipe table",
    ),
    (
        "templates/house/forge/README.md",
        "auriga",
        "product recipe id referenced from forge README",
    ),
]


@dataclass
class Finding:
    path: str
    line: int
    severity: str
    cls: str
    message: str
    excerpt: str = ""


@dataclass
class ScanResult:
    findings: list[Finding] = field(default_factory=list)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def warns(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warn"]


def _under_prefix(rel: str, prefixes: tuple[str, ...]) -> bool:
    posix = rel.replace("\\", "/")
    return any(posix.startswith(p) or posix == p.rstrip("/") for p in prefixes)


def _is_product_layout(rel: str) -> bool:
    return _under_prefix(rel, PRODUCT_LAYOUT_PREFIXES)


def _is_product_campaign(rel: str) -> bool:
    return _under_prefix(rel, PRODUCT_CAMPAIGN_PREFIXES)


def _reviewed(rel: str, line: str) -> bool:
    low = line.lower()
    posix = rel.replace("\\", "/")
    return any(
        posix == path and sig.lower() in low
        for path, sig, _reason in REVIEWED_EXCEPTIONS
    )


def is_skipped(path: Path, root: Path) -> bool:
    try:
        rel = path.relative_to(root)
    except ValueError:
        return True
    parts = rel.parts
    if any(p in SCAN_EXCLUDES for p in parts):
        return True
    if path.name in SCAN_SKIP_NAMES:
        return True
    if path.suffix.lower() in BINARY_EXT:
        return True
    if path.suffix.lower() not in SOURCE_EXT:
        return True
    return False


def iter_source_files(root: Path):
    for top in SCAN_ROOTS:
        base = root / top
        if not base.is_dir():
            continue
        for p in sorted(base.rglob("*")):
            if p.is_file() and not is_skipped(p, root):
                yield p


def read_text(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return p.read_text(encoding="utf-8", errors="replace")


def _line_is_comment(line: str, ext: str) -> bool:
    """Best-effort: is this source line a comment (or markdown prose)?"""
    s = line.strip()
    if not s:
        return False
    if ext in {".md", ".mdx", ".txt", ".rst"}:
        return True  # treat prose as comment-context for authorship/provenance
    if ext == ".py":
        return s.startswith("#")
    if ext in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go",
               ".java", ".kt", ".css", ".scss"}:
        return (
            s.startswith("//")
            or s.startswith("/*")
            or s.startswith("*")
            or s.startswith("*/")
        )
    if ext in {".sh", ".bash", ".zsh", ".ps1"}:
        return s.startswith("#")
    if ext in {".toml", ".yml", ".yaml"}:
        return s.startswith("#")
    return False


def _comment_spans_python(text: str) -> set[int]:
    """Line numbers (1-based) that are # comments or inside triple-quoted
    strings that open a line (docstring heuristic)."""
    lines = text.splitlines()
    out: set[int] = set()
    in_trip = False
    trip_token = ""
    for i, line in enumerate(lines, 1):
        s = line.strip()
        if in_trip:
            out.add(i)
            if trip_token in line:
                # close if the closer appears
                # crude: count occurrences
                if line.count(trip_token) >= 1 and not (
                    s.startswith(trip_token) and line.count(trip_token) == 1
                    and len(s) == 3
                ):
                    # may close on same line content; mark and maybe exit
                    pass
                if trip_token in s[3:] or (
                    s != trip_token and s.endswith(trip_token)
                ) or s == trip_token:
                    in_trip = False
            continue
        if s.startswith("#"):
            out.add(i)
            continue
        for tok in ('"""', "'''"):
            if tok in s and s.startswith(tok):
                out.add(i)
                if s.count(tok) == 1 or not s.endswith(tok) or len(s) == 3:
                    # opens and may not close on same line
                    if s.count(tok) < 2:
                        in_trip = True
                        trip_token = tok
                break
    return out


def _comment_lines_for_file(text: str, ext: str) -> set[int]:
    if ext == ".py":
        return _comment_spans_python(text)
    lines = text.splitlines()
    out: set[int] = set()
    in_block = False
    for i, line in enumerate(lines, 1):
        if _line_is_comment(line, ext):
            out.add(i)
        s = line.strip()
        if ext in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs",
                   ".go", ".java", ".kt", ".css", ".scss"}:
            if "/*" in line:
                in_block = True
            if in_block:
                out.add(i)
            if "*/" in line:
                in_block = False
        # full-line hash comments already covered by _line_is_comment
        _ = s
    return out


def scan_file(path: Path, root: Path) -> list[Finding]:
    rel = path.relative_to(root).as_posix()
    ext = path.suffix.lower()
    text = read_text(path)
    lines = text.splitlines()
    findings: list[Finding] = []
    comment_lines = _comment_lines_for_file(text, ext)
    product = _is_product_layout(rel)

    def add(lineno: int, cls: str, message: str, excerpt: str) -> None:
        if product and cls in PRODUCT_LAYOUT_CLASSES:
            return
        if cls == "campaign" and _is_product_campaign(rel):
            return
        if _reviewed(rel, excerpt):
            return
        findings.append(Finding(
            path=rel,
            line=lineno,
            severity=CLASSES[cls],
            cls=cls,
            message=message,
            excerpt=excerpt.strip()[:160],
        ))

    # Filename check: donor name in path segments / basename.
    for part in Path(rel).parts:
        if _name_has_donor(part) or _name_has_donor(Path(part).stem):
            add(0, "donor_name",
                f"donor name in file path segment '{part}'", part)

    for i, line in enumerate(lines, 1):
        # private tree
        m = PRIVATE_TREE_RE.search(line)
        if m:
            add(i, "private_tree",
                f"private-tree token '{m.group(0)}'", line)

        # donor in content
        m = DONOR_RE.search(line)
        if m:
            add(i, "donor_name",
                f"donor name '{m.group(0)}' in content", line)

        # org paths
        for cre, label in ORG_PATH_PATTERNS:
            if cre.search(line):
                add(i, "org_path", f"org-path token '{label}'", line)

        # wikilinks in code files only
        if ext in CODE_EXT and WIKILINK_RE.search(line):
            add(i, "wikilink", "wikilink syntax in code file", line)

        # campaign vocabulary
        for cre, label in CAMPAIGN_PATTERNS:
            if cre.search(line):
                add(i, "campaign", f"campaign token '{label}'", line)

        # dated provenance: comment context only
        if i in comment_lines and DATED_PROV_RE.search(line):
            add(i, "dated_provenance",
                "dated provenance comment", line)

        # soft TODO / for now / temporary without tracker ref on same line.
        # Comment/prose context only: a literal "TODO" string constant in a
        # token list is a value, not a todo marker.
        soft_hit = i in comment_lines and (
            SOFT_TODO_TODO_RE.search(line) or SOFT_TODO_HEDGE_RE.search(line)
        )
        if soft_hit and not TRACKER_RE.search(line):
            # also accept tracker on previous/next line (common style)
            prev = lines[i - 2] if i >= 2 else ""
            nxt = lines[i] if i < len(lines) else ""
            if not (TRACKER_RE.search(prev) or TRACKER_RE.search(nxt)):
                add(i, "soft_todo",
                    "TODO/for now/temporary without tracker reference", line)

        # AI authorship: comment / prose context only
        if i in comment_lines:
            for cre, label in AI_MARKERS:
                if not cre.search(line):
                    continue
                if label.lower() == "grok" and GROK_ALLOW_RE.search(line):
                    continue
                if label == "Claude" and CLAUDE_ALLOW_RE.search(line):
                    continue
                add(i, "ai_authorship",
                    f"AI-authorship marker '{label}'", line)

    return findings


def scan_tree(root: Path) -> ScanResult:
    result = ScanResult()
    for p in iter_source_files(root):
        result.findings.extend(scan_file(p, root))
    # stable order
    result.findings.sort(key=lambda f: (f.path, f.line, f.cls, f.message))
    return result


def print_findings(result: ScanResult, *, heading: str | None = None) -> None:
    if heading:
        print(heading)
    errors = result.errors
    warns = result.warns
    print(f"source-hygiene: {len(errors)} error(s), {len(warns)} warning(s), "
          f"{len(result.findings)} total")
    print("=" * 70)
    if not result.findings:
        print("clean: no process-language findings in instruments/ + templates/")
        return
    for f in result.findings:
        loc = f"{f.path}:{f.line}" if f.line else f.path
        print(f"  [{f.severity}/{f.cls}] {loc}: {f.message}")
        if f.excerpt:
            print(f"      | {f.excerpt}")


# ---------------------------------------------------------------------------
# Self-test: seeded in-memory corpora (written to a temp tree)
# ---------------------------------------------------------------------------

def _write(base: Path, rel: str, content: str) -> None:
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def run_self_test() -> int:
    failures: list[str] = []

    with tempfile.TemporaryDirectory(prefix="hygiene-selftest-") as td:
        root = Path(td)

        # ---- dirty corpus: one violation per class (+ filename donor) ----
        dirty = [
            # private_tree
            ("instruments/demo/private.ts",
             "// contact the opus tree for context\nexport const x = 1;\n",
             "private_tree"),
            ("instruments/demo/materia.ts",
             "const note = 'see materia for schema';\n",
             "private_tree"),
            # donor content
            ("instruments/demo/donor.ts",
             "// ported from mercury module foo\nexport {}\n",
             "donor_name"),
            # donor filename
            ("instruments/demo/mercury_helper.ts",
             "export const ok = true;\n",
             "donor_name"),
            # org_path (outside product layout prefixes)
            ("instruments/demo/paths.ts",
             "const p = 'inbox/captures/x.md';\n",
             "org_path"),
            ("instruments/demo/tasks_path.ts",
             "const p = 'tasks/backlog/a.md';\n",
             "org_path"),
            ("instruments/demo/forge_h.ts",
             "const p = 'forge/handles/pipe/x.md';\n",
             "org_path"),
            ("instruments/demo/forge_o.ts",
             "const p = 'forge/output/pipe/x.md';\n",
             "org_path"),
            ("instruments/demo/know.ts",
             "const p = 'knowledge/architecture/n.md';\n",
             "org_path"),
            # wikilink in code
            ("instruments/demo/wiki.ts",
             "const s = 'see [[context/current-state]]';\n",
             "wikilink"),
            # campaign
            ("instruments/demo/wave.ts",
             "// Wave 1 deliverable marker\nexport {}\n",
             "campaign"),
            ("instruments/demo/wave2.ts",
             "// wave-1 leftover\nexport {}\n",
             "campaign"),
            ("instruments/demo/ruling.ts",
             "// per R12 this stays\nexport {}\n",
             "campaign"),
            ("instruments/demo/synth.ts",
             "// from the synthesis doc\nexport {}\n",
             "campaign"),
            ("instruments/demo/recipe_a.ts",
             "// uses auriga budget rules\nexport {}\n",
             "campaign"),
            ("instruments/demo/recipe_o.ts",
             "// oeconomia pricing table\nexport {}\n",
             "campaign"),
            # work-unit / round labels (the class that used to ride through)
            ("instruments/demo/wu.ts",
             "// WU-04 progress marker in the walker\nexport {}\n",
             "campaign"),
            ("instruments/demo/unit.ts",
             "// U-7 bar: narrow the slice and re-run\nexport {}\n",
             "campaign"),
            ("instruments/demo/rlens.ts",
             "// R-lens turnaround copy\nexport {}\n",
             "campaign"),
            # ai_authorship in comments
            ("instruments/demo/ai1.ts",
             "// Co-Authored-By: someone\nexport {}\n",
             "ai_authorship"),
            ("instruments/demo/ai2.ts",
             "// Generated with Assistant\nexport {}\n",
             "ai_authorship"),
            ("instruments/demo/ai3.ts",
             "// Claude wrote this helper\nexport {}\n",
             "ai_authorship"),
            ("instruments/demo/ai4.ts",
             "// Fable session output\nexport {}\n",
             "ai_authorship"),
            ("instruments/demo/ai5.ts",
             "// Grok authored this block\nexport {}\n",
             "ai_authorship"),
            # dated_provenance (warn)
            ("instruments/demo/dated.ts",
             "// fixed 2026-08-05 after merge\nexport {}\n",
             "dated_provenance"),
            # soft_todo (warn)
            ("instruments/demo/todo.ts",
             "// TODO: clean this up later\nexport {}\n",
             "soft_todo"),
            ("instruments/demo/fornow.ts",
             "// for now keep the stub\nexport {}\n",
             "soft_todo"),
            ("instruments/demo/temp.ts",
             "// temporary workaround\nexport {}\n",
             "soft_todo"),
        ]

        expected_classes: set[str] = set()
        for rel, content, cls in dirty:
            _write(root, rel, content)
            expected_classes.add(cls)

        # Clean corpus: legitimate product language that must NOT flag.
        clean_files = [
            ("instruments/demo/clean.ts",
             "// uses GROK_HOME and Grok Build env surface\n"
             "export const GROK_TOKEN = process.env.GROK_HOME;\n"
             "const label = 'Grok Build fork';\n"
             "// TODO: tracked in #42\n"
             "export const n = 1;\n"),
            ("instruments/demo/clean_py.py",
             '"""Module for house layout helpers."""\n'
             "# no process language here\n"
             "VALUE = 1\n"),
            # product layout may mention house paths freely
            ("instruments/iris/packages/regula/src/paths.ts",
             "export const INBOX = 'inbox/captures';\n"
             "export const HANDLES = 'forge/handles';\n"
             "export const OUT = 'forge/output';\n"
             "export const ARCH = 'knowledge/architecture';\n"
             "export const TASKS = 'tasks/backlog';\n"
             "const w = '[[AGENTS]]';\n"),
            ("templates/house/README.md",
             "# House\n\nPaths: `inbox/`, `tasks/`, `forge/handles`.\n"
             "See [[context/current-state]].\n"),
            # house template owns skill/recipe vocabulary
            ("templates/house/.amore/skills/auriga/SKILL.md",
             "---\nname: auriga\n---\n# Auriga\nUses oeconomia floors.\n"),
            # word-boundary: opusculum must not trip opus
            ("instruments/demo/boundary.ts",
             "const title = 'opusculum minor';\n"
             "const m = 'immaterial';\n"),
            # Claude-compatible is API vocabulary, not authorship
            ("instruments/demo/hooks.py",
             "# emit Claude-compatible hook payload\nVALUE = 1\n"),
            # lowercase "u-2"/"wu-04" are ordinary hyphenated text, not labels
            ("instruments/demo/case.ts",
             "// the u-2 connector and the wu-04 wire both fit\nexport const x = 1;\n"),
            # a literal "TODO" string constant is a value, not a todo marker
            ("instruments/demo/strlst.ts",
             "const ACRONYMS = ['HTTP', 'TODO', 'API'];\nexport {};\n"),
        ]
        for rel, content in clean_files:
            _write(root, rel, content)

        result = scan_tree(root)
        found_classes = {f.cls for f in result.findings}

        for cls in expected_classes:
            if cls not in found_classes:
                failures.append(f"expected class '{cls}' not caught")

        # Every dirty file should produce at least one finding (except we
        # map by class; also assert donor filename was caught).
        donor_fn = [
            f for f in result.findings
            if f.cls == "donor_name" and "mercury_helper" in f.path
        ]
        if not donor_fn:
            failures.append("donor filename mercury_helper.ts not caught")

        # Clean files must not produce error findings.
        clean_paths = {rel for rel, _ in clean_files}
        clean_errors = [
            f for f in result.errors if f.path in clean_paths
        ]
        if clean_errors:
            for f in clean_errors:
                failures.append(
                    f"clean corpus false positive: [{f.cls}] {f.path}:{f.line} "
                    f"{f.message}"
                )

        # Soft_todo with tracker must not warn.
        tracked = [
            f for f in result.findings
            if f.path == "instruments/demo/clean.ts" and f.cls == "soft_todo"
        ]
        if tracked:
            failures.append("TODO with #42 tracker should not warn")

        # Grok Build / GROK_ must not flag as ai_authorship on clean.ts
        ai_clean = [
            f for f in result.findings
            if f.path == "instruments/demo/clean.ts" and f.cls == "ai_authorship"
        ]
        if ai_clean:
            failures.append(
                f"Grok Build / GROK_ false positive: {ai_clean[0].message}"
            )

        # Product layout org_path/wikilink must not error.
        layout_hits = [
            f for f in result.findings
            if f.path.startswith("instruments/iris/")
            and f.cls in PRODUCT_LAYOUT_CLASSES
        ]
        if layout_hits:
            failures.append(
                f"product-layout false positive: {layout_hits[0].path} "
                f"{layout_hits[0].cls}"
            )

        # --check semantics: errors fail
        if not result.errors:
            failures.append(
                "dirty corpus produced zero errors (patterns not firing)"
            )

        # Pure clean tree: only clean files, no dirty
        with tempfile.TemporaryDirectory(prefix="hygiene-clean-") as td2:
            clean_root = Path(td2)
            for rel, content in clean_files:
                _write(clean_root, rel, content)
            clean_result = scan_tree(clean_root)
            if clean_result.errors:
                for f in clean_result.errors:
                    failures.append(
                        f"pure clean tree error: [{f.cls}] {f.path}:{f.line} "
                        f"{f.message}"
                    )
            # warns on clean are also unexpected for our seeded clean set
            if clean_result.warns:
                for f in clean_result.warns:
                    failures.append(
                        f"pure clean tree warn: [{f.cls}] {f.path}:{f.line} "
                        f"{f.message}"
                    )

    if failures:
        print("SELF-TEST FAILED:")
        for msg in failures:
            print(f"  ! {msg}")
        return 1

    print("self-test passed:")
    print(f"  caught classes: {', '.join(sorted(expected_classes))}")
    print("  clean corpus: no findings")
    print("  product-layout allowlist: ok")
    print("  word-boundary (opusculum/immaterial): ok")
    print("  Grok Build / GROK_* allow: ok")
    print("  tracked TODO allow: ok")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="exit 1 on error-severity findings")
    ap.add_argument("--scan", action="store_true",
                    help="print all findings; always exit 0")
    ap.add_argument("--self-test", action="store_true",
                    help="run seeded pattern-class assertions")
    ap.add_argument("--root", type=Path, default=None,
                    help="repo root to scan (default: parent of scripts/)")
    args = ap.parse_args(argv)

    modes = sum(bool(x) for x in (args.check, args.scan, args.self_test))
    if modes > 1:
        ap.error("pick one of --check / --scan / --self-test")
    if modes == 0:
        args.scan = True

    if args.self_test:
        return run_self_test()

    root = (args.root or REPO).resolve()
    result = scan_tree(root)
    mode = "check" if args.check else "scan"
    print_findings(result, heading=f"source-hygiene {mode} ({root})")

    if args.check:
        return 1 if result.errors else 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
