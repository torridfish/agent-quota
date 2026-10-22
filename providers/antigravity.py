"""Gemini (Antigravity) usage fetcher.

Fetches the quota summary Google's Antigravity exposes for the account the
``agy`` CLI is signed into, reusing the OAuth token agy stores in the
platform credential store. Quota data comes from JSON endpoints, never from
scraping the CLI's output; the only CLI invocation is ``agy --version``,
used to keep the client version in our User-Agent current (see below).

Token sources, in order:
  1. The platform keyring entry written by ``agy`` (go-keyring: service
     ``gemini``, account ``antigravity`` — on Linux read via the Secret
     Service D-Bus API with the optional ``secretstorage`` dependency).
  2. The legacy token file ``~/.gemini/antigravity-cli/antigravity-oauth-token``
     written by older CLI versions (read-only: we never write back, that is
     the CLI's home and could corrupt its login).

Expired tokens are refreshed through Google's token endpoint. The OAuth
client credentials are deliberately not shipped with agent-quota: they are
read from ``~/.config/agent-quota/gemini.conf`` (``GEMINI_CLIENT_ID`` and
``GEMINI_CLIENT_SECRET``) and only when the stored access token has actually
expired, so a machine where ``agy`` keeps its token fresh needs no extra
configuration.

The quota itself comes from the internal Cloud Code endpoint::

    POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
    Body: {"project": "<project id>"}

which returns one group per quota pool: ``Gemini Models`` and ``Claude and
GPT models`` (each with a ``5h`` and a ``weekly`` window) plus
``Gemini 4 Argon`` (``weekly`` only, paid plans).

The request carries the Code Assist project from
``v1internal:loadCodeAssist`` (``cloudaicompanionProject``), which is what
the CLI uses; the cache file only holds the CLI's workspace project and is
kept as a fallback. Both the summary call and that lookup are gated on the
client identity in the User-Agent: only ``antigravity/cli/<semver>`` gets
the Gemini and Argon pools, and a version below the server's floor silently
drops Argon. The version is therefore read from ``agy --version`` rather
than pinned here.
"""

from __future__ import annotations

import argparse
import base64
import functools
import json
import platform
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from curl_cffi import requests

from common import format_eta, get_cached_or_fetch


# ==================== Configuration ====================

GEMINI_CLI_DIR = Path.home() / ".gemini" / "antigravity-cli"
# Legacy OAuth token written by older Antigravity CLI versions.
LEGACY_TOKEN_PATH = GEMINI_CLI_DIR / "antigravity-oauth-token"
# Project id cache written by the CLI.
PROJECT_ID_PATH = GEMINI_CLI_DIR / "cache" / "default_project_id.txt"

# go-keyring stores the token under these attributes on the Secret Service.
KEYRING_SERVICE = "gemini"
KEYRING_ACCOUNT = "antigravity"

_TOKEN_URL = "https://oauth2.googleapis.com/token"
_QUOTA_HOSTS = (
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
)
_QUOTA_METHOD = "/v1internal:retrieveUserQuotaSummary"
_MODELS_METHOD = "/v1internal:fetchAvailableModels"
_CODE_ASSIST_METHOD = "/v1internal:loadCodeAssist"

# OAuth client credentials used for token refresh. They live outside the
# repository, in a file the user owns; see load_gemini_config and
# _client_credentials.
CONFIG_PATH = Path("~/.config/agent-quota/gemini.conf").expanduser()
_CONFIG_KEYS = ("GEMINI_CLIENT_ID", "GEMINI_CLIENT_SECRET")

CACHE_TTL = 120
REQUEST_TIMEOUT = 15
MAX_REQUEST_ATTEMPTS = 3
# The Cloud Code endpoints gate on the client identity in the User-Agent:
# anything but ``antigravity/cli/<semver>`` only returns the third-party
# pool, and a version below the server's floor silently drops the Argon
# pool (HTTP 200 either way). Mirror the installed CLI's version instead of
# pinning one; the constant below is only a fallback for machines where
# ``agy`` is not on PATH.
_AGY_UA_FALLBACK_VERSION = "1.4.5"
_AGY_UA_CLIENT = "1004422050"
_AGY_UA_TIMEOUT = 8
_VERSION_RE = re.compile(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?")
_ARCH_ALIASES = {
    "x86_64": "amd64",
    "amd64": "amd64",
    "aarch64": "arm64",
    "arm64": "arm64",
}
# The extension backend can run with a PATH that omits ~/.local/bin.
_AGY_BIN_CANDIDATES = (
    Path.home() / ".local" / "bin" / "agy",
    Path("/usr/local/bin/agy"),
)
# Refresh the access token this long before its recorded expiry.
_TOKEN_REFRESH_MARGIN = timedelta(seconds=60)

# Tier ids the quota API uses for paid Google One subscriptions.
_PAID_PLAN_IDS = {
    "g1-free-tier": "free",
    "g1-pro-tier": "pro",
    "g1-ultra-tier": "ultra",
}


# ==================== Client identity ====================


@functools.lru_cache(maxsize=1)
def _agy_binary() -> str | None:
    """Locate the CLI without relying on the caller's PATH."""
    found = shutil.which("agy")
    if found:
        return found
    for candidate in _AGY_BIN_CANDIDATES:
        if candidate.is_file():
            return str(candidate)
    return None


@functools.lru_cache(maxsize=1)
def _agy_version() -> str:
    """Version reported by ``agy --version`` (offline, ~80 ms, cached)."""
    binary = _agy_binary()
    if not binary:
        return _AGY_UA_FALLBACK_VERSION
    try:
        proc = subprocess.run(
            [binary, "--version"],
            capture_output=True,
            text=True,
            timeout=_AGY_UA_TIMEOUT,
            check=False,
        )
        match = _VERSION_RE.search(proc.stdout or "")
        if match:
            return match.group(0)
    except (OSError, subprocess.SubprocessError):
        pass
    return _AGY_UA_FALLBACK_VERSION


def _agy_user_agent() -> str:
    """User-Agent the quota endpoints accept as the Antigravity client."""
    os_type = {"darwin": "darwin", "win32": "windows"}.get(sys.platform, sys.platform)
    machine = platform.machine().lower()
    arch = _ARCH_ALIASES.get(machine, machine or "amd64")
    return (
        f"antigravity/cli/{_agy_version()} (aidev_client; os_type={os_type}; "
        f"arch={arch}; cl={_AGY_UA_CLIENT}; auth_method=consumer)"
    )
# Both endpoints return small JSON objects; cap the read so a broken endpoint
# cannot make us buffer an unbounded response.
_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

# In-process refreshed-token cache, so repeated calls in one process (e.g.
# --watch) do not re-hit the token endpoint before the disk cache expires.
_cached_access: dict = {}


# ==================== Client credentials config ====================


def load_gemini_config(config_path: Path | None = None) -> dict:
    """Read the OAuth client credentials from ``~/.config/agent-quota/gemini.conf``.

    The file is optional: a stored access token that is still valid never
    needs it. Missing, blank, unreadable, or unknown entries simply leave the
    corresponding key ``None``; the caller decides whether that is fatal (it
    only is when a refresh is actually required).
    """
    path = config_path or CONFIG_PATH
    config: dict = {key: None for key in _CONFIG_KEYS}

    try:
        contents = path.read_text()
    except OSError:
        # Absent or unreadable: report the keys as missing rather than
        # leaking a raw filesystem error from deep inside the fetch path.
        return config

    for line in contents.splitlines():
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


# ==================== Token loading ====================


def _read_keyring_token() -> dict | None:
    """Read the agy token from the platform Secret Service (Linux)."""
    try:
        import secretstorage
    except ImportError:
        return None
    try:
        conn = secretstorage.dbus_init()
        collection = secretstorage.get_default_collection(conn)
        for item in collection.get_all_items():
            attrs = item.get_attributes()
            if (
                attrs.get("service") == KEYRING_SERVICE
                and attrs.get("username") == KEYRING_ACCOUNT
            ):
                return json.loads(item.get_secret().decode("utf-8"))
    except Exception:
        # Keyring locked, daemon absent, malformed payload — fall through.
        return None
    return None


def _read_legacy_token_file() -> dict | None:
    """Read the legacy ``antigravity-oauth-token`` file, if present."""
    try:
        return json.loads(LEGACY_TOKEN_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _load_token_data() -> dict:
    """Return the stored credential payload (the JSON agy writes)."""
    for source in (_read_keyring_token, _read_legacy_token_file):
        data = source()
        if isinstance(data, dict) and isinstance(data.get("token"), dict):
            return data
    raise RuntimeError(
        "No Antigravity OAuth token found (looked in the platform keyring "
        f"under service {KEYRING_SERVICE!r} and in {LEGACY_TOKEN_PATH}). "
        "Run `agy` once and sign in with Google."
    )


def _parse_expiry(raw: object) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        return datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _client_credentials() -> tuple[str, str]:
    """Return the configured OAuth client id and secret, or explain what is missing.

    Called lazily, only from the refresh branch of ``_resolve_access_token``:
    an unexpired stored token must keep working on machines that never create
    ``~/.config/agent-quota/gemini.conf``.
    """
    config = load_gemini_config()
    client_id = config.get("GEMINI_CLIENT_ID")
    client_secret = config.get("GEMINI_CLIENT_SECRET")
    missing = [
        key
        for key, value in (
            ("GEMINI_CLIENT_ID", client_id),
            ("GEMINI_CLIENT_SECRET", client_secret),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(
            "Antigravity access token is expired and its OAuth client "
            f"credentials are not configured ({', '.join(missing)} missing in "
            f"{CONFIG_PATH}). Add GEMINI_CLIENT_ID and GEMINI_CLIENT_SECRET to "
            "that file, or run `agy` once to sign in again."
        )
    return str(client_id), str(client_secret)


def _refresh_access_token(
    refresh_token: str, client_id: str, client_secret: str
) -> dict:
    """Exchange the refresh token for a fresh access token."""
    resp = requests.post(
        _TOKEN_URL,
        json={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        },
        timeout=REQUEST_TIMEOUT,
        impersonate="chrome",
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Token refresh failed with HTTP {resp.status_code}. "
            "Run `agy` once to sign in again."
        )
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise RuntimeError("Token refresh response had no access_token.")
    return payload


def _resolve_access_token() -> str:
    """Return a usable access token, refreshing when stale.

    A refreshed token is only held in memory; we never write back to the
    keyring or the CLI's token file.
    """
    cached = _cached_access.get("access_token")
    cached_expiry = _cached_access.get("expires_monotonic")
    if (
        isinstance(cached, str)
        and isinstance(cached_expiry, float)
        and time.monotonic() < cached_expiry
    ):
        return cached

    data = _load_token_data()
    token = data["token"]
    access_token = token.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise RuntimeError("Stored Antigravity token had no access_token.")

    expiry = _parse_expiry(token.get("expiry"))
    needs_refresh = expiry is None or datetime.now(timezone.utc) >= (
        expiry - _TOKEN_REFRESH_MARGIN
    )
    if needs_refresh:
        refresh_token = token.get("refresh_token")
        if not isinstance(refresh_token, str) or not refresh_token:
            raise RuntimeError(
                "Antigravity access token is expired and no refresh token is "
                "stored. Run `agy` once to sign in again."
            )
        client_id, client_secret = _client_credentials()
        payload = _refresh_access_token(refresh_token, client_id, client_secret)
        access_token = payload["access_token"]
        _cached_access["access_token"] = access_token
        _cached_access["expires_monotonic"] = time.monotonic() + float(
            payload.get("expires_in", 3600)
        ) - _TOKEN_REFRESH_MARGIN.total_seconds()
    return access_token


def _account_email(token_data: dict) -> str:
    """Best-effort email from the stored id_token (no extra request)."""
    id_token = token_data.get("id_token")
    if not isinstance(id_token, str) or id_token.count(".") < 2:
        return ""
    try:
        payload_b64 = id_token.split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        email = claims.get("email")
        return email if isinstance(email, str) else ""
    except Exception:
        return ""


# ==================== Quota fetching ====================


def _read_project_id() -> str:
    """Fallback project id from the CLI's workspace cache.

    This is the CLI's workspace project, not the Code Assist project, so it
    is only used when ``loadCodeAssist`` gives us nothing. A single space is
    accepted by the API when the file is missing.
    """
    try:
        return PROJECT_ID_PATH.read_text(encoding="utf-8").strip() or " "
    except OSError:
        return " "


def _post_quota(host: str, access_token: str, body: dict) -> dict:
    resp = requests.post(
        host + _QUOTA_METHOD,
        json=body,
        headers={
            "Authorization": f"Bearer {access_token}",
            "User-Agent": _agy_user_agent(),
        },
        timeout=REQUEST_TIMEOUT,
        impersonate="chrome",
    )
    if resp.status_code == 401:
        raise RuntimeError(
            "401 Unauthorized on retrieveUserQuotaSummary: the Antigravity "
            "token was rejected. Run `agy` once to sign in again."
        )
    if resp.status_code == 403:
        raise RuntimeError(
            "403 Forbidden on retrieveUserQuotaSummary: no valid Antigravity "
            "license for this account (subscription required)."
        )
    resp.raise_for_status()
    payload = json.loads(resp.content[:_MAX_RESPONSE_BYTES])
    if not isinstance(payload, dict):
        raise RuntimeError("Quota endpoint returned a non-object payload.")
    return payload


def _fetch_quota_summary(access_token: str, project: str) -> dict:
    """Try the daily host first, then production."""
    body = {"project": project}
    last_error: Exception | None = None
    for host in _QUOTA_HOSTS:
        try:
            return _post_quota(host, access_token, body)
        except RuntimeError:
            raise
        except Exception as e:
            last_error = e
    raise RuntimeError(f"Quota request failed: {last_error}")


def _fetch_model_fractions(access_token: str, project: str) -> dict | None:
    """Best-effort per-model quota from fetchAvailableModels.

    Google's summary endpoint does not always include the Gemini pool (a
    host can leave out a whole pool); the per-model endpoint still carries
    the shared 5h fraction for gemini-* models. Returns the raw ``models``
    mapping, or None when every host fails.
    """
    body = {"project": project}
    for host in _QUOTA_HOSTS:
        try:
            resp = requests.post(
                host + _MODELS_METHOD,
                json=body,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "User-Agent": _agy_user_agent(),
                },
                timeout=REQUEST_TIMEOUT,
                impersonate="chrome",
            )
            resp.raise_for_status()
            payload = json.loads(resp.content[:_MAX_RESPONSE_BYTES])
            models = payload.get("models") if isinstance(payload, dict) else None
            if isinstance(models, dict) and models:
                return models
        except Exception:
            continue
    return None


def _worst_gemini_bucket(models: dict) -> dict | None:
    """Pick the lowest remainingFraction across gemini-* models.

    All Gemini models share one 5h pool, so per-model fractions agree; the
    minimum is the honest value when they ever drift.
    """
    worst: dict | None = None
    for model_id, entry in models.items():
        if "gemini" not in str(model_id).lower():
            continue
        if not isinstance(entry, dict):
            continue
        quota = entry.get("quotaInfo")
        if not isinstance(quota, dict):
            continue
        try:
            fraction = max(0.0, min(1.0, float(quota["remainingFraction"])))
        except (KeyError, TypeError, ValueError):
            continue
        if worst is None or fraction < worst["fraction"]:
            worst = {"fraction": fraction, "reset_at": str(quota.get("resetTime") or "")}
    if worst is None:
        return None
    return {
        "bucket_id": "gemini-5h",
        "display_name": "Five Hour Limit Remaining",
        "window": "5h",
        "reset_at": worst["reset_at"],
        "usage_percent": round((1.0 - worst["fraction"]) * 100.0, 2),
    }


def _ensure_gemini_pool(
    groups: list, access_token: str, project: str, fetch_model_fractions=None
) -> list:
    """Backfill a Gemini 5h bucket from per-model data when missing.

    The summary endpoint normally carries the whole Gemini pool; this stays
    as a safety net for hosts that omit it. The per-model endpoint only
    exposes the shared 5h window, so nothing is invented for the weekly one.
    """
    if fetch_model_fractions is None:
        fetch_model_fractions = _fetch_model_fractions

    def is_gemini_group(group: object) -> bool:
        return (
            isinstance(group, dict)
            and _short_group_name(str(group.get("name") or "")) == "Gemini"
        )

    for group in groups:
        if not is_gemini_group(group):
            continue
        for bucket in group.get("buckets") or []:
            if isinstance(bucket, dict) and _window_label(bucket) == "5h":
                return groups  # Summary already carries the Gemini 5h pool.

    models = fetch_model_fractions(access_token, project)
    if not models:
        return groups
    bucket = _worst_gemini_bucket(models)
    if bucket is None:
        return groups
    for group in groups:
        if is_gemini_group(group):
            group.setdefault("buckets", []).append(bucket)
            return groups
    groups.append({"name": "Gemini Models", "buckets": [bucket]})
    return groups


def _tier_fields(tier: object) -> dict:
    if not isinstance(tier, dict):
        return {}
    return {"id": str(tier.get("id") or ""), "name": str(tier.get("name") or "")}


def _fetch_code_assist(access_token: str) -> dict:
    """Best-effort tier and Code Assist project via loadCodeAssist.

    Mirrors the CLI (daily host first, then production) and returns ``{}``
    on any failure. ``cloudaicompanionProject`` is the project the quota
    endpoints expect; ``paidTier`` describes the paid subscription (Google
    One AI) while ``currentTier`` only carries the Code Assist tier.
    """
    body = {
        "metadata": {
            "ideType": "IDE_UNSPECIFIED",
            "platform": "PLATFORM_UNSPECIFIED",
            "pluginType": "GEMINI",
        }
    }
    for host in _QUOTA_HOSTS:
        try:
            resp = requests.post(
                host + _CODE_ASSIST_METHOD,
                json=body,
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "User-Agent": _agy_user_agent(),
                },
                timeout=REQUEST_TIMEOUT,
                impersonate="chrome",
            )
            resp.raise_for_status()
            payload = resp.json()
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        project = payload.get("cloudaicompanionProject")
        return {
            "tier": _tier_fields(payload.get("currentTier")),
            "paid_tier": _tier_fields(payload.get("paidTier")),
            "project": project if isinstance(project, str) else "",
        }
    return {}


def _normalize_plan_id(tier_id: str) -> str:
    """``g1-pro-tier`` -> ``pro``; unknown ids keep their readable tail."""
    text = str(tier_id or "").strip().lower()
    if not text:
        return ""
    known = _PAID_PLAN_IDS.get(text)
    if known:
        return known
    if text.startswith("g1-"):
        text = text[3:]
    if text.endswith("-tier"):
        text = text[: -len("-tier")]
    return text


# ==================== Normalization ====================


def _short_group_name(display_name: str) -> str:
    """Map a quota group title to a compact label fragment.

    ``Gemini Models`` -> ``Gemini``; ``Claude and GPT models`` ->
    ``Claude/GPT``; ``Gemini 4 Argon`` -> ``Argon``; anything else keeps its
    first word.
    """
    known = {
        "gemini models": "Gemini",
        "claude and gpt models": "Claude/GPT",
        "claude and gpt": "Claude/GPT",
        "gemini 4 argon": "Argon",
    }
    lowered = display_name.strip().lower()
    if lowered in known:
        return known[lowered]
    return display_name.strip().split()[0] if display_name.strip() else "Quota"


def _window_label(bucket: dict) -> str:
    window = str(bucket.get("window") or "")
    bucket_id = str(bucket.get("bucket_id") or "")
    if window == "5h" or bucket_id.endswith("-5h") or "five hour" in window.lower():
        return "5h"
    if window == "weekly" or bucket_id.endswith("-weekly"):
        return "Weekly"
    return window.replace("_", " ").title() if window else "Window"


def _parse_summary(payload: dict) -> list[dict]:
    """Extract per-group normalized buckets from the endpoint payload."""
    groups: list[dict] = []
    raw_groups = payload.get("groups")
    if not isinstance(raw_groups, list):
        return groups
    for raw_group in raw_groups:
        if not isinstance(raw_group, dict):
            continue
        name = str(raw_group.get("displayName") or "Quota")
        buckets: list[dict] = []
        raw_buckets = raw_group.get("buckets")
        if isinstance(raw_buckets, list):
            for raw_bucket in raw_buckets:
                if not isinstance(raw_bucket, dict):
                    continue
                fraction = raw_bucket.get("remainingFraction")
                if fraction is None:
                    continue
                try:
                    remaining = max(0.0, min(1.0, float(fraction)))
                except (TypeError, ValueError):
                    continue
                buckets.append(
                    {
                        "bucket_id": str(raw_bucket.get("bucketId") or ""),
                        "display_name": str(raw_bucket.get("displayName") or ""),
                        "window": str(raw_bucket.get("window") or ""),
                        "reset_at": str(raw_bucket.get("resetTime") or ""),
                        "usage_percent": round((1.0 - remaining) * 100.0, 2),
                    }
                )
        groups.append({"name": name, "buckets": buckets})
    return groups


def gemini_usage_windows(usage: dict) -> list[tuple[str, dict]]:
    """Return all parsed windows as ``(label, window)`` rows for renderers.

    Labels are prefixed with the (shortened) group name so multiple pools
    stay unambiguous: e.g. ``Gemini 5h``, ``Claude/GPT Weekly``.
    """
    groups = usage.get("groups") if isinstance(usage, dict) else None
    rows: list[tuple[str, dict]] = []
    if not isinstance(groups, list):
        return rows
    for group in groups:
        if not isinstance(group, dict):
            continue
        prefix = _short_group_name(str(group.get("name") or ""))
        for bucket in group.get("buckets") or []:
            if not isinstance(bucket, dict) or "usage_percent" not in bucket:
                continue
            rows.append((f"{prefix} {_window_label(bucket)}", bucket))
    return rows


def _api_identity(token_data: dict, code_assist: dict) -> dict:
    # A paid subscription (paidTier) outranks the Code Assist tier reported
    # in currentTier -- the precedence gemini-cli uses. Without this a Pro
    # account is labelled "free-tier" because currentTier stays free-tier.
    paid = code_assist.get("paid_tier") or {}
    current = code_assist.get("tier") or {}
    return {
        "plan": _normalize_plan_id(paid.get("id") or current.get("id") or ""),
        "plan_name": paid.get("name") or current.get("name") or "",
        "email": _account_email(token_data),
        "source": "agy oauth",
    }


def _fetch_gemini_usage_uncached() -> dict:
    token_data = _load_token_data()
    access_token = _resolve_access_token()
    code_assist = _fetch_code_assist(access_token)
    project = code_assist.get("project") or _read_project_id()

    last_error: Exception | None = None
    for attempt in range(MAX_REQUEST_ATTEMPTS):
        try:
            payload = _fetch_quota_summary(access_token, project)
            groups = _parse_summary(payload)
            if not groups:
                raise RuntimeError(
                    "Could not parse any quota groups from "
                    "retrieveUserQuotaSummary."
                )
            groups = _ensure_gemini_pool(groups, access_token, project)
            return {
                "groups": groups,
                "identity": _api_identity(token_data, code_assist),
            }
        except RuntimeError:
            raise
        except Exception as e:
            last_error = e
            if attempt < MAX_REQUEST_ATTEMPTS - 1:
                time.sleep(attempt + 1)
    raise RuntimeError(f"Request failed: {last_error}")


def get_gemini_usage(browsers: list[str] | None = None) -> dict:
    # ``browsers`` is accepted for call-site compatibility; this provider
    # uses agy's stored OAuth token and never browser cookies.
    return get_cached_or_fetch("gemini", _fetch_gemini_usage_uncached, ttl=CACHE_TTL)


# ==================== Standalone CLI ====================


def print_cli(usage: dict) -> None:
    identity = usage.get("identity") if isinstance(usage, dict) else None
    if isinstance(identity, dict):
        plan = identity.get("plan_name") or identity.get("plan") or "Unknown"
        print(f"Plan              : {plan}")
        if identity.get("email"):
            print(f"User              : {identity['email']}")

    for label, w in gemini_usage_windows(usage):
        used = float(w["usage_percent"])
        remaining = max(0.0, 100.0 - used)
        reset = format_eta(w["reset_at"]) if w.get("reset_at") else "—"
        print(f"{label:<20} : {round(remaining):>3}% remaining  (Reset in {reset})")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Print Gemini (Antigravity) quota to terminal."
    )
    parser.add_argument(
        "--json", action="store_true", help="Print the raw normalized payload."
    )
    args = parser.parse_args()

    try:
        usage = get_gemini_usage()
    except Exception as e:
        print(f"[!] {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(usage, indent=1, ensure_ascii=False))
    else:
        print_cli(usage)


if __name__ == "__main__":
    main()
