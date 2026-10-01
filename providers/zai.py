from __future__ import annotations

import argparse
import json
import sys
import urllib.request
import urllib.error
from pathlib import Path

from common import format_eta, get_cached_or_fetch


# ==================== Configuration ====================

CONFIG_PATH = Path("~/.config/agent-quota/zai.conf").expanduser()
API_BASE = "https://api.z.ai"
QUOTA_URL = f"{API_BASE}/api/monitor/usage/quota/limit"
CODING_API_BASE = f"{API_BASE}/api/coding/paas/v4"


def load_zai_config(config_path: Path | None = None) -> dict:
    path = config_path or CONFIG_PATH
    config: dict = {"ZAI_TOKEN": None}

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
            if key == "ZAI_TOKEN":
                config["ZAI_TOKEN"] = value

    return config


# ==================== Core Logic: Get Quota ====================


def _api_get(url: str, token: str) -> dict:
    # Z.ai's monitor API expects the raw token in the Authorization header,
    # without the "Bearer " prefix. GLM Coding Plan tokens are rejected
    # with 401 otherwise.
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": token,
            "Accept": "application/json",
            "Accept-Language": "en-US,en",
            "Content-Type": "application/json",
            "User-Agent": "agent-quota/zai",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e.reason}") from e


def _fetch_zai_quota_uncached(token: str) -> dict:
    data = _api_get(QUOTA_URL, token)

    if not data.get("success"):
        msg = data.get("msg", "Unknown error")
        raise RuntimeError(f"API error: {msg}")

    payload = data.get("data")
    limits = payload.get("limits") if isinstance(payload, dict) else None
    if not isinstance(limits, list) or not limits:
        raise RuntimeError(
            "Z.ai API token returned no Coding Plan quota limits. "
            f"Confirm the key belongs to the active plan and that your coding tool uses {CODING_API_BASE}."
        )

    token_limit = None
    weekly_limit = None
    time_limit = None

    for item in limits:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "TOKENS_LIMIT" and item.get("unit") == 3:
            token_limit = item
        elif item.get("type") == "TOKENS_LIMIT" and item.get("unit") == 6:
            weekly_limit = item
        elif item.get("type") == "TOKENS_LIMIT" and token_limit is None:
            # Legacy payloads omitted `unit` and exposed one token window.
            token_limit = item
        elif item.get("type") == "TIME_LIMIT":
            time_limit = item

    return {
        "limits": limits,
        "token_limit": token_limit,
        "weekly_limit": weekly_limit,
        "time_limit": time_limit,
        "level": payload.get("level"),
    }


def get_zai_quota(token: str) -> dict:
    return get_cached_or_fetch(
        # v2 preserves all Coding Plan windows instead of collapsing every
        # TOKENS_LIMIT into one item.  Use a new cache key so stale normalized
        # v1 payloads cannot keep the GNOME card empty after upgrading.
        "zai-v2",
        lambda: _fetch_zai_quota_uncached(token),
        ttl=120,
    )


# ==================== Helpers ====================


def _format_tokens(value: int) -> str:
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{value / 1_000:.1f}K"
    return str(value)


def _format_ms_reset(ms: int | None) -> str:
    if not ms:
        return "??"
    return format_eta(ms // 1000)


# ==================== Output: CLI ====================


def print_cli(quota: dict) -> None:
    tl = quota.get("token_limit")
    wl = quota.get("weekly_limit")
    ml = quota.get("time_limit")

    print(f"Z.ai Usage (level: {quota.get('level', '?')})")
    print("-" * 50)

    if tl:
        pct = max(0, 100 - float(tl.get("percentage", 0)))
        reset = _format_ms_reset(tl.get("nextResetTime"))
        print(f"5h quota remaining    : {pct:.0f}%  (Reset in {reset})")

    if wl:
        pct = max(0, 100 - float(wl.get("percentage", 0)))
        reset = _format_ms_reset(wl.get("nextResetTime"))
        print(f"Weekly quota remaining: {pct:.0f}%  (Reset in {reset})")

    if ml:
        pct = max(0, 100 - float(ml.get("percentage", 0)))
        current = ml.get("currentValue")
        total = ml.get("usage")
        remaining = ml.get("remaining")
        if remaining is None and current is not None and total is not None:
            remaining = max(0, float(total) - float(current))
        reset = _format_ms_reset(ml.get("nextResetTime"))
        print(f"Monthly MCP remaining : {pct:.0f}% ({remaining} remaining, reset in {reset})")
        for d in ml.get("usageDetails", []):
            code = d.get("modelCode", "?")
            usage = d.get("usage", 0)
            print(f"  - {code}: {usage}")


# ==================== CLI Entry Point ====================


def main() -> None:
    parser = argparse.ArgumentParser(description="Print Z.ai usage to terminal.")
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"Path to Z.ai config file (default: {CONFIG_PATH})",
    )
    args = parser.parse_args()

    config = load_zai_config(args.config)
    token = config["ZAI_TOKEN"]

    if not token:
        print(f"[!] No ZAI_TOKEN in {args.config}", file=sys.stderr)
        print(f"    Web session JWT:", file=sys.stderr)
        print(f"      1. Log into https://z.ai", file=sys.stderr)
        print(f"      2. Open DevTools (F12) > Network tab", file=sys.stderr)
        print(f"      3. Copy the Authorization header value from any api.z.ai", file=sys.stderr)
        print(f"         request (strip the leading 'Bearer ')", file=sys.stderr)
        print(f"    GLM Coding Plan API key: paste it directly.", file=sys.stderr)
        print(f"    Then save ZAI_TOKEN=<token> in {args.config}", file=sys.stderr)
        sys.exit(1)

    try:
        quota = get_zai_quota(token)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(quota)


if __name__ == "__main__":
    main()
