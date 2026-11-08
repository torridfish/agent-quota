from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from common import get_cached_or_fetch
from toml_edit import read_secret_lines


CONFIG_PATH = Path("~/.config/agent-quota/openrouter.conf").expanduser()
API_BASE = "https://openrouter.ai/api/v1"
CREDITS_URL = f"{API_BASE}/credits"


def load_openrouter_config(config_path: Path | None = None) -> dict:
    path = config_path or CONFIG_PATH
    config: dict = {"OPENROUTER_API_KEY": None}

    if not path.exists():
        return config

    for line in read_secret_lines(path):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            if key.strip() == "OPENROUTER_API_KEY":
                config["OPENROUTER_API_KEY"] = value.strip()

    return config


def _api_get(url: str, token: str) -> dict:
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "User-Agent": "agent-quota/openrouter",
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


def _fetch_openrouter_balance_uncached(token: str) -> dict:
    data = _api_get(CREDITS_URL, token)
    payload = data.get("data")
    if not isinstance(payload, dict):
        raise RuntimeError("API error: missing data payload")

    total_credits = float(payload.get("total_credits", 0.0))
    total_usage = float(payload.get("total_usage", 0.0))
    return {
        "total_credits": total_credits,
        "total_usage": total_usage,
        "remaining_credits": total_credits - total_usage,
    }


def get_openrouter_balance(token: str) -> dict:
    return get_cached_or_fetch(
        "openrouter",
        lambda: _fetch_openrouter_balance_uncached(token),
    )


def print_cli(balance: dict) -> None:
    total = float(balance.get("total_credits", 0.0))
    used = float(balance.get("total_usage", 0.0))
    remaining = float(balance.get("remaining_credits", 0.0))
    print("OpenRouter Credits")
    print("-" * 40)
    print(f"Remaining : ${remaining:.2f}")
    print(f"Used      : ${used:.2f}")
    print(f"Purchased : ${total:.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Print OpenRouter credits to terminal.")
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"Path to OpenRouter config file (default: {CONFIG_PATH})",
    )
    args = parser.parse_args()

    config = load_openrouter_config(args.config)
    token = config["OPENROUTER_API_KEY"]

    if not token:
        print(f"[!] No OPENROUTER_API_KEY in {args.config}", file=sys.stderr)
        print(
            "    Create an OpenRouter management key at https://openrouter.ai/settings/keys and save it as",
            file=sys.stderr,
        )
        print(f"    OPENROUTER_API_KEY=sk-or-... in {args.config}", file=sys.stderr)
        sys.exit(1)

    try:
        balance = get_openrouter_balance(token)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(balance)


if __name__ == "__main__":
    main()
