"""OpenCode Zen balance fetcher.

Fetches current Zen balance from the OpenCode console using browser cookies.

The workspace was migrated to the new console (`/console/...`): the `/auth`
redirect no longer lands on `/workspace/<id>` for migrated workspaces, so
the workspace id is now discovered via `GET /console/api/orgs` and the
balance is read from `GET /console/api/billing/status` (header-scoped with
`x-org-id`). The legacy `/workspace/<id>/billing` scrape is kept as a
fallback for workspaces that were not migrated.
"""

from __future__ import annotations

import argparse
import re
import sys
import time

from curl_cffi import requests

from common import get_cached_or_fetch, load_cookies


# ==================== Configuration ====================

ZEN_DOMAIN = "opencode.ai"
AUTH_URL = "https://opencode.ai/auth"
CONSOLE_API_BASE = f"https://{ZEN_DOMAIN}/console/api"

BASE_HEADERS = {
    "Referer": "https://opencode.ai/",
    "Origin": "https://opencode.ai",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

API_HEADERS = {
    "Referer": "https://opencode.ai/console/",
    "Origin": "https://opencode.ai",
    "Accept": "application/json",
}

CACHE_TTL = 120  # Cache for 120 seconds
REQUEST_TIMEOUT = 25
MAX_REQUEST_ATTEMPTS = 3

# Balance is stored as micro-cents: 1 dollar = 100 cents = 1e8 micro-cents
# (the console's centsToMicroCents() multiplies cents by 1e6).
MICRO_CENTS_PER_DOLLAR = 100_000_000

class _FatalUsageError(RuntimeError):
    """An error that retrying will not fix (e.g. expired cookies)."""


_WORKSPACE_RE = re.compile(r"/workspace/(wrk_[A-Za-z0-9]+)")


# ==================== Core Logic: Get Balance ====================


def _parse_balance_from_html(html_content: str) -> float | None:
    """Parse balance from the billing page HTML.

    The page renders the balance as:
        <span data-slot="balance-value">$<!--$-->17.66<!--/--></span>
    where `<!--$-->` / `<!--/-->` are React server-rendered boundary
    markers. The legacy patterns are kept as a safety net in case the
    template changes again, but the data-slot anchor is the load-bearing
    one — DO NOT replace it with a loose `balance:<number>` regex, which
    matches an unrelated unix-timestamp-shaped field in the inline JS
    state and silently returns wildly wrong numbers.
    """

    # Pattern 1 (current): data-slot="balance-value">$<!--$-->NN.NN<!--/-->
    m = re.search(
        r'data-slot="balance-value">\s*\$\s*(?:<!--\$-->\s*)?'
        r'(-?[0-9]+(?:\.[0-9]+)?)',
        html_content,
    )
    if m:
        return float(m.group(1))

    # Pattern 2: data-slot="balance" with "Current balance" label (legacy)
    m = re.search(
        r'data-slot="balance"[^>]*>.*?Current balance.*?<b>\$\s*<!--\$-->([0-9]+\.[0-9]{2})<!--/-->',
        html_content,
        re.DOTALL,
    )
    if m:
        return float(m.group(1))

    # Pattern 3: bare "Current balance $XX.XX" text (legacy)
    m = re.search(
        r"Current balance\s*\$\s*([0-9]+\.[0-9]{2})",
        html_content,
    )
    if m:
        return float(m.group(1))

    return None


def _resolve_org(cookies: dict) -> str:
    """Read the workspace id from the console API.

    The old discovery (the ``/auth`` redirect to ``/workspace/<id>``) no
    longer works for migrated workspaces: ``/auth`` now redirects to
    ``/console/login`` instead. The console SPA lists the signed-in
    account's workspaces at ``GET /console/api/orgs``, authenticated by
    the ``__Host-console_session`` cookie.
    """
    resp = requests.get(
        f"{CONSOLE_API_BASE}/orgs",
        cookies=cookies,
        headers=API_HEADERS,
        impersonate="chrome",
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code == 403:
        raise _FatalUsageError(
            "403 Forbidden on /console/api/orgs: cookies expired? "
            "Refresh opencode.ai in your browser."
        )
    resp.raise_for_status()
    try:
        orgs = resp.json()
    except ValueError as e:
        raise RuntimeError(f"Could not parse /console/api/orgs response: {e}")
    if isinstance(orgs, list):
        for org in orgs:
            if isinstance(org, dict) and isinstance(org.get("id"), str):
                if org["id"].startswith("wrk_"):
                    return org["id"]
    raise RuntimeError(
        "Could not locate workspace id in /console/api/orgs response. "
        "Open opencode.ai/console in your browser and confirm you are signed in."
    )


def _fetch_balance_from_console(cookies: dict, org_id: str) -> float:
    """Read the balance from ``GET /console/api/billing/status``.

    The response carries ``balanceMicroCents``; 1 dollar = 1e8 micro-cents.
    """
    resp = requests.get(
        f"{CONSOLE_API_BASE}/billing/status",
        cookies=cookies,
        headers={**API_HEADERS, "x-org-id": org_id},
        impersonate="chrome",
        timeout=REQUEST_TIMEOUT,
    )
    if resp.status_code == 403:
        raise _FatalUsageError(
            "403 Forbidden on /console/api/billing/status: cookies expired? "
            "Refresh opencode.ai in your browser."
        )
    resp.raise_for_status()
    try:
        data = resp.json()
    except ValueError as e:
        raise RuntimeError(f"Could not parse /console/api/billing/status response: {e}")
    if not isinstance(data, dict) or data.get("balanceMicroCents") is None:
        raise RuntimeError(
            "Could not find balanceMicroCents in /console/api/billing/status response."
        )
    return int(data["balanceMicroCents"]) / MICRO_CENTS_PER_DOLLAR


def _resolve_workspace(cookies: dict) -> str:
    """Legacy: read the workspace id from ``/auth``'s redirect.

    Only works for workspaces that were not migrated to the new console.
    OpenCode's workspace landing page can respond with HTTP 500 while the
    pages used by this provider remain available, so following the redirect
    would incorrectly discard a valid workspace id.
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
        raise _FatalUsageError(
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


def _fetch_balance_from_legacy_page(cookies: dict) -> float:
    """Legacy: scrape the balance off the /workspace/<id>/billing page."""
    ws_id = _resolve_workspace(cookies)
    resp = requests.get(
        f"https://{ZEN_DOMAIN}/workspace/{ws_id}/billing",
        cookies=cookies,
        headers=BASE_HEADERS,
        impersonate="chrome",
        timeout=REQUEST_TIMEOUT,
        allow_redirects=True,
    )
    if resp.status_code == 403:
        raise _FatalUsageError(
            "403 Forbidden on /billing: cookies expired? Refresh opencode.ai in your browser."
        )
    resp.raise_for_status()
    balance = _parse_balance_from_html(resp.text)
    if balance is None:
        raise RuntimeError(
            "Could not find balance on the billing page. "
            "Open opencode.ai in your browser and confirm the page renders correctly."
        )
    return balance


def _fetch_zen_balance_uncached(browsers: list[str] | None = None) -> dict:
    """Discover the workspace and read the Zen balance.

    Primary path is the console API (`/console/api/orgs` +
    `/console/api/billing/status`); the legacy workspace-page scrape is
    kept as a fallback for workspaces that were never migrated.
    """
    try:
        cookies, _browser = load_cookies(ZEN_DOMAIN, browsers)
    except Exception as e:
        raise RuntimeError(f"Failed to read cookies: {e}")

    last_error = None
    for attempt in range(MAX_REQUEST_ATTEMPTS):
        try:
            try:
                balance = _fetch_balance_from_console(
                    cookies, _resolve_org(cookies)
                )
            except Exception as console_err:
                # Migrated workspaces are served by the console API;
                # anything else (including unmigrated workspaces) falls
                # back to the legacy workspace page.
                try:
                    balance = _fetch_balance_from_legacy_page(cookies)
                except Exception:
                    raise console_err from None

            return {"balance": round(balance, 2), "currency": "USD"}

        except _FatalUsageError:
            raise
        except Exception as e:
            last_error = e
            if attempt < MAX_REQUEST_ATTEMPTS - 1:
                # A fresh connection usually recovers OpenCode's occasional
                # Cloudflare connection timeout without user intervention.
                time.sleep(attempt + 1)

    raise RuntimeError(f"Request failed: {last_error}")


def get_zen_balance(browsers: list[str] | None = None) -> dict:
    """
    Fetch Zen balance using curl_cffi to impersonate Chrome.
    Uses file-based caching to prevent multiple Waybar instances from making
    concurrent API requests.
    """
    return get_cached_or_fetch(
        "zen-balance", lambda: _fetch_zen_balance_uncached(browsers), ttl=CACHE_TTL
    )


# ==================== Output: CLI / Waybar ====================


def print_cli(balance_data: dict) -> None:
    """Print balance to terminal (for debugging)."""
    print(f"Zen Balance: ${balance_data['balance']:.2f} {balance_data['currency']}")


# ==================== CLI Entry Point ====================


def main() -> None:
    parser = argparse.ArgumentParser(description="Print OpenCode Zen balance to terminal.")
    parser.add_argument(
        "--browser",
        action="append",
        help="Browser cookie source to try (repeatable). Example: --browser chromium",
    )
    args = parser.parse_args()

    try:
        balance_data = get_zen_balance(args.browser)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(balance_data)


if __name__ == "__main__":
    main()
