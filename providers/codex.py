from __future__ import annotations

import argparse
import math
import sys
from collections.abc import Mapping

from curl_cffi import requests

from common import (
    finite_float,
    format_eta,
    get_cached_or_fetch,
    load_cookie_candidates,
    parse_window_direct,
)
from providers.metrics import (
    Metric,
    format_plan_value,
    is_weekly_window,
    pad_reset,
    window_reset,
)


# ================= Configuration =================

BASE_HEADERS = {
    "Referer": "https://chatgpt.com/",
    "Origin": "https://chatgpt.com",
    "Accept": "*/*"
}

SESSION_URL = "https://chatgpt.com/api/auth/session"
ACCOUNTS_URL = "https://chatgpt.com/backend-api/accounts"
# Query the Codex route first and retain the legacy route as a compatibility
# fallback for browser sessions on older ChatGPT deployments.
CODEX_USAGE_URLS = (
    "https://chatgpt.com/backend-api/codex/usage",
    "https://chatgpt.com/backend-api/wham/usage",
)
# The browser's selected account is encoded in its cookie, so preserve the
# route it uses for its own quota panel before trying the newer compatibility
# endpoint.
CODEX_BROWSER_USAGE_URLS = tuple(reversed(CODEX_USAGE_URLS))
CODEX_IMPERSONATIONS = ("chrome124", "edge", "safari")

# ================= Network Logic =================


def _window_label(window: Mapping[str, object], fallback: str) -> str:
    """Return a useful label without assuming which Codex windows exist."""
    raw_seconds = window.get("limit_window_seconds")
    try:
        seconds = int(raw_seconds) if isinstance(raw_seconds, (str, int, float)) else 0
    except ValueError:
        seconds = 0

    if seconds == 7 * 24 * 60 * 60:
        return "7d"
    if seconds == 24 * 60 * 60:
        return "Daily"
    if seconds and seconds % (60 * 60) == 0:
        return f"{seconds // (60 * 60)}h"
    if seconds and seconds % 60 == 0:
        return f"{seconds // 60}m"
    if seconds:
        return f"{seconds}s"
    return fallback.removesuffix("_window").replace("_", " ").title()


def codex_rate_limit_windows_with_scope(
    usage: Mapping[str, object],
) -> list[tuple[str, Mapping[str, object], bool]]:
    """Extract every rate-limit window returned by the Codex usage API.

    ChatGPT has moved its rolling and weekly limits between ``primary_window``
    and ``secondary_window`` before.  Inspect the response rather than tying
    either name to a particular duration, so newly added windows appear without
    a code change.
    """
    candidates: list[tuple[str, Mapping[str, object], bool]] = []

    def visit(value: object, path: str, provider_wide: bool) -> None:
        if isinstance(value, Mapping):
            if "used_percent" in value or "limit_window_seconds" in value:
                candidates.append((_window_label(value, path), value, provider_wide))
                return
            for key, child in value.items():
                visit(child, f"{path}_{key}" if path else str(key), provider_wide)
        elif isinstance(value, list):
            for index, child in enumerate(value, start=1):
                visit(child, f"{path}_{index}", provider_wide)

    # Keep the main limit first, then include any future named rate-limit
    # groups (for example, a code-review-specific limit).
    for key, value in usage.items():
        if key == "rate_limit" or "rate_limit" in key:
            visit(value, key, key == "rate_limit")

    labels: dict[str, int] = {}
    windows: list[tuple[str, Mapping[str, object], bool]] = []
    for label, window, provider_wide in candidates:
        labels[label] = labels.get(label, 0) + 1
        unique_label = label if labels[label] == 1 else f"{label} {labels[label]}"
        windows.append((unique_label, window, provider_wide))
    return windows


def codex_rate_limit_windows(
    usage: Mapping[str, object],
) -> list[tuple[str, Mapping[str, object]]]:
    """Compatibility view of Codex windows without provider scope metadata."""
    return [
        (label, window)
        for label, window, _provider_wide in codex_rate_limit_windows_with_scope(usage)
    ]


def _extract_codex_identity(
    usage_data: dict, session_data: dict, workspace_name: str = ""
) -> dict:
    account = session_data.get("account") or {}
    user = session_data.get("user") or {}
    # The browser session omits the workspace name, so fall back to the name
    # carried by the accounts endpoint when one is available.
    team_name = (
        account.get("name")
        or account.get("displayName")
        or account.get("organizationName")
        or account.get("workspaceName")
        or workspace_name
    )
    return {
        "plan": usage_data.get("plan_type") or account.get("planType"),
        "account_plan": account.get("planType") or "",
        "team_name": team_name or "",
        "workspace_id": account.get("id") or "",
        "organization_id": account.get("organizationId") or account.get("id") or "",
        "user_name": user.get("name") or "",
        "account_name": user.get("email") or usage_data.get("email") or "",
        "account_kind": account.get("structure") or "",
    }


def codex_credit_limit(usage: Mapping[str, object]) -> Mapping[str, object] | None:
    """Return the monthly credit limit Codex reports for this workspace seat."""
    spend_control = usage.get("spend_control")
    if not isinstance(spend_control, Mapping):
        return None
    limit = spend_control.get("individual_limit")
    return limit if isinstance(limit, Mapping) else None


def extract_codex_identity(raw: dict) -> dict:
    identity = raw.get("identity")
    merged = dict(identity) if isinstance(identity, dict) else {}
    fresh = _extract_codex_identity(raw, raw.get("_session") or {})
    for key, value in fresh.items():
        if value not in (None, ""):
            merged[key] = value
    return merged


def _get_codex_usage(
    http, headers: dict[str, str], usage_urls: tuple[str, ...] = CODEX_USAGE_URLS
) -> dict:
    """Fetch usage from the current Codex endpoint, with legacy fallback."""
    endpoint_errors: list[str] = []
    for usage_url in usage_urls:
        usage_resp = http.get(usage_url, headers=headers, timeout=10)
        if usage_resp.status_code == 404:
            endpoint_errors.append(f"{usage_url}: 404")
            continue
        usage_resp.raise_for_status()
        usage_data = usage_resp.json()
        if not isinstance(usage_data, dict):
            raise RuntimeError("Codex usage endpoint returned an invalid response")
        return usage_data
    raise RuntimeError(
        "Codex usage endpoint unavailable: " + "; ".join(endpoint_errors)
    )


def _fetch_usage_for_account(
    cookies_dict: Mapping,
    impersonate: str,
    account_id: str,
    workspace_name: str = "",
) -> dict | None:
    """Fetch usage for a single Codex workspace, or None to skip it.

    ChatGPT chooses the current workspace through the ``_account`` cookie.
    Clone the browser cookie jar and switch it only in memory, then obtain a
    session token for that workspace.  This is the same account-scoped session
    model used by the web app; it never writes to the user's browser profile.
    """
    account_http = requests.Session(impersonate=impersonate)
    account_cookies = dict(cookies_dict)
    account_cookies["_account"] = account_id
    account_http.cookies.update(account_cookies)
    account_session_resp = account_http.get(
        SESSION_URL,
        headers=BASE_HEADERS,
        timeout=10,
    )
    account_session_resp.raise_for_status()
    account_session = account_session_resp.json()
    selected_account = account_session.get("account") or {}
    if selected_account.get("id") != account_id:
        return None

    account_token = account_session.get("accessToken")
    if not account_token:
        return None
    account_headers = BASE_HEADERS.copy()
    account_headers["Authorization"] = f"Bearer {account_token}"
    usage_data = _get_codex_usage(
        account_http,
        account_headers,
        CODEX_BROWSER_USAGE_URLS,
    )
    usage_data["identity"] = _extract_codex_identity(
        usage_data, account_session, workspace_name
    )
    return usage_data


def _fetch_codex_usages_from_browser(
    browsers: list[str] | None = None,
) -> list[dict]:
    """Fetch quotas for every workspace visible to a browser session."""
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
                    accounts_resp = http.get(
                        ACCOUNTS_URL,
                        headers=usage_headers,
                        timeout=10,
                    )
                    accounts_resp.raise_for_status()
                    accounts_payload = accounts_resp.json()
                    accounts = (
                        accounts_payload.get("items", [])
                        if isinstance(accounts_payload, Mapping)
                        else []
                    )
                    if not isinstance(accounts, list):
                        raise RuntimeError("ChatGPT accounts endpoint returned invalid data")

                    # Older accounts responses can omit the selected account.
                    # Keep that account visible rather than treating the list
                    # as empty.
                    active_account = session_data.get("account") or {}
                    active_account_id = active_account.get("id")
                    if active_account_id and not any(
                        isinstance(account, Mapping)
                        and account.get("id") == active_account_id
                        for account in accounts
                    ):
                        accounts.append(active_account)

                    usages: list[dict] = []
                    seen_account_ids: set[str] = set()
                    account_errors: list[str] = []
                    for account in accounts:
                        if not isinstance(account, Mapping) or not account.get("id"):
                            continue
                        account_id = str(account["id"])
                        if account_id in seen_account_ids:
                            continue
                        seen_account_ids.add(account_id)

                        # A single unusable workspace (revoked seat, missing
                        # Codex access, endpoint failure) must not sink the
                        # others; skip it and keep the workspaces that respond.
                        try:
                            usage_data = _fetch_usage_for_account(
                                cookies_dict,
                                impersonate,
                                account_id,
                                str(account.get("name") or ""),
                            )
                        except Exception as e:
                            account_errors.append(f"{account_id}: {e}")
                            continue
                        if usage_data is None:
                            continue
                        usage_data["source"] = browser_name
                        usages.append(usage_data)

                    if not usages:
                        message = "No usable ChatGPT accounts found"
                        if account_errors:
                            message += ": " + "; ".join(account_errors)
                        raise RuntimeError(message)
                    return usages
                except Exception as e:
                    last_error = e
        errors.append(f"{browser_name}: {last_error}")

    if errors:
        raise RuntimeError("Codex authentication failed; " + "; ".join(errors))
    raise RuntimeError("Codex authentication failed: no cookie candidates")


def _fetch_codex_usages_uncached(browsers: list[str] | None = None) -> list[dict]:
    """Fetch each distinct Codex workspace exposed by browser cookies."""
    return _fetch_codex_usages_from_browser(browsers)


def get_codex_usages(browsers: list[str] | None = None) -> list[dict]:
    """Fetch all distinct Codex accounts, using a shared short-lived cache."""
    # Scope the cache by browser preference: different browsers can hold
    # different accounts/workspaces, so switching --browser must not reuse them.
    cache_name = "codex:" + ",".join(browsers) if browsers else "codex"
    data = get_cached_or_fetch(
        cache_name, lambda: _fetch_codex_usages_uncached(browsers)
    )
    if not isinstance(data, list) or any(
        not isinstance(item, dict)
        or not extract_codex_identity(item).get("workspace_id")
        or not item.get("source")
        for item in data
    ):
        # Refresh a pre-multi-account cache entry created by older releases:
        # only workspace/source absence marks an old cache shape. A missing
        # identity plan is a legitimate state and must not refetch every run.
        data = get_cached_or_fetch(
            cache_name, lambda: _fetch_codex_usages_uncached(browsers), ttl=0
        )
    return data


def get_codex_usage(browsers: list[str] | None = None) -> dict:
    """Compatibility wrapper for callers that support one Codex account."""
    return get_codex_usages(browsers)[0]


# ===== Adapters: normalized metrics and plan label =====


def format_credit_amount(value: object) -> str:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError, OverflowError):
        return str(value)
    if not math.isfinite(number):
        return "—"
    return f"{number:.2f}".rstrip("0").rstrip(".")


def codex_credit_metric(raw: dict) -> Metric | None:
    """Render the workspace credit allowance Codex seats draw from."""
    credits = raw.get("credits")
    credits = credits if isinstance(credits, dict) else {}
    unlimited = bool(credits.get("unlimited"))
    balance = (
        finite_float(credits["balance"])
        if credits.get("balance") not in (None, "")
        else None
    )
    # The balance does not refill on the spend-control reset, so zero credits
    # must read as unusable even while the monthly limit has room left.
    insufficient = not unlimited and balance is not None and balance <= 0

    limit = codex_credit_limit(raw)
    if limit is not None:
        pct = finite_float(limit.get("remaining_percent"))
        if pct is None:
            remaining_amount = finite_float(limit.get("remaining"))
            limit_amount = finite_float(limit.get("limit"))
            if remaining_amount is not None and limit_amount:
                pct = finite_float(remaining_amount / limit_amount * 100)
        remaining = limit.get("remaining")
        total = limit.get("limit")
        if (
            remaining in (None, "")
            or total in (None, "")
            or finite_float(remaining) is None
            or finite_float(total) is None
        ):
            value = f"{pct:.0f}%" if pct is not None else "—"
        else:
            value = f"{format_credit_amount(remaining)} / {format_credit_amount(total)}"
        reset_at = limit.get("reset_at")
        return Metric(
            "Credits",
            value,
            None if pct is None else max(0.0, min(100.0, pct)),
            pad_reset(format_eta(reset_at)) if reset_at else "—",
            is_remaining=True,
            is_credit=True,
            insufficient=insufficient,
        )

    if unlimited:
        return Metric(
            "Credits", "Unlimited", None, "—", is_remaining=True, is_credit=True
        )
    if balance is not None:
        return Metric(
            "Credits",
            f"{format_credit_amount(balance)} credits",
            None,
            "—",
            is_remaining=True,
            is_credit=True,
            insufficient=insufficient,
        )
    if credits.get("has_credits"):
        return Metric(
            "Credits", "Available", None, "—", is_remaining=True, is_credit=True
        )
    return None


def adapt_codex(raw: dict) -> list[Metric]:
    metrics = []
    for label, raw_window, provider_wide in codex_rate_limit_windows_with_scope(raw):
        window = parse_window_direct(raw_window)
        remaining = max(0.0, min(100.0, 100.0 - window.utilization))
        metrics.append(
            Metric(
                label,
                f"{remaining:.0f}%",
                remaining,
                window_reset(window),
                is_remaining=True,
                is_blocking_period=provider_wide and is_weekly_window(raw_window),
            )
        )

    credit = codex_credit_metric(raw)
    identity = extract_codex_identity(raw)
    # The workspace-level isUsageBasedSeatEnabled flag stays true even after a
    # member moves to a standard seat, so the plan itself is the seat signal.
    plan = str(identity.get("plan") or raw.get("plan_type") or "").strip().lower()
    if plan == "self_serve_business_usage_based":
        # Legacy Codex seats have no included usage, so the workspace credit
        # allowance replaces the rate-limit windows entirely.
        return [credit] if credit is not None else metrics
    # Standard seats keep their included windows; credits are only worth a row
    # when workspace spend controls define a monthly limit to draw a bar from.
    if credit is not None and credit.pct is not None:
        metrics.append(credit)
    return metrics


def plan_codex(raw: dict) -> str:
    identity = raw.get("identity") or {}
    value = identity.get("plan")
    if value in (None, ""):
        session = raw.get("_session") or {}
        account = session.get("account") or {}
        value = raw.get("plan_type") or account.get("planType")
    # The usage API calls workspace seats "team", including when the session
    # is scoped to a personal account.  The session payload's planType is the
    # precise source for a personal plan (free / plus / pro); trusting the
    # usage label here would misreport paid personal accounts.
    if identity.get("account_kind") == "personal":
        value = identity.get("account_plan") or value
    if str(value or "").strip().lower() in {
        "team",
        "self_serve_business_prolite",
        "self_serve_business_usage_based",
    }:
        team_name = identity.get("team_name")
        return f"Business ({team_name})" if team_name else "Business"
    plan = format_plan_value(value)
    return plan


# ================= Output: CLI =================


def print_cli(usage: dict) -> None:
    # Share the plan label and metric logic with the table renderer so the
    # standalone provider script, the TUI, and the GNOME extension agree.
    identity = extract_codex_identity(usage)

    print(f"Plan              : {plan_codex(usage)}")
    if identity.get("team_name"):
        print(f"Team              : {identity['team_name']}")
    print(
        f"User              : "
        f"{identity.get('user_name') or identity.get('account_name') or 'Unknown'}"
    )
    for metric in adapt_codex(usage):
        print(
            f"{metric.label:<18}: {metric.value:>8} | "
            f"Reset in {metric.reset}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="Print ChatGPT Codex usage to terminal.")
    parser.add_argument(
        "--browser",
        action="append",
        help="Browser cookie source to try (repeatable). Example: --browser chromium",
    )
    args = parser.parse_args()

    try:
        usages = get_codex_usages(args.browser)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    for index, usage in enumerate(usages):
        if index:
            print()
        print_cli(usage)


if __name__ == "__main__":
    main()
