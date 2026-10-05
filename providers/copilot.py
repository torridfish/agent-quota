from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

from curl_cffi import requests

from common import format_eta, get_cached_or_fetch, load_cookies


# ==================== Configuration ====================

CONFIG_PATH = Path("~/.config/agent-quota/copilot.conf").expanduser()
DEFAULT_QUOTA = 300
GITHUB_API_BASE = "https://api.github.com"
COPILOT_FEATURES_URL = "https://github.com/settings/copilot/features"
COPILOT_INDIVIDUAL_API_MARKER = "https://api.individual.githubcopilot.com"


def load_copilot_config(config_path: Path | None = None) -> dict:
    """Load Copilot config from file. Returns dict with GITHUB_TOKEN and COPILOT_QUOTA."""
    path = config_path or CONFIG_PATH
    config: dict = {"GITHUB_TOKEN": None, "COPILOT_QUOTA": DEFAULT_QUOTA}

    if not path.exists():
        return config

    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip()
            if key == "GITHUB_TOKEN":
                config["GITHUB_TOKEN"] = value
            elif key == "COPILOT_QUOTA":
                try:
                    config["COPILOT_QUOTA"] = int(value)
                except ValueError:
                    pass

    return config


# ==================== Core Logic: Get Usage ====================

class CopilotHTTPError(RuntimeError):
    """Raised for HTTP errors from the GitHub API, carrying the numeric status code."""
    def __init__(self, code: int, body: str) -> None:
        super().__init__(f"HTTP {code}: {body}")
        self.code = code


def _github_get(url: str, token: str) -> dict | list:
    """Make authenticated GET request to GitHub API."""
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "agent-quota/copilot",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise CopilotHTTPError(e.code, body) from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}") from e


def _get_github_username(token: str) -> str:
    """Fetch and cache the authenticated GitHub username (TTL: 1 hour)."""
    data = get_cached_or_fetch(
        "copilot_user",
        lambda: _github_get(f"{GITHUB_API_BASE}/user", token),
        ttl=3600,
    )
    username = data.get("login") if isinstance(data, dict) else None
    if not username:
        raise RuntimeError("Could not determine GitHub username from /user endpoint")
    return username


def _extract_copilot_identity(raw: dict) -> dict:
    identity = raw.get("identity")
    return dict(identity) if isinstance(identity, dict) else {}


def _fetch_copilot_usage_uncached(token: str) -> dict:
    """Fetch Copilot premium request usage from GitHub API (not cached)."""
    username = _get_github_username(token)
    url = f"{GITHUB_API_BASE}/users/{username}/settings/billing/premium_request/usage"
    usage_data = _github_get(url, token)

    # Response may be a list directly or a dict with usageItems
    if isinstance(usage_data, list):
        usage_items = usage_data
    else:
        usage_items = usage_data.get("usageItems", [])

    used = sum(item.get("grossQuantity", 0) for item in usage_items)
    return {
        "used": round(used, 1),
        "raw": usage_data,
        "identity": {
            "user_name": username,
            "source": "token",
        },
    }


def _fetch_copilot_usage_from_browser(browsers=None) -> dict:
    """Fetch Copilot usage percentage from the authenticated Copilot settings page.

    This is a fallback for organization-managed Copilot accounts, where the
    user billing API does not expose premium request usage. The page itself
    renders a usage percentage for the currently signed-in account.
    """
    cookies, browser_name = load_cookies("github.com", browsers)

    response = requests.get(
        COPILOT_FEATURES_URL,
        cookies=cookies,
        impersonate="chrome",
        timeout=20,
        allow_redirects=True,
    )
    if response.status_code != 200:
        raise RuntimeError(f"{browser_name}: HTTP {response.status_code}")

    html = response.text
    # GitHub redesigned the copilot features page: the old
    # id="copilot-overages-usage" section is gone. The usage now lives under
    # an "Included credits" heading followed by a "N / M AI credits" text and
    # a progress bar whose width style carries the percentage.
    included_match = re.search(r">Included\s+(?:credits|usage)<", html, re.IGNORECASE)
    included_idx = included_match.start() if included_match else -1
    if included_idx < 0:
        raise RuntimeError(f"{browser_name}: no copilot usage section found")

    # Window the section up to the next sibling ("Additional usage") so the
    # regex can't accidentally match the overage-budget's "$0.00 / $0 budget".
    section = html[included_idx : included_idx + 6000]
    credits_match = re.search(
        r"(\d+)\s*/\s*(\d+)\s*AI\s+credits",
        section,
    )
    if not credits_match:
        raise RuntimeError(f"{browser_name}: no AI credits usage found")

    used = int(credits_match.group(1))
    total = int(credits_match.group(2))
    pct = (used / total * 100) if total > 0 else 0.0

    managed_by = re.search(
        r'Managed by\s*<a[^>]+href="([^"]+)"[^>]*>([^<]+)</a>',
        html,
    )
    user_login = re.search(r'name="user-login"\s+content="([^"]+)"', html)
    is_individual = COPILOT_INDIVIDUAL_API_MARKER in html
    return {
        "pct": pct,
        "used": used,
        "total": total,
        "raw": {
            "managed_by_name": managed_by.group(2) if managed_by else None,
            "managed_by_href": managed_by.group(1) if managed_by else None,
        },
        "identity": {
            "plan": "team" if managed_by else ("individual" if is_individual else ""),
            "team_name": managed_by.group(2) if managed_by else "",
            "team_href": managed_by.group(1) if managed_by else "",
            "user_name": user_login.group(1) if user_login else "",
            "source": "browser",
        },
        "source": f"{browser_name}:copilot-features",
    }


def _should_fallback_to_browser(error: Exception) -> bool:
    """Only fall back for user billing API responses that are expected for org-managed Copilot."""
    return isinstance(error, CopilotHTTPError) and error.code in (400, 403, 404)


def _browser_cache_name(browsers: list[str] | None) -> str:
    """Cache key for the browser fallback, scoped to the browser preference.

    Different browsers can hold different GitHub accounts; without scoping,
    switching --browser could keep serving the previous account's cached
    page for the cache TTL.
    """
    if browsers:
        return "copilot_browser:" + ",".join(browsers)
    return "copilot_browser"


def get_copilot_usage(token: str | None, browsers: list[str] | None = None) -> dict:
    """Fetch Copilot usage with file-based caching (TTL: 60 seconds)."""
    browser_cache = _browser_cache_name(browsers)

    def fetch_browser() -> dict:
        return get_cached_or_fetch(
            browser_cache, lambda: _fetch_copilot_usage_from_browser(browsers)
        )

    if not token:
        data = fetch_browser()
        if isinstance(data, dict) and not _extract_copilot_identity(data):
            data = get_cached_or_fetch(
                browser_cache, lambda: _fetch_copilot_usage_from_browser(browsers), ttl=0
            )
        return data

    try:
        data = get_cached_or_fetch("copilot", lambda: _fetch_copilot_usage_uncached(token))
    except Exception as exc:
        if not _should_fallback_to_browser(exc):
            raise
        data = fetch_browser()
    if isinstance(data, dict) and not _extract_copilot_identity(data):
        cache_name = "copilot" if token and data.get("used") is not None else browser_cache
        data = get_cached_or_fetch(
            cache_name,
            (lambda: _fetch_copilot_usage_uncached(token))
            if token
            else (lambda: _fetch_copilot_usage_from_browser(browsers)),
            ttl=0,
        )
    return data


# ==================== Output: CLI ====================

def _next_month_reset_iso() -> str:
    """Return ISO timestamp for 00:00 UTC on the 1st of next month."""
    now = datetime.now(timezone.utc)
    if now.month == 12:
        reset = datetime(now.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        reset = datetime(now.year, now.month + 1, 1, tzinfo=timezone.utc)
    return reset.isoformat()


def print_cli(usage: dict, quota: int) -> None:
    """Print usage to terminal (for debugging)."""
    used = float(usage.get("used") or 0)
    pct_from_usage = usage.get("pct")
    if pct_from_usage is not None:
        used = round(quota * float(pct_from_usage) / 100, 1)
    pct = round(used / quota * 100) if quota > 0 else 0
    reset_str = format_eta(_next_month_reset_iso())
    identity = _extract_copilot_identity(usage)
    print(f"GitHub Copilot Premium Requests")
    print("-" * 40)
    if identity.get("plan"):
        print(f"Plan : {identity['plan']}")
    if identity.get("team_name"):
        print(f"Team : {identity['team_name']}")
    if identity.get("user_name"):
        print(f"User : {identity['user_name']}")
    print(f"Remaining : {max(0, quota - used)} / {quota} ({max(0, 100 - pct)}%)")
    print(f"Reset: {reset_str} (next month, 1st at 00:00 UTC)")


# ==================== CLI Entry Point ====================

def main() -> None:
    parser = argparse.ArgumentParser(description="Print GitHub Copilot premium request usage to terminal.")
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"Path to copilot config file (default: {CONFIG_PATH})",
    )
    args = parser.parse_args()

    config = load_copilot_config(args.config)
    token = config["GITHUB_TOKEN"]
    quota = config["COPILOT_QUOTA"]

    try:
        usage = get_copilot_usage(token)
    except Exception as e:
        if not token:
            print(f"[!] No GITHUB_TOKEN in {args.config}", file=sys.stderr)
            print("    For personal Copilot, create a fine-grained PAT with 'Plan (read)' permission.", file=sys.stderr)
            print("    For organization-managed Copilot, log into GitHub in any browser and check:", file=sys.stderr)
            print(f"    {COPILOT_FEATURES_URL}", file=sys.stderr)
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(usage, quota)


if __name__ == "__main__":
    main()
