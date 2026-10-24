#!/usr/bin/env python3
"""Local settings server for the Agent Quota GNOME extension.

The GNOME preferences window is only a launcher.  This process serves the
web-settings SPA on 127.0.0.1 and bridges it to the extension's GSettings
schema.  Secrets are write-only: the API can report whether a credential is
configured, but it never returns the value.

Settings are mirrored into the [gnome] table of the agent-quota config.toml,
which is the portable source of truth: the table is pushed into GSettings
when the server starts, and GSettings are written back into it on every
save.  The extension itself keeps reading GSettings.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import secrets
import signal
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import config_toml


class SettingsError(RuntimeError):
    """A write that could not be persisted, surfaced to the settings page."""

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
MAX_BODY_BYTES = 1024 * 1024
MAX_LAYOUT_BYTES = 100 * 1024
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

    def set(self, key: str, value: object) -> object:
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
        self.settings.set_value(key, GLib.Variant(expected, value))
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
        self.directory.mkdir(parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        path = self._file(provider_id)
        try:
            contents = path.read_text()
        except OSError:
            contents = "# Managed by Agent Quota GNOME extension\n"
        updated = upsert_assignment(contents, key, value)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(descriptor, "w") as handle:
                handle.write(updated)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
            os.chmod(path, 0o600)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
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


def write_private_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w") as handle:
            json.dump(payload, handle, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def apply_gnome_section(backend, path: Path) -> str | None:
    """Push the config.toml [gnome] table into GSettings.

    config.toml is the source of truth, so values found there override the
    current dconf state.  Returns an error message when the file cannot be used;
    the caller keeps it as is in that case.  Values the schema rejects are left
    in the file untouched and reported, and keys missing from the table are
    topped up so the file describes the whole schema.
    """
    try:
        document = config_toml.load(path)
    except config_toml.ConfigError as error:
        return str(error)
    table = document.get("gnome")
    table = dict(table) if isinstance(table, dict) else {}
    for key, value in list(table.items()):
        if key not in backend.keys:
            sys.stderr.write(f"ignoring unknown setting {key!r} in {path}\n")
            continue
        try:
            backend.set(key, value)
        except ValueError as error:
            # Keep the file's value: dropping it would silently lose data.
            sys.stderr.write(f"keeping {key!r} as written: {error}\n")
            continue
        table[key] = backend.get(key)
    missing = sorted(backend.keys - set(table))
    if not missing:
        return None
    for key in missing:
        table[key] = backend.get(key)
    try:
        config_toml.replace_tables(path, {"gnome": table})
    except config_toml.ConfigError as error:
        return str(error)
    return None


def persist_gnome_section(backend, path: Path) -> None:
    """Mirror the current GSettings into config.toml's [gnome] table."""
    try:
        config_toml.replace_tables(path, {"gnome": backend.all()})
    except config_toml.ConfigError as error:
        raise SettingsError(
            f"saved in dconf, but {path} could not be updated: {error}"
        ) from error


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
        self.config_error: str | None = None
        self._apply_cli_config()

    def _apply_cli_config(self) -> None:
        self.config_error = apply_gnome_section(self.backend, self.cli_config_path)
        if self.config_error is not None:
            sys.stderr.write(f"agent-quota: {self.config_error}\n")

    def _persist_cli_config(self) -> None:
        persist_gnome_section(self.backend, self.cli_config_path)

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    def state(self) -> dict[str, object]:
        values = self.backend.all()
        return {
            "version": SERVER_VERSION,
            "configPath": str(self.cli_config_path),
            "configError": self.config_error,
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
        }

    def set_setting(self, key: str, value: object) -> object:
        if key in {"popup-layout", "metric-options", "codex-workspace-options"}:
            raise ValueError(f"{key} cannot be changed through this endpoint")
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
        for key, (lower, upper) in allowed.items():
            if key not in settings:
                continue
            value = settings[key]
            if isinstance(value, bool) or not isinstance(value, int) or not lower <= value <= upper:
                raise ValueError(f"{key} is out of range")
        self.backend.set("popup-layout", raw)
        for key, (lower, upper) in allowed.items():
            if key in settings:
                self.backend.set(key, settings[key])
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
        except SettingsError as error:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, str(error))
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
        try:
            app.info_path.unlink()
        except FileNotFoundError:
            pass
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
