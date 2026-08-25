#!/usr/bin/env python3
"""coord-presence — the house presence roster.

One JSON file per live session under a house-neutral directory
(~/.house/coord/presence/, overridable via HOUSE_COORD_DIR). Shared across
every harness on a seat. Liveness is proven by PID probe plus process-name
match, never TTL alone: a durable presence record lies after a crash, and a
TTL cannot serve both a long-idle session and a crashed one. Dead entries
are reaped on every roster read.

Identity is fields, not signatures: seat/harness/model plus optional
work-unit `<pipeline>/<concern>`.

Callers:
  - Amore Build session-init hook (this pack) writes presence and emits the
    Peers line. The harness also writes and removes the same schema natively
    at session start/end; the two share `{harness}-{pid}.json` so they do
    not double-count.
  - Other harness adapters import or invoke the same verbs (HOUSE_HARNESS
    in env). Headless units that never run hooks are wrapper-written with
    an explicit --pid.

CLI:
  coord_presence.py start  [--harness H] [--model M] [--session-id S]
                           [--work-unit W] [--pid N] [--cwd DIR]
  coord_presence.py stop   [--pid N] [--harness H]
  coord_presence.py roster [--json]
  coord_presence.py set    --work-unit W [--pid N]
  coord_presence.py delta  [--cwd DIR]

Every verb is fail-soft for hook use: errors print to stderr, exit 0.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PRESENCE_DIR = (
    Path(os.environ.get("HOUSE_COORD_DIR") or (Path.home() / ".house" / "coord"))
    / "presence"
)

# Transient wrappers between a hook process and the harness process that owns
# the session. The ancestor walk skips these; the first non-skip ancestor is
# recorded as the session's liveness anchor.
_SKIP = {
    "python", "python3", "python.exe", "py.exe",
    "cmd.exe", "conhost.exe", "openconsole.exe",
    "sh", "bash", "bash.exe", "zsh", "dash", "fish",
    "pwsh", "pwsh.exe", "powershell", "powershell.exe",
}


# --- process table ---------------------------------------------------------

def _win_process_table() -> dict[int, tuple[int, str]]:
    import ctypes
    from ctypes import wintypes

    TH32CS_SNAPPROCESS = 0x2
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    k32 = ctypes.windll.kernel32
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == INVALID_HANDLE_VALUE:
        return {}
    table: dict[int, tuple[int, str]] = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if k32.Process32FirstW(snap, ctypes.byref(entry)):
            while True:
                table[int(entry.th32ProcessID)] = (
                    int(entry.th32ParentProcessID),
                    entry.szExeFile,
                )
                if not k32.Process32NextW(snap, ctypes.byref(entry)):
                    break
    finally:
        k32.CloseHandle(snap)
    return table


def _posix_process_table() -> dict[int, tuple[int, str]]:
    table: dict[int, tuple[int, str]] = {}
    proc = Path("/proc")
    if proc.is_dir():  # Linux
        for p in proc.iterdir():
            if not p.name.isdigit():
                continue
            try:
                stat = (p / "stat").read_text()
                # pid (comm) state ppid ... — comm may contain spaces/parens
                lparen, rparen = stat.index("("), stat.rindex(")")
                comm = stat[lparen + 1 : rparen]
                ppid = int(stat[rparen + 2 :].split()[1])
                table[int(p.name)] = (ppid, comm)
            except (OSError, ValueError, IndexError):
                continue
        return table
    # macOS / other POSIX
    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,ppid=,comm="],
            capture_output=True, text=True, timeout=5,
        ).stdout
        for line in out.splitlines():
            parts = line.split(None, 2)
            if len(parts) == 3:
                table[int(parts[0])] = (int(parts[1]), os.path.basename(parts[2]))
    except Exception:
        pass
    return table


def process_table() -> dict[int, tuple[int, str]]:
    """{pid: (ppid, exe-name)} snapshot of all live processes."""
    return _win_process_table() if os.name == "nt" else _posix_process_table()


def find_session_pid(table: dict[int, tuple[int, str]] | None = None) -> tuple[int, str]:
    """Walk ancestors from this process; return (pid, name) of the first
    ancestor that is not a transient wrapper — the harness process that owns
    the session. Fallback: our direct parent."""
    table = table or process_table()
    pid = os.getpid()
    seen = set()
    while pid in table and pid not in seen:
        seen.add(pid)
        ppid, name = table[pid]
        base = os.path.basename(name).lower()
        if pid != os.getpid() and base not in _SKIP:
            return pid, name
        if ppid == pid or ppid == 0:
            break
        pid = ppid
    ppid = os.getppid()
    name = table.get(ppid, (0, "?"))[1] if table else "?"
    return ppid, name


def _alive(pid: int, pname: str | None, table: dict[int, tuple[int, str]]) -> bool:
    if pid not in table:
        return False
    if pname:  # PID-reuse guard: the name must still match what we recorded
        return os.path.basename(table[pid][1]).lower() == os.path.basename(pname).lower()
    return True


# --- entry helpers ---------------------------------------------------------

def _seat() -> str:
    return os.environ.get("HOUSE_SEAT") or platform.node().lower()


def _tree(cwd: str) -> str:
    try:
        top = subprocess.run(
            ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=3,
        ).stdout.strip()
        if top:
            return os.path.basename(top)
    except Exception:
        pass
    return os.path.basename(os.path.normpath(cwd)) or cwd


def _entry_path(harness: str, pid: int) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in harness)
    return PRESENCE_DIR / f"{safe}-{pid}.json"


# --- verbs -----------------------------------------------------------------

def start(harness: str = "amore", model: str | None = None,
          session_id: str | None = None, work_unit: str | None = None,
          pid: int | None = None, cwd: str | None = None) -> dict:
    table = process_table()
    if pid is None:
        pid, pname = find_session_pid(table)
    else:
        pname = table.get(pid, (0, "?"))[1]
    cwd = cwd or os.getcwd()
    entry = {
        "seat": _seat(),
        "harness": harness,
        "model": model or os.environ.get("HOUSE_MODEL"),
        "pid": pid,
        "pname": pname,
        "cwd": cwd,
        "tree": _tree(cwd),
        "started": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "work_unit": work_unit,
        "session_id": session_id,
    }
    PRESENCE_DIR.mkdir(parents=True, exist_ok=True)
    path = _entry_path(harness, pid)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(entry, indent=1), encoding="utf-8")
    os.replace(tmp, path)
    return entry


def stop(pid: int | None = None, harness: str | None = None) -> int:
    """Remove the entry for this session (or an explicit pid). Returns count."""
    if pid is None:
        pid, _ = find_session_pid()
    removed = 0
    if PRESENCE_DIR.is_dir():
        for f in PRESENCE_DIR.glob("*.json"):
            try:
                e = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if e.get("pid") == pid and (harness is None or e.get("harness") == harness):
                f.unlink(missing_ok=True)
                removed += 1
    return removed


def set_work_unit(work_unit: str, pid: int | None = None) -> int:
    if pid is None:
        pid, _ = find_session_pid()
    changed = 0
    if PRESENCE_DIR.is_dir():
        for f in PRESENCE_DIR.glob("*.json"):
            try:
                e = json.loads(f.read_text(encoding="utf-8"))
            except Exception:
                continue
            if e.get("pid") == pid:
                e["work_unit"] = work_unit
                f.write_text(json.dumps(e, indent=1), encoding="utf-8")
                changed += 1
    return changed


def roster(reap: bool = True) -> list[dict]:
    """All live entries, oldest first. Reaps dead entries by PID probe."""
    if not PRESENCE_DIR.is_dir():
        return []
    table = process_table()
    entries = []
    for f in sorted(PRESENCE_DIR.glob("*.json")):
        try:
            e = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            if reap:
                f.unlink(missing_ok=True)
            continue
        if _alive(int(e.get("pid", -1)), e.get("pname"), table):
            entries.append(e)
        elif reap:
            f.unlink(missing_ok=True)
    entries.sort(key=lambda e: e.get("started") or "")
    return entries


def format_roster(entries: list[dict], self_pid: int | None = None) -> str:
    """The always-printed Peers line. `0 LIVE` is a finding; silence is the
    failure mode."""
    if not entries:
        return "**Peers**: 0 LIVE"
    parts = []
    for e in entries:
        ident = f"{e.get('model') or e.get('harness', '?')}@{e.get('seat', '?')}/{e.get('harness', '?')}"
        bits = [f"pid {e.get('pid')}"]
        if e.get("tree"):
            bits.append(e["tree"])
        if e.get("work_unit"):
            bits.append(f"unit {e['work_unit']}")
        started = (e.get("started") or "")[11:16]
        if started:
            bits.append(f"since {started}Z")
        tag = " (this session)" if self_pid and e.get("pid") == self_pid else ""
        parts.append(f"{ident} ({', '.join(bits)}){tag}")
    return f"**Peers**: {len(entries)} LIVE — " + " · ".join(parts)


# --- origin delta (phase 2 — notification) ---------------------------------

def _git(org_dir: str, *args: str, timeout: int = 5) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", org_dir, *args],
                          capture_output=True, text=True, timeout=timeout)


def origin_delta(org_dir: str, fetch_timeout: int = 4,
                 throttle_min: int | None = None,
                 quiet_when_synced: bool = False) -> str | None:
    """One-line origin delta after a fail-soft fetch.

    Returns None only when throttled, when quiet_when_synced and in sync, or
    when org_dir is not a git repo with an origin. A failed fetch returns a
    LOUD line — "fetch failed" printed, never a silent zero. Content discipline:
    count + authors + dirs-touched, never commit subjects — enough to trigger
    pull-before-writing, not a dashboard.
    """
    try:
        r = _git(org_dir, "rev-parse", "--show-toplevel", timeout=3)
        if r.returncode != 0:
            return None
        top = (r.stdout or "").strip()
        if not top:
            return None
        # git walks parent directories; a nested folder that is not itself a
        # repo must not inherit a parent origin (session-init fixtures live
        # inside the product tree).
        if Path(top).resolve() != Path(org_dir).resolve():
            return None
    except Exception:
        return None

    tree = _tree(org_dir)
    stamp = PRESENCE_DIR.parent / f".fetch-{tree}"
    if throttle_min:
        try:
            import time
            if stamp.exists() and (time.time() - stamp.stat().st_mtime) < throttle_min * 60:
                return None
        except Exception:
            pass

    try:
        r = _git(org_dir, "fetch", "origin", "--quiet", timeout=fetch_timeout)
        if r.returncode != 0:
            tail = (r.stderr or "").strip().splitlines()
            return (f"**Origin** ({tree}): FETCH FAILED"
                    f" ({tail[-1][:80] if tail else 'rc ' + str(r.returncode)})"
                    " — origin state unknown; pull manually before writing.")
    except subprocess.TimeoutExpired:
        return (f"**Origin** ({tree}): FETCH FAILED (timeout {fetch_timeout}s)"
                " — origin state unknown; pull manually before writing.")
    except Exception as exc:
        return f"**Origin** ({tree}): FETCH FAILED ({exc.__class__.__name__}) — pull manually before writing."

    try:
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(datetime.now(timezone.utc).isoformat())
    except Exception:
        pass

    upstream = "origin/master"
    if _git(org_dir, "rev-parse", "--verify", "-q", upstream).returncode != 0:
        upstream = "origin/main"
        if _git(org_dir, "rev-parse", "--verify", "-q", upstream).returncode != 0:
            return None

    try:
        n = int(_git(org_dir, "rev-list", "--count", f"HEAD..{upstream}").stdout.strip() or "0")
    except Exception:
        return None
    if n == 0:
        return None if quiet_when_synced else f"**Origin** ({tree}): in sync (fetched)."

    authors_raw = _git(org_dir, "log", f"HEAD..{upstream}", "--format=%an").stdout.split("\n")
    authors, seen = [], set()
    for a in (x.strip() for x in authors_raw):
        if a and a not in seen:
            seen.add(a)
            authors.append(a)
    files = _git(org_dir, "diff", "--name-only", f"HEAD...{upstream}").stdout.split("\n")
    dirs, dseen = [], set()
    for f in (x.strip() for x in files):
        if not f:
            continue
        parts = f.replace("\\", "/").split("/")
        d = "/".join(parts[:2]) if len(parts) > 1 else parts[0]
        if d not in dseen:
            dseen.add(d)
            dirs.append(d)
    return (f"**Origin** ({tree}): {n} commit{'s' if n != 1 else ''} at origin not in local HEAD"
            f" — authors: {', '.join(authors[:4])}"
            f"; dirs: {', '.join(dirs[:8])}{'…' if len(dirs) > 8 else ''}."
            " Pull before writing.")


# --- notices (phase 2 — cross-machine push, consume-on-read) ---------------

def notices(consume: bool = True) -> list[dict]:
    """Read the seat's notice drop (~/.house/coord/inbox/), delivered by the
    forge's post-receive hook over the tailnet. Consume-on-read: the ack is
    the deletion (composition law — pointers are consume-on-read; git itself
    is the durable record). Unknown `kind`s are surfaced but NOT consumed
    (accept-and-defer)."""
    inbox = PRESENCE_DIR.parent / "inbox"
    if not inbox.is_dir():
        return []
    out = []
    for f in sorted(inbox.glob("*.json")):
        try:
            e = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue  # unreadable: leave for inspection, never delete blind
        known = e.get("kind") in ("push", "message")
        e["_known"] = known
        out.append(e)
        if consume and known:
            try:
                f.unlink()
            except Exception:
                pass
    return out


def format_notices(entries: list[dict]) -> str | None:
    """Notice lines, newest last; None when the inbox is empty (the
    always-printed line is Peers — notices speak only when present)."""
    if not entries:
        return None
    lines = []
    for e in entries[-5:]:
        if not e.get("_known"):
            lines.append(f"**Notice**: unhandled kind '{e.get('kind')}' in inbox (left in place)")
            continue
        ts = (e.get("ts") or "")[11:16]
        if e.get("kind") == "message":
            src = e.get("from") or {}
            ident = f"{src.get('seat', '?')}/{src.get('harness', '?')}"
            body = (e.get("text") or "")[:160]
            lines.append(f"**Message** from {ident}: {body}")
            continue
        lines.append(
            f"**Notice**: push {e.get('repo')}/{e.get('branch')} by {e.get('pusher')}"
            f" — {e.get('commits')} commit(s), authors: {e.get('authors')}; dirs: {e.get('dirs')}"
            f"{' at ' + ts + 'Z' if ts else ''}. Pull before writing."
        )
    if len(entries) > 5:
        lines.append(f"**Notice**: … and {len(entries) - 5} earlier (consumed)")
    return "\n".join(lines)


# --- CLI -------------------------------------------------------------------

def _post_socket(addr: str, token: str, envelope: dict) -> str:
    import socket as sk
    auth = json.dumps({"type": "auth", "token": token}) + "\n"
    send = json.dumps({"type": "send", "envelope": envelope}) + "\n"
    payload = (auth + send).encode("utf-8")
    if addr.startswith("unix:"):
        s = sk.socket(sk.AF_UNIX, sk.SOCK_STREAM)
        s.settimeout(4)
        s.connect(addr[5:])
    elif addr.startswith("tcp:"):
        host, port = addr[4:].rsplit(":", 1)
        s = sk.create_connection((host, int(port)), timeout=4)
    else:
        raise ValueError(f"unknown socket addr {addr}")
    try:
        s.sendall(payload)
        return s.recv(4096).decode("utf-8", "replace")
    finally:
        s.close()


def send(target: str, text: str) -> str:
    """Addressed send. Live local socket if the roster has one; else inbox drop."""
    import uuid
    entries = roster()
    hit = None
    t = target.lower()
    for e in entries:
        sid = str(e.get("session_id") or "")
        ident = f"{e.get('seat')}/{e.get('harness')}/{sid}".lower()
        if sid == target or ident == t or f"{e.get('seat')}/{e.get('harness')}".lower() == t or str(e.get("seat", "")).lower() == t:
            hit = e
            break
    env = {
        "msgid": str(uuid.uuid4()),
        "kind": "message",
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "from": {"seat": os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "unknown",
                 "harness": os.environ.get("HOUSE_HARNESS", "amore")},
        "to": None,
        "text": text,
    }
    if hit and hit.get("socket") and hit.get("socket_token"):
        try:
            raw = _post_socket(hit["socket"], hit["socket_token"], env)
            return f"sent via socket: {raw.strip()}"
        except Exception as exc:
            return f"socket failed ({exc.__class__.__name__}); dropping to inbox"
    inbox = PRESENCE_DIR.parent / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    (inbox / f"{env['msgid']}.json").write_text(json.dumps(env, indent=1), encoding="utf-8")
    return f"dropped to inbox {env['msgid']}"


def _cli(argv: list[str]) -> int:
    verb = argv[0] if argv else "roster"
    opts: dict[str, str] = {}
    rest: list[str] = []
    i = 1
    while i < len(argv):
        if argv[i].startswith("--"):
            key = argv[i][2:].replace("-", "_")
            val = argv[i + 1] if i + 1 < len(argv) and not argv[i + 1].startswith("--") else "1"
            opts[key] = val
            i += 2 if val != "1" or (i + 1 < len(argv) and argv[i + 1] == "1") else 1
        else:
            rest.append(argv[i])
            i += 1
    pid = int(opts["pid"]) if "pid" in opts else None

    if verb == "start":
        e = start(harness=opts.get("harness", "amore"),
                  model=opts.get("model"), session_id=opts.get("session_id"),
                  work_unit=opts.get("work_unit"), pid=pid, cwd=opts.get("cwd"))
        print(f"presence: {e['harness']}-{e['pid']} ({e['seat']}, {e['tree']})")
    elif verb == "stop":
        print(f"presence: removed {stop(pid=pid, harness=opts.get('harness'))}")
    elif verb == "set":
        print(f"presence: updated {set_work_unit(opts.get('work_unit', ''), pid=pid)}")
    elif verb == "roster":
        entries = roster()
        if "json" in opts:
            print(json.dumps(entries, indent=1))
        else:
            self_pid, _ = find_session_pid()
            print(format_roster(entries, self_pid))
    elif verb == "delta":
        line = origin_delta(opts.get("cwd") or os.getcwd(),
                            throttle_min=int(opts["throttle_min"]) if "throttle_min" in opts else None,
                            quiet_when_synced="quiet_when_synced" in opts)
        if line:
            print(line)
    elif verb == "notices":
        line = format_notices(notices(consume="peek" not in opts))
        if line:
            print(line)
    elif verb == "send":
        if not rest:
            print("usage: coord_presence.py send <target> <message>", file=sys.stderr)
            return 0
        print(send(rest[0], " ".join(rest[1:])))
    else:
        print(f"unknown verb: {verb}", file=sys.stderr)
        return 0  # fail-soft
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        sys.exit(_cli(sys.argv[1:]))
    except Exception as exc:  # fail-soft: never block a hook
        print(f"coord-presence error: {exc}", file=sys.stderr)
        sys.exit(0)
