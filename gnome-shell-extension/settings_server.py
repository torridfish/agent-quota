#!/usr/bin/env python3
"""Local settings server for the Agent Quota GNOME extension.

The GNOME preferences window is only a launcher.  This process serves the
web-settings SPA on 127.0.0.1 and bridges it to the extension's GSettings
schema.  Secrets are write-only: the API can report whether a credential is
configured, but it never returns the value.

Settings are mirrored into the [gnome] table of the agent-quota config.toml
so they stay portable: user-facing preferences found there are validated and
pushed into GSettings when the server starts, and GSettings are written back
into the table on every save.  State the extension itself maintains (see
EXTENSION_OWNED_KEYS) is never pushed from the file: dconf is its source of
truth, and the file is refreshed from it.  The extension keeps reading
GSettings.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import secrets
import signal
import stat
import sys
import tempfile
import threading
import time
import tomllib
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

GIO_IMPORT_ERROR: Exception | None = None
try:
    import gi

    gi.require_version("Gio", "2.0")
    gi.require_version("GLib", "2.0")
    from gi.repository import Gio, GLib
except (ImportError, ValueError) as error:  # pragma: no cover - host dependent
    Gio = None
    GLib = None
    GIO_IMPORT_ERROR = error


SCHEMA_ID = "org.gnome.shell.extensions.agent-quota"
SERVER_VERSION = 1
CLI_CONFIG_NAME = "config.toml"
# Serialises every read-modify-write of config.toml, the credential files and
# the info file: ThreadingHTTPServer handles requests concurrently.
WRITE_LOCK = threading.RLock()
MAX_BODY_BYTES = 1024 * 1024
MAX_LAYOUT_BYTES = 100 * 1024
# GSettings keys the extension writes or migrates itself (detected gauges,
# label spellings, layout JSON).  dconf is authoritative for these: pushing the
# copy in config.toml back would resurrect stale labels and bypass validation.
EXTENSION_OWNED_KEYS = frozenset({
    "popup-layout",
    "hidden-metrics",
    "metric-options",
    "codex-workspace-options",
})
TOKEN_HEADER = "X-Agent-Quota-Token"
TOKEN_QUERY = "token"
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
}
SECURITY_HEADERS = {
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "base-uri 'none'; "
        "form-action 'none'"
    ),
}


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
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
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


def assignment_pattern(key: str) -> re.Pattern[str]:
    return re.compile(rf"^[ \t]*{re.escape(key)}[ \t]*=(.*)$", re.MULTILINE)


def read_assignment(contents: str, key: str) -> str:
    """Match the Python provider loaders: last assignment wins."""
    value = ""
    for match in assignment_pattern(key).finditer(contents):
        value = match.group(1).strip()
    return value


def upsert_assignment(contents: str, key: str, value: str) -> str:
    """Replace every assignment of key with one canonical line."""
    assignment = f"{key}={value.strip()}"
    matcher = re.compile(rf"^[ \t]*{re.escape(key)}[ \t]*=.*$", re.MULTILINE)
    lines = contents.split("\n")
    insert_at = -1
    kept = []
    for line in lines:
        if matcher.match(line):
            insert_at = len(kept)
        else:
            kept.append(line)
    if insert_at == -1:
        text = contents.rstrip()
        return f"{text}{chr(10) if text else ''}{assignment}\n"
    kept.insert(insert_at, assignment)
    return "\n".join(kept)


def parse_json_list(values: list[str]) -> list[object]:
    result = []
    for value in values:
        try:
            result.append(json.loads(value))
        except (TypeError, ValueError):
            continue
    return result


class SettingsBackend:
    """Small typed wrapper around Gio.Settings."""

    def __init__(self, schema_dir: Path):
        if Gio is None or GLib is None:
            raise RuntimeError("python3-gi (PyGObject) is required for settings")
        source = Gio.SettingsSchemaSource.new_from_directory(
            str(schema_dir),
            Gio.SettingsSchemaSource.get_default(),
            False,
        )
        schema = source.lookup(SCHEMA_ID, False)
        if schema is None:
            raise RuntimeError(f"GSettings schema {SCHEMA_ID} was not found in {schema_dir}")
        self.schema = schema
        self.settings = Gio.Settings.new_full(schema, None, None)
        self.keys = set(schema.list_keys())

    def type_string(self, key: str) -> str:
        return self.schema.get_key(key).get_value_type().dup_string()

    def all(self) -> dict[str, object]:
        return {key: self.settings.get_value(key).unpack() for key in sorted(self.keys)}

    def get(self, key: str) -> object:
        return self.settings.get_value(key).unpack()

    def validate(self, key: str, value: object) -> object:
        """Return the GVariant for `value`, or raise ValueError.

        Checks the type and then the schema's range or choices, which
        Gio.Settings.set_value would otherwise only report as a False result.
        """
        if key not in self.keys:
            raise ValueError(f"unknown setting: {key}")
        expected = self.type_string(key)
        if expected == "b":
            if not isinstance(value, bool):
                raise ValueError(f"{key} expects a boolean")
        elif expected == "i":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"{key} expects an integer")
        elif expected == "s":
            if not isinstance(value, str):
                raise ValueError(f"{key} expects a string")
        elif expected == "as":
            if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
                raise ValueError(f"{key} expects a string array")
        else:  # pragma: no cover - schema currently only uses these types
            raise ValueError(f"unsupported GSettings type {expected} for {key}")
        try:
            variant = GLib.Variant(expected, value)
        except (OverflowError, TypeError) as error:
            raise ValueError(f"{key} is out of range") from error
        schema_key = self.schema.get_key(key)
        if not schema_key.range_check(variant):
            raise ValueError(f"{key} {self._allowed(schema_key)}")
        return variant

    @staticmethod
    def _allowed(schema_key: object) -> str:
        try:
            kind, payload = schema_key.get_range().unpack()
        except Exception:  # pragma: no cover - defensive
            return "is out of range or not an allowed value"
        if kind == "range":
            return f"must be between {payload[0]} and {payload[1]}"
        if kind == "enum":
            return "must be one of: " + ", ".join(str(item) for item in payload)
        return "is not an allowed value"

    def set(self, key: str, value: object) -> object:
        variant = self.validate(key, value)
        if not self.settings.set_value(key, variant):
            raise ValueError(f"{key} was rejected by GSettings (read-only or not an allowed value)")
        return self.settings.get_value(key).unpack()


class SecretStore:
    def __init__(self, providers: list[dict], directory: Path):
        self.providers = providers
        self.directory = directory
        self.by_id = {provider["id"]: provider for provider in providers}

    def _file(self, provider_id: str) -> Path:
        return self.directory / f"{provider_id}.conf"

    def _provider(self, provider_id: str) -> dict:
        provider = self.by_id.get(provider_id)
        if provider is None:
            raise ValueError(f"unknown provider: {provider_id}")
        return provider

    def allowed_key(self, provider_id: str, key: str) -> None:
        provider = self._provider(provider_id)
        secret = provider.get("secret")
        if not secret or secret.get("key") != key:
            raise ValueError(f"{key} is not a credential field for {provider_id}")

    def configured(self, provider_id: str) -> bool:
        provider = self.by_id.get(provider_id)
        if not provider or not provider.get("secret"):
            return False
        try:
            contents = self._file(provider_id).read_text()
        except OSError:
            return False
        return bool(read_assignment(contents, provider["secret"]["key"]))

    def set(self, provider_id: str, key: str, value: str) -> bool:
        self.allowed_key(provider_id, key)
        if not isinstance(value, str):
            raise ValueError("credential value must be a string")
        if "\n" in value or "\r" in value:
            raise ValueError("credential value must be a single line")
        path = self._file(provider_id)
        with WRITE_LOCK:
            self.directory.mkdir(parents=True, exist_ok=True)
            os.chmod(self.directory, 0o700)
            try:
                contents = path.read_text(encoding="utf-8")
            except OSError:
                contents = "# Managed by Agent Quota GNOME extension\n"
            atomic_write_text(path, upsert_assignment(contents, key, value), 0o600)
        return bool(value.strip())


def metric_options(values: list[str]) -> dict[str, list[str]]:
    grouped: dict[str, list[str]] = {}
    for entry in values:
        text = str(entry)
        separator = text.find(":")
        if separator <= 0 or separator == len(text) - 1:
            continue
        key = text[:separator]
        label = text[separator + 1:]
        labels = grouped.setdefault(key, [])
        if label not in labels:
            labels.append(label)
    return grouped


def workspace_options(values: list[str]) -> list[dict[str, str]]:
    result = []
    seen = set()
    for option in parse_json_list(values):
        if not isinstance(option, dict):
            continue
        identifier = option.get("id")
        if not isinstance(identifier, str) or not identifier or identifier in seen:
            continue
        seen.add(identifier)
        label = option.get("label")
        result.append({
            "id": identifier,
            "label": label if isinstance(label, str) and label else identifier,
        })
    return result


def validate_layout(layout: object, provider_ids: set[str]) -> str:
    if not isinstance(layout, dict):
        raise ValueError("layout must be an object")
    columns = layout.get("columns")
    if isinstance(columns, bool) or not isinstance(columns, int) or not 1 <= columns <= 5:
        raise ValueError("layout.columns must be between 1 and 5")
    providers = layout.get("providers")
    if not isinstance(providers, list) or len(providers) > 100:
        raise ValueError("layout.providers must be a list")
    normalized = {"version": 1, "columns": columns, "providers": []}
    for entry in providers:
        if not isinstance(entry, dict):
            raise ValueError("each layout provider must be an object")
        identifier = entry.get("id")
        if not isinstance(identifier, str) or identifier not in provider_ids:
            raise ValueError(f"unknown layout provider: {identifier!r}")
        item = {"id": identifier}
        gauge_columns = entry.get("gaugeColumns")
        if isinstance(gauge_columns, bool) or not isinstance(gauge_columns, int) or not 1 <= gauge_columns <= 5:
            raise ValueError(f"invalid gaugeColumns for {identifier}")
        item["gaugeColumns"] = gauge_columns
        order = entry.get("order")
        if not isinstance(order, list) or not all(isinstance(label, str) for label in order):
            raise ValueError(f"invalid gauge order for {identifier}")
        item["order"] = order
        for axis, limit in (("col", 100), ("row", 100)):
            if axis in entry:
                value = entry[axis]
                if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= limit:
                    raise ValueError(f"invalid {axis} for {identifier}")
                item[axis] = value
        normalized["providers"].append(item)
    raw = json.dumps(normalized, separators=(",", ":"))
    if len(raw.encode()) > MAX_LAYOUT_BYTES:
        raise ValueError("layout is too large")
    return raw


_TOML_ESCAPES = {
    '"': '\\"', "\\": "\\\\", "\b": "\\b", "\t": "\\t",
    "\n": "\\n", "\f": "\\f", "\r": "\\r",
}


def toml_string(value: str) -> str:
    """Render `value` as a TOML basic string.

    json.dumps is not usable here: it writes non-BMP characters as surrogate
    pair escapes, which TOML rejects as non-scalar values.  Non-ASCII text is
    emitted literally instead (the file is UTF-8).
    """
    out = ['"']
    for char in value:
        code = ord(char)
        if char in _TOML_ESCAPES:
            out.append(_TOML_ESCAPES[char])
        elif code < 0x20 or code == 0x7F:
            out.append(f"\\u{code:04X}")
        elif 0xD800 <= code <= 0xDFFF:
            raise ValueError("cannot represent a lone surrogate in TOML")
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def toml_value(value: object) -> str:
    """Render a GSettings value as a TOML literal (bool, int, str, or list)."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return toml_string(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    raise ValueError(f"cannot represent {type(value).__name__} in TOML")


def _scan_line(line: str, ml_delim: str | None, depth: int) -> tuple[str | None, int]:
    """Advance the TOML lexical state across one line.

    Tracks multi-line strings and array bracket depth so a value spanning
    several lines is one logical entry.  Returns (open multi-line string
    delimiter, bracket depth) at the end of the line.  Mirrors the scanner in
    agent_quota.py, which this file must not import.
    """
    i, n = 0, len(line)
    while i < n:
        if ml_delim is not None:
            end = line.find(ml_delim, i)
            if end < 0:
                return ml_delim, depth
            i = end + 3
            ml_delim = None
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
                depth -= 1
            i += 1
    return ml_delim, depth


def _logical_entries(lines: list[str]) -> list[tuple[int, int]]:
    """Split lines into (start, end) logical entries.

    A multi-line array or string belongs to the entry that opened it, so only
    an entry's first line can be a table header.
    """
    entries: list[tuple[int, int]] = []
    i = 0
    while i < len(lines):
        start = i
        ml_delim, depth = _scan_line(lines[i], None, 0)
        i += 1
        while (ml_delim is not None or depth > 0) and i < len(lines):
            ml_delim, depth = _scan_line(lines[i], ml_delim, depth)
            i += 1
        entries.append((start, i))
    return entries


_GNOME_HEADER = re.compile(r"\[\s*(?:gnome|\"gnome\"|'gnome')\s*\]\s*(?:#.*)?")


def replace_gnome_section(contents: str, values: dict[str, object]) -> str:
    """Write `values` into the [gnome] table, leaving the rest of it alone.

    The mirror only owns the keys it was handed: the table also carries
    settings it does not manage (display thresholds) and anything a newer
    version wrote, so untouched lines are preserved verbatim.  Everything
    outside the table is preserved too.  Any logical line starting with ``[``
    (``[other]``, ``[ other ]``, ``[[array.of.tables]]``) ends the section, and
    a multi-line value is replaced as a whole rather than on its first line.
    """
    lines = contents.splitlines()
    rendered = {key: f"{key} = {toml_value(values[key])}" for key in sorted(values)}
    entries = _logical_entries(lines)
    start_entry = next(
        (n for n, (first, _) in enumerate(entries) if _GNOME_HEADER.fullmatch(lines[first].strip())),
        None,
    )
    if start_entry is None:
        section = ["[gnome]"] + [rendered[key] for key in sorted(rendered)]
        prefix = "\n".join(lines).strip("\n")
        if not prefix:
            return "\n".join(section) + "\n"
        return f"{prefix}\n\n" + "\n".join(section) + "\n"

    end_entry = next(
        (n for n in range(start_entry + 1, len(entries)) if lines[entries[n][0]].lstrip().startswith("[")),
        len(entries),
    )
    tail_from = entries[end_entry][0] if end_entry < len(entries) else len(lines)

    body: list[str] = []
    seen: set[str] = set()
    for first, last in entries[start_entry + 1 : end_entry]:
        bare = lines[first].split("#", 1)[0].strip()
        key = bare.partition("=")[0].strip().strip("'\"") if "=" in bare else None
        if key in rendered:
            body.append(rendered[key])
            seen.add(key)
        else:
            body.extend(lines[first:last])

    missing = [rendered[key] for key in sorted(rendered) if key not in seen]
    insert_at = len(body)
    while insert_at > 0 and not body[insert_at - 1].strip():
        insert_at -= 1
    body[insert_at:insert_at] = missing
    result = lines[: entries[start_entry][1]] + body + lines[tail_from:]
    return "\n".join(result).strip("\n") + "\n"


def write_gnome_section(path: Path, values: dict[str, object], *, create: bool = False) -> bool:
    """Merge `values` into the [gnome] table of an existing config.toml.

    Returns whether the file was written.  The file is only created when
    `create` is set: agent_quota.py treats a config.toml without ``enabled``
    as "not configured yet", so a [gnome]-only file created here would hide
    its first-run setup.  A file that is not valid TOML is never touched, and
    neither is one that would not be valid after the merge.
    """
    with WRITE_LOCK:
        if path.exists():
            contents = path.read_text(encoding="utf-8")
            try:
                tomllib.loads(contents)
            except tomllib.TOMLDecodeError as error:
                raise ValueError(f"{path} is not valid TOML, leaving it unchanged: {error}") from error
        elif create:
            contents = ""
        else:
            return False
        updated = replace_gnome_section(contents, values)
        try:
            tomllib.loads(updated)
        except tomllib.TOMLDecodeError as error:
            raise ValueError(f"refusing to write invalid TOML to {path}: {error}") from error
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        atomic_write_text(path, updated, 0o644, preserve_mode=True)
        return True


def load_gnome_section(path: Path) -> dict[str, object]:
    """Return the [gnome] table of config.toml; empty when absent or invalid."""
    try:
        return read_gnome_section(path) or {}
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def read_gnome_section(path: Path) -> dict[str, object] | None:
    """Like load_gnome_section, but None when the file is missing and
    OSError/TOMLDecodeError propagate when it exists yet cannot be parsed."""
    if not path.exists():
        return None
    with path.open("rb") as handle:
        data = tomllib.load(handle)
    section = data.get("gnome")
    return section if isinstance(section, dict) else {}


def load_cli_enabled(path: Path) -> list[str] | None:
    """Return config.toml's top-level ``enabled`` list, or None when unset."""
    if not path.exists():
        return None
    try:
        with path.open("rb") as handle:
            data = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    enabled = data.get("enabled")
    if not isinstance(enabled, list):
        return None
    return [item for item in enabled if isinstance(item, str)]


def write_private_json(path: Path, payload: dict[str, object]) -> None:
    with WRITE_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(path.parent, 0o700)
        atomic_write_text(path, json.dumps(payload, separators=(",", ":")), 0o600)


def remove_info_file(path: Path, pid: int, token: str) -> None:
    """Unlink the info file only if it still describes this server.

    A newer server may have replaced it while this one was shutting down;
    deleting that file would strand the newer server's clients.
    """
    with WRITE_LOCK:
        try:
            info = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(info, dict) or info.get("pid") != pid or info.get("token") != token:
            return
        try:
            path.unlink()
        except FileNotFoundError:
            pass


class App:
    def __init__(self, args: argparse.Namespace):
        self.schema_dir = Path(args.schema_dir).expanduser()
        self.web_dir = Path(args.web_dir).expanduser()
        self.icons_dir = Path(args.icons_dir).expanduser()
        self.cache_dir = Path(args.cache_dir).expanduser()
        self.token = args.token or secrets.token_urlsafe(32)
        self.idle_timeout = max(60, int(args.idle_timeout))
        self.info_path = self.cache_dir / "settings-server.json"
        self.backend = SettingsBackend(self.schema_dir)
        metadata = json.loads((self.web_dir / "providers.json").read_text())
        self.providers = metadata["providers"]
        self.browsers = metadata.get("browsers", [""])
        self.provider_ids = {provider["id"] for provider in self.providers}
        config_dir = Path(args.config_dir).expanduser() if args.config_dir else Path.home() / ".config" / "agent-quota"
        self.cli_config_path = config_dir / CLI_CONFIG_NAME
        self.secrets = SecretStore(self.providers, config_dir)
        self.last_activity = time.monotonic()
        self.stop_event = threading.Event()
        self.httpd: ThreadingHTTPServer | None = None
        self._idle_thread: threading.Thread | None = None
        self._apply_cli_config()

    def _apply_cli_config(self) -> None:
        """Push the user-facing config.toml [gnome] preferences into GSettings.

        Preferences found in the file override the current dconf state, but
        only after the same validation the API applies (type, range, choices).
        Keys in EXTENSION_OWNED_KEYS are never pushed: the extension migrates
        and rewrites them in dconf, so the file copy may be stale (and
        popup-layout would bypass validate_layout).  They are refreshed from
        dconf below instead.  Keys the schema does not know are warned about
        and left in the file: the table also carries settings this mirror does
        not manage, and dropping them would be destructive.  Keys that were
        not applied are topped up from dconf so the file always describes the
        whole schema and stays portable.
        """
        try:
            section = read_gnome_section(self.cli_config_path)
        except (OSError, tomllib.TOMLDecodeError) as error:
            # An unreadable file is the user's to fix; never rewrite it from
            # dconf state, which would discard whatever they had written.
            sys.stderr.write(f"leaving {self.cli_config_path} untouched, could not parse it: {error}\n")
            return
        if section is None:
            # No config.toml yet: it is created by `agent-quota setup`, not here.
            return
        applied: set[str] = set()
        for key, value in section.items():
            if key not in self.backend.keys:
                sys.stderr.write(f"ignoring unknown setting {key!r} in {self.cli_config_path}\n")
                continue
            if key in EXTENSION_OWNED_KEYS:
                continue
            try:
                self.backend.set(key, value)
            except (ValueError, TypeError, OverflowError) as error:
                sys.stderr.write(f"ignoring {key!r} in {self.cli_config_path}: {error}\n")
                continue
            applied.add(key)
        missing = sorted(self.backend.keys - applied)
        if not missing:
            return
        try:
            write_gnome_section(
                self.cli_config_path,
                {key: self.backend.get(key) for key in missing},
            )
        except Exception as error:
            sys.stderr.write(f"could not update {self.cli_config_path}: {error}\n")

    def _persist_cli_config(self) -> None:
        """Mirror the current GSettings into config.toml's [gnome] table."""
        try:
            write_gnome_section(self.cli_config_path, self.backend.all())
        except Exception as error:
            sys.stderr.write(f"could not update {self.cli_config_path}: {error}\n")

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def state(self) -> dict[str, object]:
        values = self.backend.all()
        return {
            "version": SERVER_VERSION,
            "settings": values,
            "keys": {key: self.backend.type_string(key) for key in sorted(self.backend.keys)},
            "providers": self.providers,
            "browsers": self.browsers,
            "secrets": {
                provider["id"]: self.secrets.configured(provider["id"])
                for provider in self.providers
                if provider.get("secret")
            },
            "metricOptions": metric_options(values.get("metric-options", [])),
            "workspaces": workspace_options(values.get("codex-workspace-options", [])),
            "cliEnabled": load_cli_enabled(self.cli_config_path),
        }

    def set_setting(self, key: str, value: object) -> object:
        if key in {"popup-layout", "metric-options", "codex-workspace-options"}:
            raise ValueError(f"{key} cannot be changed through this endpoint")
        with WRITE_LOCK:
            result = self.backend.set(key, value)
            self._persist_cli_config()
        return result

    def set_layout(self, payload: dict[str, object]) -> None:
        layout = payload.get("layout")
        raw = validate_layout(layout, self.provider_ids)
        settings = payload.get("settings", {})
        if not isinstance(settings, dict):
            raise ValueError("settings must be an object")
        allowed = {
            "layout-columns": (1, 5),
            "layout-gap": (0, 32),
            "layout-padding": (0, 24),
            "layout-gauge-spacing": (0, 32),
        }
        updates: dict[str, object] = {"popup-layout": raw}
        for key, (lower, upper) in allowed.items():
            if key not in settings:
                continue
            value = settings[key]
            if isinstance(value, bool) or not isinstance(value, int) or not lower <= value <= upper:
                raise ValueError(f"{key} is out of range")
            updates[key] = value
        with WRITE_LOCK:
            # Validate every value against the schema before the first write so
            # a rejected key cannot leave the layout half-applied.
            for key, value in updates.items():
                self.backend.validate(key, value)
            previous = {key: self.backend.get(key) for key in updates}
            try:
                for key, value in updates.items():
                    self.backend.set(key, value)
            except Exception:
                for key, old in previous.items():
                    try:
                        self.backend.set(key, old)
                    except Exception:  # pragma: no cover - best-effort rollback
                        pass
                raise
            self._persist_cli_config()

    def stop(self) -> None:
        self.stop_event.set()
        if self.httpd is not None:
            threading.Thread(target=self.httpd.shutdown, daemon=True).start()

    def idle_watch(self) -> None:
        while not self.stop_event.wait(10):
            if time.monotonic() - self.last_activity >= self.idle_timeout:
                self.stop()
                return


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentQuotaSettings/1"

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep the log free of query strings, which carry the token.
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")

    def log_request(self, code: object = "-", size: object = "-") -> None:
        # BaseHTTPRequestHandler logs the raw request line, including the
        # ?token= on the initial page load. Log only the path.
        sys.stderr.write(
            f"{self.address_string()} - {urlsplit(self.path).path} {code} {size}\n"
        )

    def _authorized(self) -> bool:
        supplied = self.headers.get(TOKEN_HEADER, "")
        if not supplied:
            query = parse_qs(urlsplit(self.path).query)
            supplied = (query.get(TOKEN_QUERY) or [""])[0]
        return bool(supplied) and secrets.compare_digest(supplied, self.app.token)

    def _send(self, status: int, body: bytes, content_type: str = "application/json; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self._send(status, body)

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _static(self, path: Path, root: Path) -> None:
        try:
            resolved = path.resolve()
            root_resolved = root.resolve()
            if root_resolved not in resolved.parents and resolved != root_resolved:
                self._error(HTTPStatus.NOT_FOUND, "not found")
                return
            if not resolved.is_file():
                self._error(HTTPStatus.NOT_FOUND, "not found")
                return
            body = resolved.read_bytes()
        except OSError:
            self._error(HTTPStatus.NOT_FOUND, "not found")
            return
        content_type = MIME_TYPES.get(resolved.suffix) or mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        self._send(HTTPStatus.OK, body, content_type)

    def do_HEAD(self) -> None:
        self.do_GET()

    def do_GET(self) -> None:
        self.app.touch()
        parsed = urlsplit(self.path)
        route = parsed.path
        if route in {"/", "/index.html"}:
            if not self._authorized():
                self._error(HTTPStatus.FORBIDDEN, "invalid settings token")
                return
            self._static(self.app.web_dir / "index.html", self.app.web_dir)
            return
        if route == "/api/health":
            if not self._authorized():
                self._error(HTTPStatus.FORBIDDEN, "invalid settings token")
                return
            self._json(HTTPStatus.OK, {"ok": True, "version": SERVER_VERSION})
            return
        if route == "/api/state":
            if not self._authorized():
                self._error(HTTPStatus.FORBIDDEN, "invalid settings token")
                return
            self._json(HTTPStatus.OK, self.app.state())
            return
        if route in {"/layout-model.js", "/meter-layout.js"}:
            self._static(self.app.web_dir.parent / route.removeprefix("/"), self.app.web_dir.parent)
            return
        if route.startswith("/icons/"):
            self._static(self.app.icons_dir / route.removeprefix("/icons/"), self.app.icons_dir)
            return
        if route.startswith("/"):
            self._static(self.app.web_dir / route.removeprefix("/"), self.app.web_dir)
            return
        self._error(HTTPStatus.NOT_FOUND, "not found")

    def do_POST(self) -> None:
        self.app.touch()
        if not self._authorized():
            self._error(HTTPStatus.FORBIDDEN, "invalid settings token")
            return
        route = urlsplit(self.path).path
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body is too large")
            return
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid JSON")
            return
        if not isinstance(payload, dict):
            self._error(HTTPStatus.BAD_REQUEST, "JSON body must be an object")
            return
        try:
            if route == "/api/settings":
                key = payload.get("key")
                if not isinstance(key, str):
                    raise ValueError("key is required")
                value = self.app.set_setting(key, payload.get("value"))
                self._json(HTTPStatus.OK, {"key": key, "value": value})
                return
            if route == "/api/layout":
                self.app.set_layout(payload)
                self._json(HTTPStatus.OK, {"ok": True})
                return
            if route == "/api/secret":
                provider = payload.get("provider")
                key = payload.get("key")
                value = payload.get("value", "")
                if not isinstance(provider, str) or not isinstance(key, str) or not isinstance(value, str):
                    raise ValueError("provider, key, and value are required")
                configured = self.app.secrets.set(provider, key, value)
                self._json(HTTPStatus.OK, {"configured": configured})
                return
            if route == "/api/stop":
                self._json(HTTPStatus.OK, {"ok": True})
                self.app.stop()
                return
            self._error(HTTPStatus.NOT_FOUND, "not found")
        except ValueError as error:
            self._error(HTTPStatus.BAD_REQUEST, str(error))
        except Exception as error:  # pragma: no cover - defensive boundary
            sys.stderr.write(f"settings request failed: {error}\n")
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "settings request failed")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--schema-dir", required=True)
    parser.add_argument("--web-dir", required=True)
    parser.add_argument("--icons-dir", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--config-dir", default="")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", default="")
    parser.add_argument("--idle-timeout", type=int, default=1800)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    if GIO_IMPORT_ERROR is not None:
        sys.stderr.write(
            "Agent Quota settings need python3-gi (PyGObject). "
            f"Could not import Gio: {GIO_IMPORT_ERROR}\n"
        )
        return 2
    args = parse_args(argv or sys.argv[1:])
    app = App(args)
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    httpd.app = app  # type: ignore[attr-defined]
    app.httpd = httpd
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/?{TOKEN_QUERY}={app.token}"
    write_private_json(app.info_path, {
        "pid": os.getpid(),
        "port": port,
        "token": app.token,
        "url": url,
        "started_at": int(time.time()),
        "version": SERVER_VERSION,
    })
    app._idle_thread = threading.Thread(target=app.idle_watch, daemon=True)
    app._idle_thread.start()

    def handle_signal(_signum: int, _frame: object) -> None:
        app.stop()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)
    print(url, flush=True)
    try:
        httpd.serve_forever(poll_interval=0.25)
    finally:
        remove_info_file(app.info_path, os.getpid(), app.token)
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
