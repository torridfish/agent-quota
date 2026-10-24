"""Shared access to ``~/.config/agent-quota/config.toml``.

The file has two kinds of owner: the CLI owns the root keys (``enabled``,
``show_user``), and every managed table belongs to exactly one writer
(``[gnome]`` to the settings mirror, ``[display]`` to the shared thresholds).

Rules this module enforces so the two writers cannot damage each other:

* a writer replaces only what it owns, never the whole file;
* a file this module cannot locate unambiguously is reported as an error
  instead of being rewritten (guessing is how config files get corrupted);
* every write is re-parsed before it replaces the old file, and the rename is
  atomic, so a reader always sees a complete document;
* writes are serialized across processes, so the CLI and the extension cannot
  lose each other's updates;
* existing file permissions are preserved.
"""

from __future__ import annotations

import contextlib
import fcntl
import os
import re
import tempfile
import tomllib
from pathlib import Path

# `[table]` or `["quoted table"]`; array-of-tables entries are rejected below.
_HEADER_RE = re.compile(r"^\[(?P<array>\[)?(?P<name>[^\[\]]+)\]\]?\s*(?:#.*)?$")

_CONTAINER_OPENERS = "[{"
_CONTAINER_CLOSERS = "]}"


class ConfigError(Exception):
    """The file cannot be read, or cannot be rewritten safely."""


# ===== value rendering =====


_SHORT_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
}


def toml_string(value: str) -> str:
    """Render a proper TOML basic string.

    Non-BMP characters stay literal (UTF-8 is valid inside a basic string).
    Escaping them as UTF-16 surrogate pairs — what ``json.dumps`` does — makes
    ``tomllib`` reject the whole file.
    """
    out = ['"']
    for char in value:
        escape = _SHORT_ESCAPES.get(char)
        if escape is not None:
            out.append(escape)
            continue
        code = ord(char)
        if code < 0x20 or code == 0x7F:
            out.append(f"\\u{code:04X}")
            continue
        out.append(char)
    out.append('"')
    return "".join(out)


def toml_value(value: object) -> str:
    """Render a scalar or a list of scalars as a TOML literal."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):  # noqa: PLR0124
            raise ConfigError(f"cannot represent {value!r} in TOML")
        return repr(value)
    if isinstance(value, str):
        return toml_string(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    raise ConfigError(f"cannot represent {type(value).__name__} in TOML")


# ===== scanning =====


class _Section:
    def __init__(self, name: str, header: str) -> None:
        self.name = name
        self.lines: list[str] = [header]


def _advance(line: str, depth: int, triple: str | None) -> tuple[int, str | None]:
    """Track string and bracket state across one physical line."""
    index = 0
    length = len(line)
    while index < length:
        if triple is not None:
            if line.startswith(triple, index):
                triple = None
                index += 3
                continue
            if triple == '"""' and line[index] == "\\":
                index += 2
                continue
            index += 1
            continue
        char = line[index]
        if char == "#":
            break
        if char in "\"'" and line.startswith(char * 3, index):
            triple = char * 3
            index += 3
            continue
        if char == '"':
            index += 1
            while index < length:
                if line[index] == "\\":
                    index += 2
                    continue
                if line[index] == '"':
                    index += 1
                    break
                index += 1
            continue
        if char == "'":
            index += 1
            while index < length and line[index] != "'":
                index += 1
            index += 1
            continue
        if char in _CONTAINER_OPENERS:
            depth += 1
        elif char in _CONTAINER_CLOSERS:
            depth = max(0, depth - 1)
        index += 1
    return depth, triple


def _split(text: str) -> tuple[list[str], list[_Section]]:
    """Split into the root region and the named tables, in file order."""
    root: list[str] = []
    sections: list[_Section] = []
    current: _Section | None = None
    depth = 0
    triple: str | None = None
    for line in text.splitlines():
        if triple is None and depth == 0:
            match = _HEADER_RE.match(line.strip())
            if match is not None:
                if match.group("array"):
                    raise ConfigError(
                        "array-of-tables entries are not supported; "
                        "remove them or edit the file by hand"
                    )
                name = match.group("name").strip().strip("'\"")
                if any(section.name == name for section in sections):
                    raise ConfigError(f"duplicate table [{name}]")
                current = _Section(name, line)
                sections.append(current)
                continue
        (current.lines if current is not None else root).append(line)
        depth, triple = _advance(line, depth, triple)
    if triple is not None or depth > 0:
        raise ConfigError("the file ends inside an unterminated value")
    return root, sections


def _trim(lines: list[str]) -> list[str]:
    trimmed = list(lines)
    while trimmed and not trimmed[-1].strip():
        trimmed.pop()
    return trimmed


def _group(lines: list[str]) -> list[list[str]]:
    """Group physical lines into logical statements (multi-line values join)."""
    units: list[list[str]] = []
    current: list[str] = []
    depth = 0
    triple: str | None = None
    for line in lines:
        current.append(line)
        depth, triple = _advance(line, depth, triple)
        if depth == 0 and triple is None:
            units.append(current)
            current = []
    if current:
        units.append(current)
    return units


def _statement_key(unit: list[str]) -> str:
    bare = unit[0].split("#", 1)[0].strip()
    if "=" not in bare:
        return ""
    return bare.partition("=")[0].strip().strip("'\"")


# ===== atomic, locked writes =====


@contextlib.contextmanager
def _locked(path: Path):
    """Serialize read-modify-write across processes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f".{path.name}.lock")
    descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _atomic_write(path: Path, text: str) -> None:
    """Replace ``path`` atomically, keeping its permissions."""
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        mode = 0o644
    descriptor, temporary = tempfile.mkstemp(
        dir=path.parent, prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)
        raise


def _read_for_update(path: Path) -> str:
    """Return the current text; invalid content is an error, never silence."""
    try:
        text = path.read_text()
    except FileNotFoundError:
        return ""
    except OSError as error:
        raise ConfigError(f"cannot read {path}: {error}") from error
    if text.strip():
        try:
            tomllib.loads(text)
        except tomllib.TOMLDecodeError as error:
            raise ConfigError(f"{path} is not valid TOML: {error}") from error
    return text


def _commit(path: Path, text: str) -> None:
    try:
        tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:  # pragma: no cover - defensive
        raise ConfigError(f"refusing to write invalid TOML: {error}") from error
    _atomic_write(path, text)


# ===== public API =====


def load(path: Path) -> dict[str, object]:
    """Parse the file. Missing means empty; invalid is an error, never empty."""
    try:
        text = path.read_text()
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise ConfigError(f"cannot read {path}: {error}") from error
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(f"{path} is not valid TOML: {error}") from error


def _render_table(name: str, values: dict[str, object]) -> str:
    lines = [f"[{name}]"]
    lines.extend(f"{key} = {toml_value(values[key])}" for key in values)
    return "\n".join(lines)


def replace_tables(path: Path, tables: dict[str, dict[str, object]]) -> None:
    """Replace each named table wholesale, leaving everything else untouched.

    Only pass tables this writer owns: the whole table is rewritten, so any key
    the caller omits disappears from it.
    """
    with _locked(path):
        root, sections = _split(_read_for_update(path))
        blocks: list[str] = []
        root_body = "\n".join(_trim(root))
        if root_body:
            blocks.append(root_body)
        for section in sections:
            if section.name in tables:
                blocks.append(_render_table(section.name, tables[section.name]))
            else:
                blocks.append("\n".join(_trim(section.lines)))
        for name, values in tables.items():
            if not any(section.name == name for section in sections):
                blocks.append(_render_table(name, values))
        _commit(path, "\n\n".join(blocks).rstrip("\n") + "\n")


def update_root(
    path: Path,
    values: dict[str, object],
    *,
    remove: tuple[str, ...] = (),
    header: tuple[str, ...] = (),
) -> None:
    """Set (and optionally clear) root keys, keeping tables and comments."""
    with _locked(path):
        root, sections = _split(_read_for_update(path))
        owned = set(values) | set(remove)
        blocks = ["\n".join(_render_root(root, values, owned, header))]
        blocks.extend("\n".join(_trim(section.lines)) for section in sections)
        blocks = [block for block in blocks if block.strip()]
        _commit(path, "\n\n".join(blocks).rstrip("\n") + "\n")


def _render_root(
    root: list[str],
    values: dict[str, object],
    owned: set[str],
    header: tuple[str, ...],
) -> list[str]:
    rendered = {key: f"{key} = {toml_value(value)}" for key, value in values.items()}
    kept: list[str] = []
    insert_at: int | None = None
    for unit in _group(root):
        key = _statement_key(unit)
        if key and key in owned:
            # Drop the whole statement, including any continuation lines, so a
            # multi-line assignment cannot leave a dangling fragment behind.
            if insert_at is None:
                insert_at = len(kept)
            continue
        kept.extend(unit)
    if not _trim(kept):
        kept = list(header)
        insert_at = len(kept)
    elif insert_at is None:
        insert_at = 0
        while insert_at < len(kept) and (
            not kept[insert_at].strip() or kept[insert_at].lstrip().startswith("#")
        ):
            insert_at += 1
    for offset, key in enumerate(values):
        kept.insert(insert_at + offset, rendered[key])
    return _trim(kept)
