from __future__ import annotations

import argparse
import sys

from curl_cffi import requests

from common import (
    format_eta,
    get_cached_or_fetch,
    load_cookie_candidates,
    parse_window_direct,
)


# ================= Configuration =================

BASE_HEADERS = {
    "Referer": "https://chatgpt.com/",
    "Origin": "https://chatgpt.com",
    "Accept": "*/*"
}

SESSION_URL = "https://chatgpt.com/api/auth/session"
CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
CODEX_IMPERSONATIONS = ("chrome124", "edge", "safari")

# ================= Network Logic =================


def _extract_codex_identity(usage_data: dict, session_data: dict) -> dict:
    account = session_data.get("account") or {}
    user = session_data.get("user") or {}
    team_name = (
        account.get("name")
        or account.get("displayName")
        or account.get("organizationName")
        or account.get("workspaceName")
    )
    return {
        "plan": usage_data.get("plan_type") or account.get("planType"),
        "team_name": team_name or "",
        "organization_id": account.get("organizationId") or "",
        "user_name": user.get("name") or "",
        "account_name": user.get("email") or usage_data.get("email") or "",
        "account_kind": account.get("structure") or "",
    }


def extract_codex_identity(raw: dict) -> dict:
    identity = raw.get("identity")
    merged = dict(identity) if isinstance(identity, dict) else {}
    fresh = _extract_codex_identity(raw, raw.get("_session") or {})
    for key, value in fresh.items():
        if value not in (None, ""):
            merged[key] = value
    return merged


def _fetch_codex_usage_uncached(browsers: list[str] | None = None) -> dict:
    """Internal function to fetch Codex usage data without caching"""
    try:
        cookie_candidates = load_cookie_candidates("chatgpt.com", browsers)
    except Exception as e:
        raise RuntimeError(f"Failed to read browser cookies: {e}")

    # A browser may contain stale ChatGPT cookies while another browser has the
    # active session. Validate each candidate through /api/auth/session before
    # trying the usage endpoint, and retry transient failures once per candidate.
    errors: list[str] = []
    for cookies_dict, browser_name in cookie_candidates:
        last_error = None
        for attempt in range(2):
            for impersonate in CODEX_IMPERSONATIONS:
                session_data = None
                try:
                    # Keep the same connection/cookie jar for the browser
                    # warm-up, session check, and usage request. Cloudflare
                    # can issue a challenge cookie on the first request.
                    http = requests.Session(impersonate=impersonate)
                    http.cookies.update(cookies_dict)
                    http.get(
                        "https://chatgpt.com/",
                        headers=BASE_HEADERS,
                        timeout=10,
                    )
                    session_resp = http.get(
                        SESSION_URL,
                        headers=BASE_HEADERS,
                        timeout=10,
                    )

                    if session_resp.status_code == 403:
                        raise RuntimeError(
                            f"403 Forbidden from ChatGPT session endpoint ({impersonate})"
                        )

                    session_resp.raise_for_status()
                    session_data = session_resp.json()
                    access_token = session_data.get("accessToken")
                    if not access_token:
                        raise RuntimeError("ChatGPT session has no accessToken")

                    usage_headers = BASE_HEADERS.copy()
                    usage_headers["Authorization"] = f"Bearer {access_token}"
                    usage_resp = http.get(
                        CODEX_USAGE_URL,
                        headers=usage_headers,
                        timeout=10,
                    )
                    usage_resp.raise_for_status()
                    usage_data = usage_resp.json()
                    if isinstance(usage_data, dict):
                        # Keep the access token in memory only.
                        usage_data["identity"] = _extract_codex_identity(
                            usage_data, session_data
                        )
                        usage_data["source"] = browser_name
                    return usage_data
                except Exception as e:
                    last_error = e
        errors.append(f"{browser_name}: {last_error}")

    if errors:
        raise RuntimeError("Codex authentication failed; " + "; ".join(errors))
    raise RuntimeError("Codex authentication failed: no cookie candidates")


def get_codex_usage(browsers: list[str] | None = None) -> dict:
    """
    Fetch ChatGPT Codex usage data.

    Uses file-based caching to prevent multiple Waybar instances (one per monitor)
    from making concurrent API requests that might be rate-limited.
    """
    data = get_cached_or_fetch("codex", lambda: _fetch_codex_usage_uncached(browsers))
    identity = extract_codex_identity(data) if isinstance(data, dict) else {}
    if isinstance(data, dict) and (not identity.get("plan") or not data.get("source")):
        # Refresh immediately when a pre-identity or pre-plan cache entry is still fresh.
        data = get_cached_or_fetch(
            "codex", lambda: _fetch_codex_usage_uncached(browsers), ttl=0
        )
    return data


# ================= Output: CLI =================


def print_cli(usage: dict) -> None:
    rate = usage.get("rate_limit") or {}
    # 18000s and 604800s per the payload's limit_window_seconds.
    p = parse_window_direct(rate.get("primary_window"))
    s = parse_window_direct(rate.get("secondary_window"))
    identity = extract_codex_identity(usage)

    print(f"Plan              : {identity.get('plan') or 'Unknown'}")
    if identity.get("team_name"):
        print(f"Team              : {identity['team_name']}")
    print(
        f"User              : "
        f"{identity.get('user_name') or identity.get('account_name') or 'Unknown'}"
    )
    print(f"5h                : {p.utilization:>5.1f}% | Reset in {format_eta(p.resets_at)}")
    print(f"Weekly            : {s.utilization:>5.1f}% | Reset in {format_eta(s.resets_at)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Print ChatGPT Codex usage to terminal.")
    parser.add_argument(
        "--browser",
        action="append",
        help="Browser cookie source to try (repeatable). Example: --browser chromium",
    )
    args = parser.parse_args()

    try:
        usage = get_codex_usage(args.browser)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(usage)


if __name__ == "__main__":
    main()
