from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

from common import get_cached_or_fetch


CONFIG_PATH = Path("~/.config/agent-quota/moonshot.conf").expanduser()

# The international platform, which bills in USD. Accounts on the China
# platform are separate and bill in CNY; those users set
# MOONSHOT_BASE_URL=https://api.moonshot.cn/v1 in the config file.
DEFAULT_BASE_URL = "https://api.moonshot.ai/v1"

_CONFIG_KEYS = ("MOONSHOT_API_KEY", "MOONSHOT_BASE_URL")


def load_moonshot_config(config_path: Path | None = None) -> dict:
    path = config_path or CONFIG_PATH
    config: dict = {"MOONSHOT_API_KEY": None, "MOONSHOT_BASE_URL": DEFAULT_BASE_URL}

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
            if key in _CONFIG_KEYS and value:
                config[key] = value

    return config


def _balance_url(base_url: str | None) -> str:
    base = (base_url or DEFAULT_BASE_URL).rstrip("/")
    return f"{base}/users/me/balance"


def _currency_for(base_url: str | None) -> str:
    # The balance endpoint does not report a currency: the platform decides it.
    # api.moonshot.cn is the China platform (CNY); everything else is the
    # international platform (USD).
    host = urlsplit(base_url or DEFAULT_BASE_URL).hostname or ""
    return "CNY" if host.endswith(".cn") else "USD"


def _api_get(url: str, token: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "agent-quota/moonshot",
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


def _as_float(value, field: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"API error: non-numeric {field} ({value!r})") from None


def _fetch_moonshot_balance_uncached(token: str, base_url: str | None) -> dict:
    payload = _api_get(_balance_url(base_url), token)

    # Success is code 0 / status true. A non-zero code still returns HTTP 200,
    # so this has to be checked explicitly rather than left to _api_get.
    code = payload.get("code")
    if payload.get("status") is False or (code is not None and code != 0):
        detail = payload.get("scode") or payload.get("error") or payload
        raise RuntimeError(f"API error: code {code} ({detail})")

    data = payload.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("API error: missing data")

    return {
        "currency": _currency_for(base_url),
        "available_balance": _as_float(data.get("available_balance"), "available_balance"),
        # voucher_balance cannot go negative; cash_balance can, and a negative
        # one means the account is in debt.
        "voucher_balance": _as_float(data.get("voucher_balance"), "voucher_balance"),
        "cash_balance": _as_float(data.get("cash_balance"), "cash_balance"),
    }


def get_moonshot_balance(token: str, base_url: str | None = None) -> dict:
    return get_cached_or_fetch(
        "moonshot",
        lambda: _fetch_moonshot_balance_uncached(token, base_url),
    )


def print_cli(balance: dict) -> None:
    currency = balance.get("currency", "?")
    available = balance.get("available_balance", 0.0)
    print("Moonshot (Kimi) API Balance")
    print("-" * 40)
    print(f"{currency} available : {available:.2f}")
    print(f"{currency} cash      : {balance.get('cash_balance', 0.0):.2f}")
    print(f"{currency} voucher   : {balance.get('voucher_balance', 0.0):.2f}")
    if available <= 0:
        print()
        print("[!] Available balance is exhausted — API calls will be rejected.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Print Moonshot (Kimi) API balance to terminal."
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"Path to Moonshot config file (default: {CONFIG_PATH})",
    )
    args = parser.parse_args()

    config = load_moonshot_config(args.config)
    token = config["MOONSHOT_API_KEY"]

    if not token:
        print(f"[!] No MOONSHOT_API_KEY in {args.config}", file=sys.stderr)
        print(
            "    Create an API key at https://platform.moonshot.ai/console/api-keys "
            "and save it as",
            file=sys.stderr,
        )
        print(f"    MOONSHOT_API_KEY=sk-... in {args.config}", file=sys.stderr)
        print(
            "    China-platform accounts also need "
            "MOONSHOT_BASE_URL=https://api.moonshot.cn/v1",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        balance = get_moonshot_balance(token, config["MOONSHOT_BASE_URL"])
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(balance)


if __name__ == "__main__":
    main()
