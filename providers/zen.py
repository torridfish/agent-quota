"""OpenCode Zen balance fetcher.

Fetches current Zen balance from the OpenCode dashboard using browser cookies.
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

BASE_HEADERS = {
    "Referer": "https://opencode.ai/",
    "Origin": "https://opencode.ai",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

CACHE_TTL = 120  # Cache for 120 seconds
REQUEST_TIMEOUT = 25
MAX_REQUEST_ATTEMPTS = 3

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


def _resolve_workspace(cookies: dict) -> str:
    """Read the workspace id from ``/auth``'s redirect without visiting it.

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


def _fetch_zen_balance_uncached(browsers: list[str] | None = None) -> dict:
    """Auto-discover the workspace, then scrape balance off /billing."""
    try:
        cookies, _browser = load_cookies(ZEN_DOMAIN, browsers)
    except Exception as e:
        raise RuntimeError(f"Failed to read cookies: {e}")

    last_error = None
    for attempt in range(MAX_REQUEST_ATTEMPTS):
        try:
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
                raise RuntimeError(
                    "403 Forbidden on /billing: cookies expired? Refresh opencode.ai in your browser."
                )

            resp.raise_for_status()

            balance = _parse_balance_from_html(resp.text)

            if balance is not None:
                return {"balance": balance, "currency": "USD"}
            raise RuntimeError(
                "Could not find balance on the billing page. "
                "Open opencode.ai in your browser and confirm the page renders correctly."
            )

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
