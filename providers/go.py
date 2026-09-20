"""OpenCode Go usage fetcher.

Uses the official ``GET /zen/go/v1/usage`` JSON API, authenticated with the
``opencode-go`` API key that ``opencode auth login`` stores in
``~/.local/share/opencode/auth.json``.

This replaces the earlier scraper of the /workspace/<id>/go page's inline
JS state, which broke when the console UI was redesigned: the ``/auth``
redirect no longer yields a workspace id (it lands on ``/console/login``)
and the page markup no longer carries the scraped ``rollingUsage``-style
objects.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from curl_cffi import requests

from common import format_eta, get_cached_or_fetch


GO_DOMAIN = "opencode.ai"
USAGE_URL = f"https://{GO_DOMAIN}/zen/go/v1/usage"

BASE_HEADERS = {
    "Referer": "https://opencode.ai/",
    "Origin": "https://opencode.ai",
}

CACHE_TTL = 120
REQUEST_TIMEOUT = 25
MAX_REQUEST_ATTEMPTS = 3

# auth.json keys tried in order; "opencode" holds the same key value but
# "opencode-go" is the canonical name for Go plan credentials.
_AUTH_ENTRIES = ("opencode-go", "opencode")


class _FatalUsageError(RuntimeError):
    """Error that retries cannot fix (bad key, missing subscription)."""


def _auth_file_paths() -> list[Path]:
    """Candidate ``auth.json`` locations, XDG-aware, most specific first."""
    paths: list[Path] = []
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        paths.append(Path(xdg) / "opencode" / "auth.json")
    paths.append(Path.home() / ".local" / "share" / "opencode" / "auth.json")
    unique: list[Path] = []
    for path in paths:
        if path not in unique:
            unique.append(path)
    return unique


def _load_api_key() -> str:
    """Read the Go API key written by ``opencode auth login``."""
    for path in _auth_file_paths():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, ValueError) as e:
            raise RuntimeError(f"Could not read {path}: {e}")
        if not isinstance(data, dict):
            continue
        for name in _AUTH_ENTRIES:
            entry = data.get(name)
            if isinstance(entry, dict):
                key = entry.get("key")
                if isinstance(key, str) and key.strip():
                    return key.strip()
    searched = ", ".join(str(p) for p in _auth_file_paths())
    raise _FatalUsageError(
        "No OpenCode API key found (searched: "
        f"{searched}). Run `opencode auth login` first."
    )


def _parse_resets_at(raw: object) -> int | None:
    """Convert an ISO-8601 UTC timestamp (``2026-09-20T22:38:07.373Z``)
    into unix seconds."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _parse_usage_payload(payload: object) -> dict[str, dict]:
    """Extract the rolling/weekly/monthly windows from the API payload.

    Expected shape::

        {"usage": {"rolling":    {"status", "percent", "resetsAt"},
                   "weekly":     {...},
                   "monthly":    {...}}}
    """
    usage = payload.get("usage") if isinstance(payload, dict) else None
    if not isinstance(usage, dict):
        return {}
    windows: dict[str, dict] = {}
    for key, raw in usage.items():
        if not isinstance(raw, dict):
            continue
        percent = raw.get("percent")
        if percent is None:
            continue
        windows[str(key)] = {
            "status": str(raw.get("status", "ok")),
            "usage_percent": percent,
            "reset_at": _parse_resets_at(raw.get("resetsAt")),
        }
    return windows


def _api_identity() -> dict:
    # The usage endpoint does not expose workspace/team details; the plan
    # label is all the CLI needs (agent_quota defaults to "Go" anyway).
    return {
        "plan": "Go",
        "team_name": "",
        "organization_id": "",
        "user_name": "",
        "account_name": "",
        "source": "official_api",
    }


def _fetch_go_usage_uncached() -> dict:
    api_key = _load_api_key()
    headers = {
        **BASE_HEADERS,
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }

    last_error: Exception | None = None
    for attempt in range(MAX_REQUEST_ATTEMPTS):
        try:
            resp = requests.get(
                USAGE_URL,
                headers=headers,
                impersonate="chrome",
                timeout=REQUEST_TIMEOUT,
            )
            if resp.status_code == 401:
                raise _FatalUsageError(
                    "401 Unauthorized on /zen/go/v1/usage: API key rejected. "
                    "Run `opencode auth login` to refresh it."
                )
            if resp.status_code == 403:
                raise _FatalUsageError(
                    "403 Forbidden on /zen/go/v1/usage: this key has no active "
                    "OpenCode Go subscription."
                )
            resp.raise_for_status()

            windows = _parse_usage_payload(resp.json())
            if not windows:
                raise RuntimeError(
                    "Could not parse usage windows from /zen/go/v1/usage."
                )
            fetched_at = time.time()
            for window in windows.values():
                reset_at = window.get("reset_at")
                if reset_at:
                    window["reset_in_sec"] = max(0, int(reset_at - fetched_at))
            return {"workspace": "", "windows": windows, "identity": _api_identity()}
        except _FatalUsageError:
            raise
        except Exception as e:
            last_error = e
            if attempt < MAX_REQUEST_ATTEMPTS - 1:
                # OpenCode is occasionally slow to establish its Cloudflare
                # connection. Give a transient timeout a fresh connection
                # instead of immediately surfacing it in the GNOME menu.
                time.sleep(attempt + 1)

    raise RuntimeError(f"Request failed: {last_error}")


def get_go_usage(browsers: list[str] | None = None) -> dict:
    # ``browsers`` is accepted for call-site compatibility with the old
    # cookie-based scraper; the official API does not use browser cookies.
    return get_cached_or_fetch("go", _fetch_go_usage_uncached, ttl=CACHE_TTL)


def _go_window_label(key: str) -> str:
    known = {
        "rolling": "5h",
        "weekly": "Weekly",
        "monthly": "Monthly",
        # Legacy inline-state keys, kept so pre-existing cache entries
        # written by the old scraper still render until they expire.
        "rollingUsage": "5h",
        "weeklyUsage": "Weekly",
        "monthlyUsage": "Monthly",
    }
    if key in known:
        return known[key]
    name = key.removesuffix("Usage")
    return re.sub(r"(?<!^)([A-Z])", r" \1", name).title()


def go_usage_windows(usage: dict) -> list[tuple[str, dict]]:
    """Return all parsed Go usage windows, not only the original three."""
    windows = usage.get("windows") if isinstance(usage, dict) else None
    if not isinstance(windows, dict):
        return []
    return [
        (_go_window_label(key), window)
        for key, window in windows.items()
        if isinstance(window, dict) and "usage_percent" in window
    ]


def print_cli(usage: dict) -> None:
    identity = usage.get("identity") if isinstance(usage, dict) else None
    if isinstance(identity, dict):
        plan = identity.get("plan") or "Unknown"
        team = identity.get("team_name")
        user = identity.get("user_name") or identity.get("account_name") or "Unknown"
        print(f"Plan              : {plan}")
        if team:
            print(f"Team              : {team}")
        print(f"User              : {user}")

    for label, w in go_usage_windows(usage):
        reset = format_eta(time.time() + w["reset_in_sec"]) if w["reset_in_sec"] else "—"
        status = "" if w["status"] == "ok" else f" [{w['status']}]"
        remaining = max(0.0, 100.0 - float(w["usage_percent"]))
        print(f"{label:<8} : {round(remaining):>3}% remaining{status}  (Reset in {reset})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Print OpenCode Go usage to terminal.")
    parser.add_argument(
        "--browser",
        action="append",
        help="Accepted for compatibility; usage now comes from the official "
        "API and browser cookies are no longer used.",
    )
    args = parser.parse_args()

    try:
        usage = get_go_usage(args.browser)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(usage)


if __name__ == "__main__":
    main()
