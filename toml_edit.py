"""Dependency-free helpers for editing the shared agent-quota config.toml.

Both the CLI (agent_quota.py) and the GNOME settings server
(gnome-shell-extension/settings_server.py) rewrite config.toml in place.  This
module is the one copy of the pieces they share: the lexical scanner that
groups multi-line values into logical entries, an atomic file replacement, and
an advisory cross-process lock.  It imports only the standard library so the
settings server can load it without pulling in the CLI's dependencies.
"""

from __future__ import annotations

import os
import stat
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX hosts have no flock
    fcntl = None  # type: ignore[assignment]


def scan_line(line: str, ml_delim: str | None, depth: int) -> tuple[str | None, int]:
    """Advance the TOML lexical state across one line.

    Tracks multi-line strings and array bracket depth so a value spanning
    several lines is one logical entry.  Returns (open multi-line string
    delimiter, bracket depth) at the end of the line.
    """
    i, n = 0, len(line)
    while i < n:
        if ml_delim is not None:
            # Inside a multi-line string.  In a basic string (""") a backslash
            # escapes the next character, so \""" is an escaped quote plus two
            # more quotes, not a terminator; literal strings (''') have no
            # escapes.
            if ml_delim == '"""' and line[i] == "\\":
                i += 2
            elif line.startswith(ml_delim, i):
                i += 3
                # Up to two further quotes directly before the terminator are
                # string content (`""""` is one quote plus the terminator).
                extra = 0
                while extra < 2 and i < n and line[i] == ml_delim[0]:
                    i += 1
                    extra += 1
                ml_delim = None
            else:
                i += 1
            continue
        ch = line[i]
        if ch == "#":
            break
        if line.startswith('"""', i) or line.startswith("'''", i):
            ml_delim = line[i : i + 3]
            i += 3
        elif ch == '"':
            i += 1
            while i < n and line[i] != '"':
                i += 2 if line[i] == "\\" else 1
            i += 1
        elif ch == "'":
            end = line.find("'", i + 1)
            i = n if end < 0 else end + 1
        else:
            if ch == "[":
                depth += 1
            elif ch == "]":
                depth = max(0, depth - 1)
            i += 1
    return ml_delim, depth


def logical_entries(lines: list[str]) -> list[tuple[int, int]]:
    """Split lines into (start, end) logical entries.

    A multi-line array or string belongs to the entry that opened it, so only
    an entry's first line can be a table header.
    """
    entries: list[tuple[int, int]] = []
    i = 0
    while i < len(lines):
        start = i
        ml_delim, depth = scan_line(lines[i], None, 0)
        i += 1
        while (ml_delim is not None or depth > 0) and i < len(lines):
            ml_delim, depth = scan_line(lines[i], ml_delim, depth)
            i += 1
        entries.append((start, i))
    return entries


def split_lines(text: str) -> tuple[list[str], str]:
    """Split config text into lines on "\\n" only; return (lines, newline style).

    ``str.splitlines`` also breaks on U+0085, U+2028, U+2029, \\v, \\f and
    friends, all of which TOML allows inside comments and strings; splitting
    there cuts a comment or string mid-line and rejoining with "\\n" turns its
    tail into a bare statement.  A trailing "\\r" is stripped from every line,
    and the style ("\\r\\n" if the first line break is CRLF, else "\\n") is
    returned so :func:`join_lines` can write the file back the way it was.
    Read the text with ``newline=""`` so the CRLFs are still there to detect.
    """
    if not text:
        return [], "\n"
    first = text.find("\n")
    newline = "\r\n" if first > 0 and text[first - 1] == "\r" else "\n"
    lines = text.split("\n")
    if lines[-1] == "":  # the text ended with a line break
        lines.pop()
    return [line[:-1] if line.endswith("\r") else line for line in lines], newline


def join_lines(lines: list[str], newline: str = "\n") -> str:
    """Inverse of :func:`split_lines`: every line, including the last, ends with `newline`."""
    return "".join(line + newline for line in lines)


def atomic_write_text(path: Path, text: str, mode: int, *, preserve_mode: bool = False) -> None:
    """Replace `path` with `text` through a uniquely named temp file.

    mkstemp gives every writer its own temp name (so concurrent writers never
    share a file) and creates it 0600; the final mode is set before the rename
    so a private file is never briefly readable.  A symlinked `path` is
    resolved first so the link survives and the real file is replaced.  With
    `preserve_mode` an existing file keeps its permissions; `mode` is then only
    used when the file is created.
    """
    path = Path(os.path.realpath(path))
    if preserve_mode:
        try:
            mode = stat.S_IMODE(path.stat().st_mode)
        except OSError:
            pass
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
            os.fchmod(handle.fileno(), mode)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def lock_path_for(path: Path) -> Path:
    """Sidecar lock file next to the real (symlink-resolved) `path`."""
    real = Path(os.path.realpath(path))
    return real.with_name(f"{real.name}.lock")


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Hold an exclusive advisory lock for `path`'s read-modify-write.

    The lock lives on a sidecar file (``<name>.lock``) rather than on `path`
    itself because atomic replacement swaps the inode a lock on `path` would be
    held on.  flock is per open file description, so this serialises separate
    processes and also separate calls in one process; do not nest it.  The
    parent directory is created if needed.  Without fcntl (non-POSIX) this is
    a no-op.
    """
    if fcntl is None:  # pragma: no cover - non-POSIX hosts
        yield
        return
    lock_file = lock_path_for(path)
    lock_file.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(lock_file, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)  # closing releases the lock
