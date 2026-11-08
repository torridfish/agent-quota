from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from common import get_cached_or_fetch
from toml_edit import read_secret_lines


CONFIG_PATH = Path("~/.config/agent-quota/deepseek.conf").expanduser()
API_BASE = "https://api.deepseek.com"
BALANCE_URL = f"{API_BASE}/user/balance"


def load_deepseek_config(config_path: Path | None = None) -> dict:
    path = config_path or CONFIG_PATH
    config: dict = {"DEEPSEEK_API_KEY": None}

    if not path.exists():
        return config

    for line in read_secret_lines(path):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            if key.strip() == "DEEPSEEK_API_KEY":
                config["DEEPSEEK_API_KEY"] = value.strip()

    return config


def _api_get(url: str, token: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "agent-quota/deepseek",
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


def _fetch_deepseek_balance_uncached(token: str) -> dict:
    data = _api_get(BALANCE_URL, token)
    balances = data.get("balance_infos")
    if not isinstance(balances, list):
        raise RuntimeError("API error: missing balance_infos")
    return {
        "is_available": bool(data.get("is_available")),
        "balances": balances,
    }


def get_deepseek_balance(token: str) -> dict:
    return get_cached_or_fetch(
        "deepseek",
        lambda: _fetch_deepseek_balance_uncached(token),
    )


def print_cli(balance: dict) -> None:
    print("DeepSeek API Balance")
    print("-" * 40)
    print(f"Available: {'yes' if balance.get('is_available') else 'no'}")
    for item in balance.get("balances", []):
        currency = item.get("currency", "?")
        total = item.get("total_balance", "0")
        granted = item.get("granted_balance", "0")
        topped_up = item.get("topped_up_balance", "0")
        print(f"{currency} total   : {total}")
        print(f"{currency} granted : {granted}")
        print(f"{currency} topped  : {topped_up}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Print DeepSeek API balance to terminal.")
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"Path to DeepSeek config file (default: {CONFIG_PATH})",
    )
    args = parser.parse_args()

    config = load_deepseek_config(args.config)
    token = config["DEEPSEEK_API_KEY"]

    if not token:
        print(f"[!] No DEEPSEEK_API_KEY in {args.config}", file=sys.stderr)
        print(
            "    Create an API key at https://platform.deepseek.com/api_keys and save it as",
            file=sys.stderr,
        )
        print(f"    DEEPSEEK_API_KEY=sk-... in {args.config}", file=sys.stderr)
        sys.exit(1)

    try:
        balance = get_deepseek_balance(token)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(balance)


if __name__ == "__main__":
    main()
