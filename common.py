"""Common utilities shared by all provider modules."""
from __future__ import annotations

import configparser
import glob
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Mapping, Optional, TypeVar, cast

import browser_cookie3


DEFAULT_BROWSERS = ("chrome", "chromium", "brave", "edge", "firefox", "helium")


# Cache configuration
CACHE_DIR = Path.home() / ".cache" / "agent-quota"
CACHE_TTL = 60  # Cache valid for 60 seconds
T = TypeVar("T")


def get_cached_or_fetch(
    cache_name: str,
    fetch_func: Callable[[], T],
    ttl: int = CACHE_TTL
) -> T:
    """
    Get data from cache if fresh, otherwise fetch and cache.

    The cross-process locking via .updating markers is kept so the cache
    behaves correctly when --watch is run concurrently with one-shot calls.

    Args:
        cache_name: Name of cache file (e.g., "claude", "codex")
        fetch_func: Function to call to fetch fresh data
        ttl: Cache time-to-live in seconds

    Returns:
        Cached or freshly fetched data
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    cache_file = CACHE_DIR / f"{cache_name}.json"
    updating_file = CACHE_DIR / f"{cache_name}.updating"

    # Check if cache is fresh
    if cache_file.exists():
        cache_age = time.time() - cache_file.stat().st_mtime
        if cache_age < ttl:
            # Cache is fresh, use it
            try:
                with open(cache_file, 'r') as f:
                    return cast(T, json.load(f))
            except Exception:
                # Cache file corrupted, proceed to fetch
                pass

    # Check if another process is already updating
    if updating_file.exists():
        update_age = time.time() - updating_file.stat().st_mtime
        # If update marker is older than 5 seconds, assume stale and proceed
        if update_age < 5:
            # Wait briefly for the other process to finish
            for _ in range(6):  # Wait up to 3 seconds (6 * 0.5s)
                time.sleep(0.5)
                if cache_file.exists():
                    cache_age = time.time() - cache_file.stat().st_mtime
                    if cache_age < ttl + 10:  # Accept slightly older cache when waiting
                        try:
                            with open(cache_file, 'r') as f:
                                return cast(T, json.load(f))
                        except Exception:
                            pass

    # Need to fetch fresh data
    # Create updating marker
    try:
        updating_file.touch()
    except Exception:
        pass

    try:
        # Fetch fresh data
        data = fetch_func()

        # Save to cache
        try:
            with open(cache_file, 'w') as f:
                json.dump(data, f)
        except Exception:
            # Failed to save cache, but we have the data
            pass

        return data

    finally:
        # Always remove updating marker
        try:
            updating_file.unlink(missing_ok=True)
        except Exception:
            pass


def helium(cookie_file=None, domain_name="", key_file=None):
    """Returns a cookiejar of the cookies used by Helium browser.

    Helium is a Chromium-based browser, so we use the chromium loader
    with Helium's cookie file path.
    """
    import os
    if cookie_file is None:
        cookie_file = os.path.expanduser("~/.config/net.imput.helium/Default/Cookies")
    return browser_cookie3.chromium(cookie_file=cookie_file, domain_name=domain_name, key_file=key_file)


def _firefox_xdg_fallback(domain: str):
    """Try ~/.config/mozilla/firefox when browser_cookie3 can't find the profile.

    Newer distros (Arch, Fedora, etc.) put Firefox data under XDG_CONFIG_HOME
    instead of ~/.mozilla. browser_cookie3 doesn't check this path, so we
    locate cookies.sqlite ourselves and pass it via cookie_file=.
    """
    xdg_dir = os.path.expanduser("~/.config/mozilla/firefox")
    if not os.path.isdir(xdg_dir):
        return None
    # Reuse browser_cookie3's profile.ini parsing to find the default profile
    try:
        profile_path = browser_cookie3.Firefox.get_default_profile(xdg_dir)
        cookie_files = glob.glob(os.path.join(profile_path, "cookies.sqlite"))
        if cookie_files:
            return browser_cookie3.firefox(cookie_file=cookie_files[0], domain_name=domain)
    except Exception:
        return None
    return None


def load_cookie_candidates(
    domain: str, browsers: Iterable[str] | None = None
) -> list[tuple[dict, str]]:
    """Load all non-empty cookie jars for a domain, in browser preference order."""
    browsers = list(browsers or DEFAULT_BROWSERS)
    errors: list[str] = []
    candidates: list[tuple[dict, str]] = []

    for name in browsers:
        # First check if we have a local implementation (e.g., helium)
        loader = globals().get(name)
        if loader is None:
            # Fall back to browser_cookie3
            loader = getattr(browser_cookie3, name, None)
        if loader is None:
            errors.append(f"{name}: unsupported by browser_cookie3")
            continue

        try:
            cj = loader(domain_name=domain)
            cookies = {c.name: c.value for c in cj}
        except Exception as exc:
            # Workaround: browser_cookie3 doesn't check ~/.config/mozilla/firefox
            # which is the default on newer distros following XDG Base Directory spec.
            # See https://github.com/NihilDigit/waybar-ai-usage/issues/9
            if name == "firefox":
                cj = _firefox_xdg_fallback(domain)
                if cj is not None:
                    cookies = {c.name: c.value for c in cj}
                    if cookies:
                        candidates.append((cookies, name))
                        continue
            errors.append(f"{name}: {exc}")
            continue

        if cookies:
            candidates.append((cookies, name))
            continue

        errors.append(f"{name}: no cookies found")

    if candidates:
        return candidates
    detail = "; ".join(errors) if errors else "no browsers provided"
    raise RuntimeError(f"Failed to read cookies for {domain}: {detail}")


def load_cookies(domain: str, browsers: Iterable[str] | None = None) -> tuple[dict, str]:
    """Load cookies for a domain from the first available browser in order."""
    return load_cookie_candidates(domain, browsers)[0]


@dataclass
class WindowUsage:
    """Usage information for a time window."""
    utilization: float
    resets_at: Optional[str | int]


def parse_window_percent(raw: Mapping[str, object] | None, key: str = "utilization") -> WindowUsage:
    """Parse window where Claude returns utilization as 0–100% (may be float)."""
    raw = raw or {}
    util = raw.get(key)
    raw_resets = raw.get("resets_at")
    resets = raw_resets if isinstance(raw_resets, (str, int)) else None

    if isinstance(util, (str, int, float)):
        try:
            util_f = float(util)
        except ValueError:
            util_f = 0.0
    else:
        util_f = 0.0

    return WindowUsage(utilization=util_f, resets_at=resets)


def parse_window_direct(raw: Mapping[str, object] | None) -> WindowUsage:
    """Parse window where used_percent is already 0-100 - used by ChatGPT."""
    raw = raw or {}
    used = raw.get("used_percent")
    raw_reset_at = raw.get("reset_at")
    reset_at = raw_reset_at if isinstance(raw_reset_at, (str, int)) else None

    if isinstance(used, (str, int, float)):
        try:
            used_f = float(used)
        except ValueError:
            used_f = 0.0
    else:
        used_f = 0.0

    return WindowUsage(utilization=used_f, resets_at=reset_at)


def format_eta(reset_at: str | int | None) -> str:
    """Format ETA from ISO string or Unix timestamp -> '4h19′' or '19′30″'."""
    if not reset_at:
        return "0′00″"

    try:
        # Handle both ISO string and Unix timestamp
        if isinstance(reset_at, str):
            if reset_at.endswith('Z'):
                reset_at = reset_at[:-1] + '+00:00'
            reset_dt = datetime.fromisoformat(reset_at)
        else:
            reset_dt = datetime.fromtimestamp(reset_at, tz=timezone.utc)

        now = datetime.now(timezone.utc)
        delta = reset_dt - now
    except Exception:
        return "??′??″"

    secs = int(delta.total_seconds())
    if secs <= 0:
        return "0m00s"

    # Show days+hours if > 24 hours
    if secs >= 86400:  # 24 * 3600
        days = secs // 86400
        hours = (secs % 86400) // 3600
        return f"{days}d{hours:02}h"

    # Show hours+minutes if > 1 hour
    if secs >= 3600:
        hours = secs // 3600
        mins = (secs % 3600) // 60
        return f"{hours}h{mins:02}m"

    # Show minutes+seconds
    mins = secs // 60
    secs_rem = secs % 60
    return f"{mins}m{secs_rem:02}s"
