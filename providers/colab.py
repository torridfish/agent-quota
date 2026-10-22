"""Google Colab compute-unit balance fetcher.

Reuses the OAuth credentials that ``google-colab-cli`` (the ``colab``
command) stores in ``~/.config/colab-cli/token.json`` and calls the same
session-backend endpoint as ``colab usage``:

    GET https://colab.research.google.com/tun/m/ccu-info?authuser=0

The endpoint returns an XSSI-guarded JSON object with ``currentBalance``,
``consumptionRateHourly`` and ``assignmentsCount``.  The credentials are only
ever read: an expired access token is refreshed in memory through Google's
token endpoint, and the refreshed token is never written back to disk.  No
Colab machine is started, stopped, or otherwise touched.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from common import get_cached_or_fetch


# Written by google-colab-cli (`colab`) in Google's authorized-user format.
TOKEN_PATH = Path("~/.config/colab-cli/token.json").expanduser()
CCU_INFO_URL = "https://colab.research.google.com/tun/m/ccu-info?authuser=0"
DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token"
# The session backend rejects requests that do not identify as colab-cli.
CLIENT_AGENT = "colab-cli"
USER_AGENT = "agent-quota/colab"

CACHE_TTL = 60
REQUEST_TIMEOUT = 15
# Refresh shortly before the recorded expiry so a request never races it.
_TOKEN_REFRESH_MARGIN = timedelta(seconds=60)
# ccu-info is a tiny object; cap the read so a broken endpoint cannot make us
# buffer an unbounded response.
_MAX_RESPONSE_BYTES = 1024 * 1024

# Refreshed tokens live only in this process (e.g. across --watch refreshes).
_cached_access: dict[str, dict] = {}


def _parse_expiry(raw: object) -> datetime | None:
    """Parse Google's ``expiry`` string (``...Z``, naive UTC) into an aware dt."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _optional_str(data: dict, field: str) -> str | None:
    value = data.get(field)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _load_credentials(token_path: Path | None = None) -> dict:
    """Read the colab-cli token file without ever writing to it.

    Error messages name the file but never echo its contents, so a malformed
    or half-written token file cannot leak credentials into logs or the TUI.
    """
    path = Path(token_path) if token_path is not None else TOKEN_PATH
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        raise RuntimeError(
            f"No Colab OAuth token found at {path}. "
            "Run `colab usage` once to sign in with Google."
        ) from None
    except OSError as exc:
        raise RuntimeError(
            f"Could not read the Colab OAuth token file at {path}: "
            f"{exc.strerror or exc}"
        ) from None

    try:
        data = json.loads(raw)
    except ValueError:
        raise RuntimeError(
            f"The Colab OAuth token file at {path} is not valid JSON. "
            "Run `colab usage` once to sign in again."
        ) from None
    if not isinstance(data, dict):
        raise RuntimeError(
            f"The Colab OAuth token file at {path} is not a JSON object. "
            "Run `colab usage` once to sign in again."
        )

    access_token = _optional_str(data, "token")
    refresh_token = _optional_str(data, "refresh_token")
    if not access_token and not refresh_token:
        raise RuntimeError(
            f"The Colab OAuth token file at {path} has neither an access "
            "token nor a refresh token. Run `colab usage` once to sign in again."
        )

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "client_id": _optional_str(data, "client_id"),
        "client_secret": _optional_str(data, "client_secret"),
        "token_uri": _optional_str(data, "token_uri") or DEFAULT_TOKEN_URI,
        "expiry": _parse_expiry(data.get("expiry")),
    }


def _refresh_access_token(creds: dict) -> dict:
    """Exchange the stored refresh token for a fresh access token (in memory)."""
    missing = [
        name
        for name in ("client_id", "client_secret", "refresh_token")
        if not creds.get(name)
    ]
    if missing:
        raise RuntimeError(
            "The Colab OAuth token cannot be refreshed because it lacks "
            f"{', '.join(missing)}. Run `colab usage` once to sign in again."
        )

    body = urllib.parse.urlencode(
        {
            "client_id": creds["client_id"],
            "client_secret": creds["client_secret"],
            "refresh_token": creds["refresh_token"],
            "grant_type": "refresh_token",
        }
    ).encode()
    request = urllib.request.Request(
        creds["token_uri"],
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"Colab token refresh failed with HTTP {exc.code}. "
            "Run `colab usage` once to sign in again."
        ) from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Colab token refresh network error: {exc.reason}") from None
    except ValueError:
        raise RuntimeError(
            "Colab token refresh returned an unreadable response. "
            "Run `colab usage` once to sign in again."
        ) from None

    access_token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(access_token, str) or not access_token:
        raise RuntimeError(
            "Colab token refresh response had no access_token. "
            "Run `colab usage` once to sign in again."
        )
    return payload


def _resolve_access_token(token_path: Path | None = None) -> str:
    """Return a usable access token, refreshing it only in memory.

    The on-disk token file is never modified: a refreshed token is cached for
    this process and discarded on exit, so parallel agent-quota runs and the
    colab-cli itself keep seeing the same credentials they already own.
    """
    path = Path(token_path) if token_path is not None else TOKEN_PATH
    cache_key = str(path)
    cached = _cached_access.get(cache_key)
    if isinstance(cached, dict):
        token = cached.get("access_token")
        expires_monotonic = cached.get("expires_monotonic")
        if (
            isinstance(token, str)
            and token
            and isinstance(expires_monotonic, float)
            and time.monotonic() < expires_monotonic
        ):
            return token

    creds = _load_credentials(path)
    expiry = creds["expiry"]
    needs_refresh = expiry is None or datetime.now(timezone.utc) >= (
        expiry - _TOKEN_REFRESH_MARGIN
    )
    if creds["access_token"] and not needs_refresh:
        return creds["access_token"]

    if not creds["refresh_token"]:
        raise RuntimeError(
            "The Colab access token is missing or expired and no refresh "
            "token is stored. Run `colab usage` once to sign in again."
        )

    payload = _refresh_access_token(creds)
    access_token = payload["access_token"]
    try:
        expires_in = float(payload.get("expires_in", 3600))
    except (TypeError, ValueError):
        expires_in = 3600.0
    _cached_access[cache_key] = {
        "access_token": access_token,
        "expires_monotonic": time.monotonic()
        + max(0.0, expires_in - _TOKEN_REFRESH_MARGIN.total_seconds()),
    }
    return access_token


def _strip_xssi_prefix(body: str) -> str:
    """Remove Google's ``)]}'`` XSSI guard from a response body."""
    text = body.lstrip("\ufeff").lstrip()
    if text.startswith(")]}'"):
        _, _, text = text.partition("\n")
    return text.strip()


def _as_number(payload: dict, field: str) -> float:
    value = payload.get(field)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise RuntimeError(f"Colab API error: non-numeric {field} ({value!r})")
    return float(value)


def _parse_ccu_info(body: str) -> dict:
    """Parse the XSSI-prefixed ccu-info payload into plain numbers."""
    text = _strip_xssi_prefix(body)
    if not text:
        raise RuntimeError("Colab API error: empty ccu-info response")
    try:
        payload = json.loads(text)
    except ValueError:
        raise RuntimeError(
            "Colab API error: ccu-info response was not valid JSON"
        ) from None
    if not isinstance(payload, dict):
        raise RuntimeError("Colab API error: ccu-info response was not a JSON object")

    return {
        "balance": _as_number(payload, "currentBalance"),
        "rate_per_hour": _as_number(payload, "consumptionRateHourly"),
        "assignments": max(0, int(_as_number(payload, "assignmentsCount"))),
    }


def _http_error_message(exc: urllib.error.HTTPError) -> str:
    if exc.code in (401, 403):
        return (
            f"Colab ccu-info request failed with HTTP {exc.code}: the stored "
            "OAuth token was rejected. Run `colab usage` once to sign in again."
        )
    if exc.code == 404:
        # A 404 here means the session endpoint moved or is gone, not that the
        # token is bad; keep it a network/endpoint failure so the hint set
        # does not send the user to re-authenticate.
        return "Colab ccu-info endpoint unavailable (HTTP 404)"
    return f"Colab ccu-info request failed with HTTP {exc.code}"


def _get_ccu_info(access_token: str) -> dict:
    """Call the same endpoint as `colab usage` and parse its data."""
    request = urllib.request.Request(
        CCU_INFO_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "X-Colab-Client-Agent": CLIENT_AGENT,
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as resp:
            body = resp.read(_MAX_RESPONSE_BYTES).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        # Deliberately drops the response body: it can echo request metadata.
        raise RuntimeError(_http_error_message(exc)) from None
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Colab ccu-info network error: {exc.reason}") from None
    return _parse_ccu_info(body)


def colab_estimate_hours(usage: dict) -> float | None:
    """Estimated remaining hours at the current rate, or None when unknown.

    Only meaningful while Colab is actually consuming compute units: with no
    active assignment (or a zero rate) the balance would never run down at the
    reported rate, so callers must omit the estimate entirely instead of
    rendering a misleading number.
    """
    try:
        balance = float(usage.get("balance"))
        rate = float(usage.get("rate_per_hour"))
        assignments = int(usage.get("assignments"))
    except (TypeError, ValueError):
        return None
    if assignments <= 0 or rate <= 0:
        return None
    return max(0.0, balance) / rate


def _fetch_colab_usage_uncached(token_path: Path | None = None) -> dict:
    data = _get_ccu_info(_resolve_access_token(token_path))
    return {
        "balance": data["balance"],
        "rate_per_hour": data["rate_per_hour"],
        "assignments": data["assignments"],
        "identity": {"source": "colab-cli oauth"},
        "source": "colab-cli oauth",
    }


def get_colab_usage(
    browsers: list[str] | None = None, token_path: Path | None = None
) -> dict:
    # ``browsers`` is accepted for call-site compatibility with the
    # cookie-based providers; Colab auth comes from colab-cli, not cookies.
    return get_cached_or_fetch(
        "colab", lambda: _fetch_colab_usage_uncached(token_path), ttl=CACHE_TTL
    )


def print_cli(usage: dict) -> None:
    balance = float(usage.get("balance", 0.0))
    rate = float(usage.get("rate_per_hour", 0.0))
    assignments = int(usage.get("assignments", 0))
    print("Google Colab compute units")
    print("-" * 40)
    print(f"Remaining       : {balance:.2f} CU")
    print(f"Usage rate      : {rate:.2f} CU/hr")
    print(f"Active machines : {assignments}")
    hours = colab_estimate_hours(usage)
    if hours is not None:
        print(f"Estimated hours : {hours:.1f}h (assumes the current usage rate)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Print Google Colab compute-unit balance to terminal."
    )
    parser.add_argument(
        "--token-path",
        type=Path,
        default=TOKEN_PATH,
        help=f"colab-cli OAuth token file (default: {TOKEN_PATH})",
    )
    args = parser.parse_args()

    try:
        usage = get_colab_usage(token_path=args.token_path)
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    print_cli(usage)


if __name__ == "__main__":
    main()
