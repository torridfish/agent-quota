"""OpenCode Go usage fetcher.

Scrapes the inline JS state on the workspace's /go page to surface the
rolling, weekly, and monthly usage windows. The workspace ID is
auto-discovered by following the /auth redirect, so no per-user config
is needed.
"""

from __future__ import annotations

import argparse
import re
import sys
import time

from curl_cffi import requests

from common import format_eta, get_cached_or_fetch, load_cookies


GO_DOMAIN = "opencode.ai"
AUTH_URL = "https://opencode.ai/auth"

BASE_HEADERS = {
    "Referer": "https://opencode.ai/",
    "Origin": "https://opencode.ai",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

CACHE_TTL = 120
REQUEST_TIMEOUT = 25
MAX_REQUEST_ATTEMPTS = 3

_WORKSPACE_RE = re.compile(r"/workspace/(wrk_[A-Za-z0-9]+)")
_WINDOW_OBJECT_RE = re.compile(
    r"(?P<name>[A-Za-z_$][A-Za-z0-9_$]*Usage)\s*:\s*"
    r"(?:\{\s*)?(?:\$R\[\d+\]\s*=\s*)?\{(?P<body>[^{}]*)\}"
)


def _find_nested_value(raw: object, keys: set[str]) -> object | None:
    if isinstance(raw, dict):
        for key, value in raw.items():
            if str(key).lower() in keys and value not in (None, ""):
                return value
        for value in raw.values():
            found = _find_nested_value(value, keys)
            if found not in (None, ""):
                return found
    elif isinstance(raw, list):
        for item in raw:
            found = _find_nested_value(item, keys)
            if found not in (None, ""):
                return found
    return None


def _iter_dicts(raw: object):
    # Legacy helper kept for future parsing needs.
    if isinstance(raw, dict):
        yield raw
        for v in raw.values():
            yield from _iter_dicts(v)
    elif isinstance(raw, list):
        for item in raw:
            yield from _iter_dicts(item)


def _extract_go_identity_from_html(html: str, workspace_id: str) -> dict:
    # OpenCode pages embed a lightweight inline state (not __NEXT_DATA__).
    # Workspace name is available in a `workspaces[]` object.
    team_name = ""
    m = re.search(
        rf'\{{\s*id:\s*"{re.escape(workspace_id)}"\s*,\s*name:\s*"([^"]+)"',
        html,
    )
    if m:
        team_name = m.group(1).strip()

    # User email is keyed by workspace id, but the resolved value is written
    # later via $R[...] calls. Capture any email close to the key.
    account_name = ""
    key_idx = html.find(f'userEmail[\\"{workspace_id}\\"]')
    if key_idx != -1:
        snippet = html[key_idx : key_idx + 2400]
        m2 = re.search(
            r'([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})',
            snippet,
        )
        if m2:
            account_name = m2.group(1)

    return {
        "plan": "",
        "team_name": team_name,
        "organization_id": workspace_id,
        "user_name": "",
        "account_name": account_name,
        "source": "inline_state",
    }


def _resolve_workspace(cookies: dict) -> str:
    """Read the workspace id from ``/auth``'s redirect without visiting it.

    OpenCode currently returns HTTP 500 for the workspace landing page, even
    though its ``/go`` and ``/billing`` child pages work.  Following the
    redirect therefore turns a successful authentication response into an
    apparent failure.
    """
    resp = requests.get(
        AUTH_URL,
        cookies=cookies,
        headers=BASE_HEADERS,
        impersonate="chrome",
        timeout=REQUEST_TIMEOUT,
        allow_redirects=False,
    )
    if resp.status_code == 403:
        raise RuntimeError(
            "403 Forbidden on /auth: cookies expired? Refresh opencode.ai in your browser."
        )
    resp.raise_for_status()
    location = resp.headers.get("Location", "")
    m = _WORKSPACE_RE.search(location)
    if not m:
        raise RuntimeError(
            f"Could not locate workspace id in /auth redirect: {location or resp.url}"
        )
    return m.group(1)


def _parse_window(html: str, name: str) -> dict | None:
    """Pull a single window object out of the inline JS state.

    Tolerant of field order and the optional `$R[N]=` Next.js bookkeeping
    prefix that wraps the literal in some builds. The strict colon-to-brace
    matcher matters: keys like `monthlyUsage` also appear as plain integers
    elsewhere in the state, and a lazy matcher would latch onto the wrong
    `{...}` block.
    """
    obj = re.search(
        rf"{name}\s*:\s*(?:\$R\[\d+\]\s*=\s*)?\{{([^}}]*)\}}",
        html,
    )
    if not obj:
        return None
    body = obj.group(1)
    status = re.search(r'status:"([^"]+)"', body)
    reset = re.search(r"resetInSec:(\d+)", body)
    pct = re.search(r"usagePercent:(\d+)", body)
    if not (status and reset and pct):
        return None
    return {
        "status": status.group(1),
        "reset_in_sec": int(reset.group(1)),
        "usage_percent": int(pct.group(1)),
    }


def _parse_windows(html: str) -> dict[str, dict]:
    """Extract every usage window from OpenCode Go's inline page state."""
    windows: dict[str, dict] = {}
    for match in _WINDOW_OBJECT_RE.finditer(html):
        name = match.group("name")
        parsed = _parse_window(f"{name}:{{{match.group('body')}}}", name)
        if parsed:
            windows[name] = parsed
    return windows


def _go_window_label(key: str) -> str:
    known = {
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


def _fetch_go_usage_uncached(browsers: list[str] | None = None) -> dict:
    try:
        cookies, _browser = load_cookies(GO_DOMAIN, browsers)
    except Exception as e:
        raise RuntimeError(f"Failed to read cookies: {e}")

    last_error = None
    for attempt in range(MAX_REQUEST_ATTEMPTS):
        try:
            ws_id = _resolve_workspace(cookies)
            resp = requests.get(
                f"https://{GO_DOMAIN}/workspace/{ws_id}/go",
                cookies=cookies,
                headers=BASE_HEADERS,
                impersonate="chrome",
                timeout=REQUEST_TIMEOUT,
                allow_redirects=True,
            )
            if resp.status_code == 403:
                raise RuntimeError(
                    "403 Forbidden on /go: cookies expired? Refresh opencode.ai in your browser."
                )
            resp.raise_for_status()

            windows = _parse_windows(resp.text)
            if not windows:
                raise RuntimeError(
                    "Could not parse usage windows on /go. "
                    "Is OpenCode Go enabled for this workspace?"
                )
            fetched_at = time.time()
            for window in windows.values():
                reset_in_sec = window.get("reset_in_sec")
                if reset_in_sec:
                    window["reset_at"] = int(fetched_at + reset_in_sec)
            identity = _extract_go_identity_from_html(resp.text, ws_id)
            return {"workspace": ws_id, "windows": windows, "identity": identity}
        except Exception as e:
            last_error = e
            if attempt < MAX_REQUEST_ATTEMPTS - 1:
                # OpenCode is occasionally slow to establish its Cloudflare
                # connection. Give a transient timeout a fresh connection
                # instead of immediately surfacing it in the GNOME menu.
                time.sleep(attempt + 1)

    raise RuntimeError(f"Request failed: {last_error}")


def get_go_usage(browsers: list[str] | None = None) -> dict:
    data = get_cached_or_fetch(
        "go", lambda: _fetch_go_usage_uncached(browsers), ttl=CACHE_TTL
    )
    if isinstance(data, dict) and not isinstance(data.get("identity"), dict):
        # Refresh immediately when a pre-identity cache entry is still fresh.
        data = get_cached_or_fetch(
            "go", lambda: _fetch_go_usage_uncached(browsers), ttl=0
        )
    return data


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
        remaining = max(0, 100 - w["usage_percent"])
        print(f"{label:<8} : {remaining:>3}% remaining{status}  (Reset in {reset})")


def main() -> None:
    parser = argparse.ArgumentParser(description="Print OpenCode Go usage to terminal.")
    parser.add_argument(
        "--browser",
        action="append",
        help="Browser cookie source to try (repeatable). Example: --browser chromium",
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
