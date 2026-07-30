from __future__ import annotations

import argparse
import sys
from collections.abc import Mapping

from curl_cffi import requests

from common import (
    format_eta,
    get_cached_or_fetch,
    load_cookie_candidates,
    parse_window_percent,
)


# ==================== Configuration ====================

CLAUDE_DOMAIN = "claude.ai"
ORGANIZATIONS_URL = f"https://{CLAUDE_DOMAIN}/api/organizations"
ACCOUNT_URL = f"https://{CLAUDE_DOMAIN}/api/account"

BASE_HEADERS = {
    "Referer": "https://claude.ai/chats",
    "Origin": "https://claude.ai",
    "Accept": "application/json, text/plain, */*",
}
CLAUDE_IMPERSONATIONS = ("chrome124", "edge", "safari")


# ==================== Core Logic: Get Usage ====================


def _claude_limit_label(limit: Mapping[str, object], fallback: str) -> str:
    """Create a stable, readable label from Claude's limit metadata."""
    kind = str(limit.get("kind") or "")
    labels = {
        "session": "5h",
        "weekly_all": "7d",
    }
    if kind in labels:
        return labels[kind]

    group = str(limit.get("group") or "")
    scope = limit.get("scope")
    model = ""
    if isinstance(scope, Mapping):
        model_info = scope.get("model")
        if isinstance(model_info, Mapping):
            model = str(model_info.get("display_name") or model_info.get("id") or "")
    if group == "weekly" and model:
        return f"7d {model}"
    if group == "weekly":
        return "7d"
    return fallback.replace("_", " ").title()


def claude_limit_windows(
    usage: Mapping[str, object],
) -> list[tuple[str, Mapping[str, object]]]:
    """Return every usage bar supplied by Claude, including future limit types."""
    limits = usage.get("limits")
    candidates: list[tuple[str, Mapping[str, object]]] = []
    if isinstance(limits, list):
        for item in limits:
            if not isinstance(item, Mapping):
                continue
            if "percent" not in item and "utilization" not in item:
                continue
            candidates.append((_claude_limit_label(item, str(item.get("kind") or "Limit")), item))

    # Old API/cache entries did not include ``limits``. Keep them usable while
    # only emitting windows that really exist in the payload.
    if not candidates:
        legacy_labels = {"five_hour": "5h", "seven_day": "7d"}
        for key, value in usage.items():
            if not isinstance(value, Mapping) or "utilization" not in value:
                continue
            if key in legacy_labels:
                label = legacy_labels[key]
            elif key.startswith("seven_day_"):
                label = f"7d {key.removeprefix('seven_day_').replace('_', ' ').title()}"
            else:
                continue
            candidates.append((label, value))

    labels: dict[str, int] = {}
    windows: list[tuple[str, Mapping[str, object]]] = []
    for label, limit in candidates:
        labels[label] = labels.get(label, 0) + 1
        unique_label = label if labels[label] == 1 else f"{label} {labels[label]}"
        windows.append((unique_label, limit))
    return windows


def _select_claude_org(
    organizations_data: object, org_id: str | None, account_data: dict | None = None
) -> dict:
    organizations = organizations_data if isinstance(organizations_data, list) else []
    if org_id:
        for org in organizations:
            if isinstance(org, dict) and str(org.get("uuid") or "") == org_id:
                return org

    memberships = (account_data or {}).get("memberships") or []
    for membership in memberships:
        if not isinstance(membership, dict):
            continue
        org = membership.get("organization")
        if isinstance(org, dict):
            return org

    for org in organizations:
        if isinstance(org, dict):
            return org
    return {}


def _extract_claude_identity(
    organizations_data: object,
    account_data: dict,
    org_id: str | None,
) -> dict:
    org = _select_claude_org(organizations_data, org_id, account_data)
    return {
        "plan": (
            org.get("raven_type")
            or org.get("plan")
            or org.get("subscription_plan")
            or org.get("billing_type")
        )
        or "",
        "team_name": org.get("name") or "",
        "organization_id": org.get("uuid") or org.get("id") or org_id or "",
        "organization_billing_type": org.get("billing_type") or "",
        "organization_rate_tier": org.get("rate_limit_tier") or "",
        "user_name": account_data.get("full_name") or account_data.get("display_name") or "",
        "account_name": account_data.get("email_address") or "",
        "account_id": account_data.get("uuid") or account_data.get("tagged_id") or "",
    }


def extract_claude_identity(raw: dict) -> dict:
    identity = raw.get("identity")
    merged = dict(identity) if isinstance(identity, dict) else {}
    fresh = _extract_claude_identity(
        raw.get("_organizations") or [],
        raw.get("_account") or {},
        raw.get("_organization_id"),
    )
    for key, value in fresh.items():
        if value not in (None, ""):
            merged[key] = value
    return merged

def _fetch_claude_usage_uncached(browsers: list[str] | None = None) -> dict:
    """Internal function to fetch Claude usage data without caching"""
    try:
        cookie_candidates = load_cookie_candidates(CLAUDE_DOMAIN, browsers)
    except Exception as e:
        raise RuntimeError(f"Failed to read cookies: {e}")

    errors: list[str] = []
    for cookies, browser_name in cookie_candidates:
        last_error = None
        for _attempt in range(2):
            for impersonate in CLAUDE_IMPERSONATIONS:
                try:
                    # Keep the same session for warm-up and API calls. This is
                    # important for Claude's Cloudflare challenge cookie.
                    http = requests.Session(impersonate=impersonate)
                    http.cookies.update(cookies)
                    http.get(
                        f"https://{CLAUDE_DOMAIN}/",
                        headers=BASE_HEADERS,
                        timeout=10,
                    )

                    orgs_resp = http.get(
                        ORGANIZATIONS_URL,
                        headers=BASE_HEADERS,
                        timeout=10,
                    )
                    if orgs_resp.status_code == 403:
                        raise RuntimeError(
                            f"403 Forbidden from Claude organizations ({impersonate})"
                        )
                    orgs_resp.raise_for_status()
                    organizations_data = orgs_resp.json()

                    # Prefer the cookie, but recover when Claude renamed or
                    # omitted lastActiveOrg from the browser cookie jar.
                    org_id = cookies.get("lastActiveOrg")
                    if not org_id:
                        selected = _select_claude_org(organizations_data, None)
                        org_id = selected.get("uuid") or selected.get("id")
                    if not org_id:
                        raise RuntimeError("Claude returned no organizations")

                    account_resp = http.get(
                        ACCOUNT_URL,
                        headers=BASE_HEADERS,
                        timeout=10,
                    )
                    if account_resp.status_code == 403:
                        raise RuntimeError(
                            f"403 Forbidden from Claude account ({impersonate})"
                        )
                    account_resp.raise_for_status()
                    account_data = account_resp.json()

                    resp = http.get(
                        f"https://{CLAUDE_DOMAIN}/api/organizations/{org_id}/usage",
                        headers=BASE_HEADERS,
                        timeout=10,
                    )
                    if resp.status_code == 403:
                        raise RuntimeError(
                            f"403 Forbidden from Claude usage ({impersonate})"
                        )
                    resp.raise_for_status()
                    usage_data = resp.json()
                    if isinstance(usage_data, dict):
                        usage_data["_organization_id"] = org_id
                        usage_data["_organizations"] = organizations_data
                        usage_data["_account"] = account_data
                        usage_data["source"] = browser_name
                        usage_data["identity"] = _extract_claude_identity(
                            organizations_data, account_data, org_id
                        )
                    return usage_data
                except Exception as exc:
                    last_error = exc
        errors.append(f"{browser_name}: {last_error}")

    raise RuntimeError("Claude authentication failed; " + "; ".join(errors))


def get_claude_usage(browsers: list[str] | None = None) -> dict:
    """
    Fetch Claude usage data using curl_cffi to impersonate Chrome.

    Uses file-based caching to prevent multiple Waybar instances (one per monitor)
    from making concurrent API requests that might be rate-limited.
    """
    data = get_cached_or_fetch("claude", lambda: _fetch_claude_usage_uncached(browsers))
    if isinstance(data, dict) and (not data.get("identity") or not data.get("source")):
        # Refresh immediately when a pre-identity cache entry is still fresh.
        data = get_cached_or_fetch(
            "claude", lambda: _fetch_claude_usage_uncached(browsers), ttl=0
        )
    return data


# ==================== Output: CLI ====================

def print_cli(usage: dict) -> None:
    identity = extract_claude_identity(usage)

    print(f"Plan              : {identity.get('plan') or 'Unknown'}")
    if identity.get("team_name"):
        print(f"Team              : {identity['team_name']}")
    print(
        f"User              : "
        f"{identity.get('user_name') or identity.get('account_name') or 'Unknown'}"
    )
    for label, raw_limit in claude_limit_windows(usage):
        window = parse_window_percent(raw_limit, key="percent")
        if "percent" not in raw_limit:
            window = parse_window_percent(raw_limit)
        reset = format_eta(window.resets_at) if window.resets_at else "Not started"
        print(f"{label:<18}: {100 - window.utilization:>5.1f}% remaining  (Reset in {reset})")


# ==================== CLI Entry Point ====================

def main() -> None:
    parser = argparse.ArgumentParser(description="Print Claude.ai usage to terminal.")
    parser.add_argument(
        "--browser",
        action="append",
        help="Browser cookie source to try (repeatable). Example: --browser chromium",
    )
    args = parser.parse_args()

    try:
        usage = get_claude_usage(args.browser)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(usage)


if __name__ == "__main__":
    main()
