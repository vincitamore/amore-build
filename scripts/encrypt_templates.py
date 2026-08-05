#!/usr/bin/env python3
"""Regenerate src/prompt/prompt_encrypted.rs from the plaintext templates.

Upstream references this script from the staleness test
(`test_encrypted_templates_not_stale`) and from prompt_encrypted.rs's header,
but never shipped it in the public tree; this is the fork's implementation,
matched byte-for-byte to the decryptor in src/prompt/template.rs.

The XOR is obfuscation, not security (the seeds live in this repo): its only
job is keeping the prompt templates out of naive `strings` output. Run after
ANY edit to crates/codegen/xai-grok-agent/templates/*.md:

    python3 scripts/encrypt_templates.py

The staleness test fails the build when this was forgotten — which is exactly
how the 2026-08-04 identity sweep shipped binaries whose system prompt still
carried the previous product name.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = ROOT / "crates" / "codegen" / "xai-grok-agent"
OUT = AGENT / "src" / "prompt" / "prompt_encrypted.rs"

# (constant name, template file, seed) — seed order is PROMPT_SEEDS order and
# must match template.rs's decrypt call sites.
SEEDS = [0x5A, 0x7B, 0x3D]
TEMPLATES = [
    ("BASE_PROMPT_ENC", AGENT / "templates" / "prompt.md", SEEDS[0]),
    ("CODEX_PROMPT_ENC", AGENT / "templates" / "apply_patch_prompt.md", SEEDS[1]),
    ("SUBAGENT_PROMPT_ENC", AGENT / "templates" / "subagent_prompt.md", SEEDS[2]),
]


def xor_encrypt(data: bytes, seed: int) -> bytes:
    """Mirrors template.rs::decrypt (XOR is symmetric)."""
    return bytes(b ^ ((seed + i) & 0xFF) for i, b in enumerate(data))


def main() -> int:
    parts = [
        "// Auto-generated -- do not edit.\n"
        "// Regenerate: python3 scripts/encrypt_templates.py\n"
        "// XOR-encrypted prompt templates (key = position-dependent seed).\n"
    ]
    for name, path, seed in TEMPLATES:
        raw = path.read_bytes()
        if b"\r\n" in raw:
            print(
                f"error: {path} contains CRLF line endings; the encrypted bytes\n"
                "must match a normalized (LF) checkout. Fix the file's line\n"
                "endings and re-run.",
                file=sys.stderr,
            )
            return 1
        enc = xor_encrypt(raw, seed)
        # Round-trip guard: the decryptor must get the exact source back.
        assert xor_encrypt(enc, seed) == raw
        body = ", ".join(str(b) for b in enc)
        parts.append(
            f"\n#[rustfmt::skip]\npub(crate) const {name}: &[u8] = &[{body}];\n"
        )
        print(f"{name}: {len(raw)} bytes from {path.relative_to(ROOT)}")
    seeds = ", ".join(f"0x{s:02X}" for s in SEEDS)
    parts.append(f"\npub(crate) const PROMPT_SEEDS: [u8; 3] = [{seeds}];\n")
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("".join(parts))
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
