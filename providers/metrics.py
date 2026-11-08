"""Neutral metric model and formatting helpers shared by adapters.

Both the ``agent_quota`` entrypoint and individual provider modules import
from here, so provider modules never need to import ``agent_quota``.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from common import format_eta


# Z.ai renamed the Coding Plan token window type from TOKENS_LIMIT to
# CREDIT_LIMIT; both carry the same shape (unit 3 = 5h window, unit 6 = 7d
# window, no unit = legacy single window).  Keep every consumer on this tuple.
# It lives here, not in providers.zai, so agent_quota can use it without
# importing the Z.ai provider module.
TOKEN_LIMIT_TYPES = ("TOKENS_LIMIT", "CREDIT_LIMIT")


@dataclass
class Metric:
    label: str
    value: str
    pct: float | None = None
    reset: str = "—"
    is_remaining: bool = False
    is_blocking_period: bool = False
    muted: bool = False
    # Balance-backed quotas (for example Codex workspace credits) stay visible
    # when a provider-wide window is exhausted, so they are never muted.
    is_credit: bool = False
    # Balance is zero: the bar keeps its percentage but renders neutral gray.
    insufficient: bool = False


def pad_reset(eta_str: str) -> str:
    """Pad ETA string to fixed width with zero-padding on numbers (e.g., '1h01m' -> '01h01m', '1d' -> '01d', '4d21h' -> '04d21h')."""
    if not eta_str or eta_str == "—" or eta_str.startswith("0′"):
        return eta_str
    sub_minute = re.fullmatch(r"0m(\d{2})s", eta_str)
    if sub_minute:
        # format_eta's sub-minute reset ("0m00s" is an already-passed one).
        # Keep the seconds in the "0′SS″" form of the missing-reset zero so a
        # reset 30 s away never reads like "00m".
        return f"0′{sub_minute.group(1)}″"
    match = re.match(r"^(\d+)([a-z])(\d*)([a-z]?)$", eta_str)
    if not match:
        return eta_str
    val1, unit1, val2, unit2 = match.groups()
    val1 = int(val1)
    val2 = int(val2) if val2 else 0

    if unit1 == "d":
        suffix = f"{val2:02d}{unit2}" if val2 else ""
        return f"{val1:02d}d{suffix}"
    elif unit1 == "h":
        return f"{val1:02d}h{val2:02d}m"
    elif unit1 == "m":
        return f"{val1:02d}m"
    else:
        return eta_str


def window_reset(win) -> str:
    if not win.resets_at:
        return "—"
    return pad_reset(format_eta(win.resets_at))


def is_weekly_window(raw_window: object) -> bool:
    if not isinstance(raw_window, dict):
        return False
    try:
        return int(raw_window.get("limit_window_seconds", 0)) == 7 * 24 * 60 * 60
    except (TypeError, ValueError):
        return False


def format_plan_value(value) -> str:
    if value in (None, ""):
        return "Unknown"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).strip()
    if not text:
        return "Unknown"
    text = text.replace("_", " ").replace("-", " ")
    lowered = " ".join(word.lower() for word in text.split())
    known = {
        "pro": "Pro",
        "prolite": "Pro Lite",
        "team": "Team",
        "plus": "Plus",
        "free": "Free",
        "hc": "Enterprise",
        "enterprise": "Enterprise",
        "business": "Business",
        "individual": "Individual",
        "personal": "Personal",
    }
    if lowered in known:
        return known[lowered]
    return " ".join(word.capitalize() for word in text.split())
