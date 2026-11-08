"""Dependency-free helpers for editing the shared agent-quota config.toml.

Both the CLI (agent_quota.py) and the GNOME settings server
(gnome-shell-extension/settings_server.py) rewrite config.toml in place.  This
module is the one copy of the pieces they share: the lexical scanner that
groups multi-line values into logical entries, an atomic file replacement, and
an advisory cross-process lock (kept under the cache directory, not beside the
file).  It imports only the standard library so the settings server can load
it without pulling in the CLI's dependencies.
"""

from __future__ import annotations

import hashlib
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


def lock_dir() -> Path:
    """Where lock files live: ``~/.cache/agent-quota/locks``, the one place for every caller.

    ``$XDG_CACHE_HOME`` is deliberately ignored.  The lock only has to be the
    same file for every process that edits one config.toml, and those processes
    do not share an environment: the CLI runs in the user's shell, the settings
    server is spawned by GNOME Shell (prefs.js, which resolves the cache
    directory with GLib.get_user_cache_dir()) and the backend by the extension.
    If any of them saw another XDG_CACHE_HOME they would flock different files
    and exclude nothing.  The home directory is the one thing they agree on;
    it is also where providers/common.py keeps CACHE_DIR.
    """
    return Path.home() / ".cache" / "agent-quota" / "locks"


def _sidecar_lock_path(real: Path) -> Path:
    return real.with_name(f"{real.name}.lock")


def lock_path_for(path: Path) -> Path:
    """Lock file for `path`, kept out of its directory.

    The config directory is often a symlink into a dotfiles repository, where a
    stray ``<name>.lock`` would show up as untracked.  The lock therefore lives
    in the cache directory, named from a hash of the symlink-resolved path so
    every alias of one file shares one lock.  If that directory cannot be made
    private, falls back to a sidecar ``<name>.lock`` next to the real file.
    """
    real = Path(os.path.realpath(path))
    digest = hashlib.sha256(os.fsencode(real)).hexdigest()[:32]
    directory = lock_dir()
    try:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    except OSError:
        return _sidecar_lock_path(real)
    return directory / f"{digest}.lock"


@contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """Hold an exclusive advisory lock for `path`'s read-modify-write.

    The lock lives on a separate file (see :func:`lock_path_for`) rather than
    on `path` itself because atomic replacement swaps the inode a lock on
    `path` would be held on.  flock is per open file description, so this
    serialises separate processes and also separate calls in one process; do
    not nest it.  Nothing is created next to `path`, unless the cache directory
    is unusable.  Without fcntl (non-POSIX) this is a no-op.
    """
    if fcntl is None:  # pragma: no cover - non-POSIX hosts
        yield
        return
    lock_file = lock_path_for(path)
    try:
        descriptor = os.open(lock_file, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        # The cache directory exists but is not writable: use the sidecar.
        sidecar = _sidecar_lock_path(Path(os.path.realpath(path)))
        if lock_file == sidecar:
            raise
        descriptor = os.open(sidecar, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)  # closing releases the lock


class SecretFileUnreadable(OSError):
    """A credential file exists but could not be read, so it was left untouched."""


DEFAULT_SECRET_HEADER = "# agent-quota provider credentials\n"


def secret_assignment_key(line: str) -> str | None:
    """Key of a `KEY=value` credential line, None for comments, blanks and junk."""
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        return None
    return line.partition("=")[0].strip()


def find_secret_value(text: str, key: str) -> str | None:
    """Value of the last `key=` assignment in credential-file text (None if unset or empty).

    The last assignment wins, like the provider loaders.
    """
    lines, _ = split_lines(text)
    value: str | None = None
    for line in lines:
        if secret_assignment_key(line) == key:
            value = line.partition("=")[2].strip() or None
    return value


def load_secret_value(path: Path, key: str) -> str | None:
    """Saved value of `key` in a credential file; None when missing, unreadable or empty."""
    try:
        with open(path, encoding="utf-8", newline="") as handle:
            text = handle.read()
    except (OSError, UnicodeDecodeError):
        # Nothing usable saved.  save_secret_value is the one that refuses to
        # overwrite a file it cannot read.
        return None
    return find_secret_value(text, key)


def upsert_secret_value(text: str, key: str, value: str) -> str:
    """Return `text` with one canonical `key=value` line, keeping everything else.

    The key is replaced where its last assignment stands (duplicates are
    dropped, since the loaders let the last one win) or appended if absent.
    Other assignments, comments and the file's line endings are preserved.
    """
    lines, newline = split_lines(text)
    assignment = f"{key}={value.strip()}"
    kept: list[str] = []
    insert_at = -1
    for line in lines:
        if secret_assignment_key(line) == key:
            insert_at = len(kept)
        else:
            kept.append(line)
    if insert_at < 0:
        while kept and not kept[-1].strip():
            kept.pop()
        kept.append(assignment)
    else:
        kept.insert(insert_at, assignment)
    return join_lines(kept, newline)


def save_secret_value(path: Path, key: str, value: str, header: str = DEFAULT_SECRET_HEADER) -> None:
    """Set one `KEY=value` in a provider credential file (the one writer CLI and server share).

    The read-modify-write runs under the advisory :func:`file_lock` and replaces
    the file atomically with mode 0600, resolving a symlinked path first.  The
    file is read with ``newline=""`` so CRLF endings survive.  Only a missing
    file starts from `header`; any other read failure raises
    :class:`SecretFileUnreadable` and leaves the file untouched.  A value
    spanning several lines raises ValueError.
    """
    if "\n" in value or "\r" in value:
        raise ValueError("credential value must be a single line")
    path.parent.mkdir(parents=True, exist_ok=True)
    with file_lock(path):
        try:
            with open(path, encoding="utf-8", newline="") as handle:
                text = handle.read()
        except FileNotFoundError:
            text = header
        except (OSError, UnicodeDecodeError) as error:
            reason = getattr(error, "strerror", None) or str(error)
            raise SecretFileUnreadable(f"{path} could not be read, leaving it unchanged: {reason}") from error
        atomic_write_text(path, upsert_secret_value(text, key, value), 0o600)
