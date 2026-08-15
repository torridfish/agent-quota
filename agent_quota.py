"""agent-quota: show subscription, rate-limit, and quota status in terminal tables."""

from __future__ import annotations

import argparse
import json
import sys
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from rich.console import Console, ConsoleOptions, Group, RenderResult
from rich.live import Live
from rich.measure import Measurement
from rich.prompt import Confirm, Prompt
from rich.table import Table
from rich.text import Text

from common import format_eta, parse_window_direct, parse_window_percent

CONFIG_PATH = Path("~/.config/agent-quota/config.toml").expanduser()


@dataclass(frozen=True)
class ProviderMeta:
    name: str
    desc: str
    mode: str  # usage | payg
    secret_key: str | None = None
    secret_path: Path | None = None
    secret_label: str | None = None


# Static metadata used by setup/picker. Keep ordered — setup walks this dict
# in registration order, which is also the table row order within each section.
PROVIDER_META: dict[str, ProviderMeta] = {
    "claude": ProviderMeta(
        "Claude", "Claude.ai 5h / 7d subscription windows (browser cookies)", "usage"
    ),
    "codex": ProviderMeta(
        "Codex", "ChatGPT Codex included usage limits (browser cookies)", "usage"
    ),
    "copilot": ProviderMeta(
        "Copilot",
        "GitHub Copilot monthly included premium requests (PAT or browser cookies)",
        "usage",
        "GITHUB_TOKEN",
        Path("~/.config/agent-quota/copilot.conf").expanduser(),
        "GitHub PAT",
    ),
    "zai": ProviderMeta(
        "Z.ai",
        "Z.ai 5h token window / monthly tool quota (API token)",
        "usage",
        "ZAI_TOKEN",
        Path("~/.config/agent-quota/zai.conf").expanduser(),
        "Z.ai API token",
    ),
    "go": ProviderMeta(
        "OpenCode",
        "OpenCode Go 5h / weekly / monthly subscription usage (browser cookies)",
        "usage",
    ),
    "zen": ProviderMeta(
        "OpenCode Zen",
        "OpenCode Zen prepaid balance (browser cookies)",
        "payg",
    ),
    "openrouter": ProviderMeta(
        "OpenRouter",
        "OpenRouter prepaid credits and balance (management key)",
        "payg",
        "OPENROUTER_API_KEY",
        Path("~/.config/agent-quota/openrouter.conf").expanduser(),
        "OpenRouter management key",
    ),
    "deepseek": ProviderMeta(
        "DeepSeek",
        "DeepSeek API balance (API key)",
        "payg",
        "DEEPSEEK_API_KEY",
        Path("~/.config/agent-quota/deepseek.conf").expanduser(),
        "DeepSeek API key",
    ),
}


# ===== Normalized data model =====


@dataclass
class Metric:
    label: str
    value: str
    pct: float | None = None
    reset: str = "—"
    is_remaining: bool = False
    is_blocking_period: bool = False
    muted: bool = False


@dataclass
class ProviderStatus:
    key: str
    name: str
    mode: str
    plan: str = ""
    user: str = ""
    source: str = ""
    state: str = "ok"  # ok | auth_err | net_err
    metrics: list[Metric] = field(default_factory=list)
    error: str = ""
    workspace_id: str = ""


# ===== Adapters: provider raw dict -> Metric list =====


def _pad_reset(eta_str: str) -> str:
    """Pad ETA string to fixed width with zero-padding on numbers (e.g., '1h01m' -> '01h01m', '1d' -> '01d', '4d21h' -> '04d21h')."""
    import re

    if eta_str == "—" or eta_str.startswith("0′"):
        return eta_str
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


def _window_reset(win) -> str:
    if not win.resets_at:
        return "—"
    return _pad_reset(format_eta(win.resets_at))


def _is_weekly_window(raw_window: object) -> bool:
    if not isinstance(raw_window, dict):
        return False
    try:
        return int(raw_window.get("limit_window_seconds", 0)) == 7 * 24 * 60 * 60
    except (TypeError, ValueError):
        return False


def _adapt_claude(raw: dict) -> list[Metric]:
    from providers.claude import claude_limit_windows

    metrics = []
    for label, raw_limit in claude_limit_windows(raw):
        key = "percent" if "percent" in raw_limit else "utilization"
        win = parse_window_percent(raw_limit, key=key)
        pct = max(0.0, min(100.0, 100.0 - win.utilization))
        metrics.append(
            Metric(
                label,
                f"{pct:.0f}%",
                pct,
                _window_reset(win),
                is_remaining=True,
                is_blocking_period=label == "7d",
            )
        )
    return metrics


def _adapt_codex(raw: dict) -> list[Metric]:
    from providers.codex import codex_rate_limit_windows_with_scope

    metrics = []
    for label, raw_window, provider_wide in codex_rate_limit_windows_with_scope(raw):
        window = parse_window_direct(raw_window)
        remaining = max(0.0, min(100.0, 100.0 - window.utilization))
        metrics.append(
            Metric(
                label,
                f"{remaining:.0f}%",
                remaining,
                _window_reset(window),
                is_remaining=True,
                is_blocking_period=provider_wide and _is_weekly_window(raw_window),
            )
        )
    return metrics


def _copilot_reset() -> str:
    # Premium quota refills at the start of each calendar month (UTC).
    now = datetime.now(timezone.utc)
    year, month = (now.year + 1, 1) if now.month == 12 else (now.year, now.month + 1)
    return _pad_reset(
        format_eta(datetime(year, month, 1, tzinfo=timezone.utc).isoformat())
    )


def _adapt_copilot_factory(quota: int):
    def adapt(raw: dict) -> list[Metric]:
        reset = _copilot_reset()
        if "pct" in raw:
            used_pct = float(raw["pct"])
            pct = max(0.0, min(100.0, 100.0 - used_pct))
            used = raw.get("used")
            total = raw.get("total")
            if used is not None and total is not None:
                remaining = max(0.0, float(total) - float(used))
                value = f"{remaining:g} / {float(total):g}"
            else:
                value = f"{pct:.0f}%"
            return [Metric("Premium", value, pct, reset, is_remaining=True)]
        used = float(raw.get("used", 0.0))
        pct = (max(0.0, quota - used) / quota * 100) if quota > 0 else None
        value = f"{max(0.0, quota - used):g} / {quota}" if quota > 0 else f"{used:g}"
        return [Metric("Premium", value, pct, reset, is_remaining=quota > 0)]

    return adapt


def _fmt_tokens(v: float | int) -> str:
    v = int(v)
    if v >= 1_000_000:
        return f"{v / 1_000_000:.1f}M"
    if v >= 1_000:
        return f"{v / 1_000:.1f}K"
    return str(v)


def _ms_reset(ms: int | None) -> str:
    if not ms:
        return "—"
    return _pad_reset(format_eta(ms // 1000))


def _adapt_zai(raw: dict) -> list[Metric]:
    metrics: list[Metric] = []
    limits = raw.get("limits")
    if not isinstance(limits, list):
        # Compatibility with cached/provider payloads from before all token
        # windows were preserved.
        limits = [
            item
            for item in (
                raw.get("token_limit"),
                raw.get("weekly_limit"),
                raw.get("time_limit"),
            )
            if isinstance(item, dict)
        ]

    def order(item: dict) -> int:
        if item.get("type") == "TOKENS_LIMIT" and item.get("unit") == 3:
            return 0
        if item.get("type") == "TOKENS_LIMIT" and item.get("unit") == 6:
            return 1
        if item.get("type") == "TIME_LIMIT":
            return 2
        return 3

    for limit in sorted((item for item in limits if isinstance(item, dict)), key=order):
        used_pct = float(limit.get("percentage", 0))
        pct = max(0.0, min(100.0, 100.0 - used_pct))
        limit_type = limit.get("type")
        unit = limit.get("unit")

        if limit_type == "TOKENS_LIMIT":
            label = "5h" if unit == 3 else "Weekly" if unit == 6 else "Tokens"
            value = f"{pct:.0f}%"
        elif limit_type == "TIME_LIMIT":
            label = "MCP"
            current = limit.get("currentValue")
            total = limit.get("usage")
            remaining = limit.get("remaining")
            if remaining is None and current is not None and total is not None:
                remaining = max(0.0, float(total) - float(current))
            if remaining is not None and total is not None:
                value = f"{float(remaining):g} / {float(total):g}"
            elif remaining is not None:
                value = f"{float(remaining):g} left"
            else:
                value = f"{pct:.0f}%"
        else:
            continue

        metrics.append(
            Metric(
                label,
                value,
                pct,
                _ms_reset(limit.get("nextResetTime")),
                is_remaining=True,
                is_blocking_period=limit_type == "TOKENS_LIMIT" and unit == 6,
            )
        )

    return metrics


def _adapt_zen(raw: dict) -> list[Metric]:
    bal = float(raw.get("balance", 0.0))
    return [Metric("Balance", f"${bal:.2f}", None, "—")]


def _adapt_go(raw: dict) -> list[Metric]:
    from providers.go import go_usage_windows

    metrics: list[Metric] = []
    for label, w in go_usage_windows(raw):
        used_pct = float(w["usage_percent"])
        pct = max(0.0, min(100.0, 100.0 - used_pct))
        reset_at = w.get("reset_at")
        reset_in_sec = w.get("reset_in_sec")
        if reset_at:
            reset = _pad_reset(format_eta(reset_at))
        elif not reset_in_sec:
            reset = "—"
        else:
            reset = _pad_reset(format_eta(time.time() + reset_in_sec))
        metrics.append(
            Metric(
                label,
                f"{pct:.0f}%",
                pct,
                reset,
                is_remaining=True,
                is_blocking_period=label == "Weekly",
            )
        )
    return metrics


def _apply_provider_constraints(metrics: list[Metric]) -> list[Metric]:
    """Mute metrics that cannot be used while a provider-wide week is empty."""
    exhausted = any(
        metric.is_blocking_period
        and metric.pct is not None
        and metric.pct <= 0.0
        for metric in metrics
    )
    for metric in metrics:
        metric.muted = (
            exhausted
            and metric.pct is not None
            and not metric.is_blocking_period
        )
    return metrics


def _find_nested_value(raw, keys: set[str]):
    if isinstance(raw, dict):
        for key, value in raw.items():
            if str(key).lower() in keys and value not in (None, ""):
                return value
        for value in raw.values():
            found = _find_nested_value(value, keys)
            if found not in (None, ""):
                return found
    elif isinstance(raw, list):
        for item in raw:
            found = _find_nested_value(item, keys)
            if found not in (None, ""):
                return found
    return None


def _format_plan_value(value) -> str:
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


def _plan_claude(raw: dict) -> str:
    identity = raw.get("identity") or {}
    value = identity.get("plan")
    plan = _format_plan_value(value)
    team_name = identity.get("team_name")
    if plan == "Team" and team_name:
        return f"Team ({team_name})"
    value = _find_nested_value(
        raw,
        {"plan", "plan_type", "subscription_plan", "subscription_tier", "tier"},
    )
    if value not in (None, ""):
        return _format_plan_value(value)
    return plan


def _user_claude(raw: dict) -> str:
    identity = raw.get("identity") or {}
    return identity.get("user_name") or identity.get("account_name") or "Unknown"


def _plan_codex(raw: dict) -> str:
    identity = raw.get("identity") or {}
    value = identity.get("plan")
    if value in (None, ""):
        session = raw.get("_session") or {}
        account = session.get("account") or {}
        value = raw.get("plan_type") or account.get("planType")
    # The usage API calls workspace seats "team", including when the session
    # is scoped to a personal account.  Browser account metadata is the more
    # precise source for the user-facing label.
    if identity.get("account_kind") == "personal":
        return "Free"
    if str(value or "").strip().lower() == "team":
        team_name = identity.get("team_name")
        return f"Business ({team_name})" if team_name else "Business"
    plan = _format_plan_value(value)
    team_name = identity.get("team_name")
    if plan == "Team" and team_name:
        return f"Team ({team_name})"
    return plan


def _user_codex(raw: dict) -> str:
    identity = raw.get("identity") or {}
    session = raw.get("_session") or {}
    user = session.get("user") or {}
    return (
        identity.get("user_name")
        or user.get("name")
        or identity.get("account_name")
        or user.get("email")
        or "Unknown"
    )


def _plan_copilot(raw: dict) -> str:
    identity = raw.get("identity") or {}
    value = identity.get("plan")
    plan = _format_plan_value(value)
    team_name = identity.get("team_name")
    if plan == "Team" and team_name:
        return f"Team ({team_name})"
    if plan != "Unknown":
        return plan
    value = _find_nested_value(raw, {"plan", "plan_type", "subscription", "tier"})
    if value not in (None, ""):
        return _format_plan_value(value)
    managed_by = (raw.get("raw") or {}).get("managed_by_name")
    if managed_by:
        return "Team"
    return "Unknown"


def _user_copilot(raw: dict) -> str:
    identity = raw.get("identity") or {}
    return identity.get("user_name") or "Unknown"


def _plan_zai(raw: dict) -> str:
    return _format_plan_value(raw.get("level"))


def _plan_go(raw: dict) -> str:
    identity = raw.get("identity") or {}
    value = identity.get("plan")
    if value not in (None, ""):
        return _format_plan_value(value)
    # OpenCode "Go" is the plan label for this provider.
    return "Go"


def _user_go(raw: dict) -> str:
    identity = raw.get("identity") or {}
    user = identity.get("user_name") or identity.get("account_name") or "Unknown"
    # Keep the complete identity in the normalized payload.  Narrow clients
    # (such as the GNOME popup) can choose to abbreviate it themselves.
    return str(user)


def _adapt_openrouter(raw: dict) -> list[Metric]:
    remaining = float(raw.get("remaining_credits", 0.0))
    # total = float(raw.get("total_credits", 0.0))
    # used = float(raw.get("total_usage", 0.0))
    return [
        Metric(
            "Credits",
            f"${remaining:.2f}",
            None,
            "—",
        )
    ]


def _adapt_deepseek(raw: dict) -> list[Metric]:
    balances = raw.get("balances") or []
    metrics: list[Metric] = []
    for item in balances:
        currency = str(item.get("currency") or "?")
        total = str(item.get("total_balance") or "0")
        granted = str(item.get("granted_balance") or "0")
        topped_up = str(item.get("topped_up_balance") or "0")
        metrics.append(
            Metric(
                currency,
                f"{total} total ({granted} granted, {topped_up} topped up)",
                None,
                "—",
            )
        )
    return metrics


# ===== Fetchers (lazy import so a missing optional dep doesn't kill the whole tool) =====


def _fetch_claude(browsers):
    from providers.claude import get_claude_usage

    return get_claude_usage(browsers)


def _fetch_codex(browsers):
    from providers.codex import get_codex_usages

    return get_codex_usages(browsers)


def _fetch_copilot(browsers):
    from providers.copilot import get_copilot_usage, load_copilot_config

    cfg = load_copilot_config()
    return get_copilot_usage(cfg.get("GITHUB_TOKEN"))


def _fetch_zai(browsers):
    from providers.zai import get_zai_quota, load_zai_config

    cfg = load_zai_config()
    token = cfg.get("ZAI_TOKEN")
    if not token:
        raise RuntimeError("ZAI_TOKEN not set in ~/.config/agent-quota/zai.conf")
    return get_zai_quota(token)


def _fetch_zen(browsers):
    from providers.zen import get_zen_balance

    return get_zen_balance(browsers)


def _fetch_go(browsers):
    from providers.go import get_go_usage

    return get_go_usage(browsers)


def _fetch_openrouter(browsers):
    from providers.openrouter import get_openrouter_balance, load_openrouter_config

    cfg = load_openrouter_config()
    token = cfg.get("OPENROUTER_API_KEY")
    if not token:
        raise RuntimeError(
            "OPENROUTER_API_KEY not set in ~/.config/agent-quota/openrouter.conf"
        )
    return get_openrouter_balance(token)


def _fetch_deepseek(browsers):
    from providers.deepseek import get_deepseek_balance, load_deepseek_config

    cfg = load_deepseek_config()
    token = cfg.get("DEEPSEEK_API_KEY")
    if not token:
        raise RuntimeError(
            "DEEPSEEK_API_KEY not set in ~/.config/agent-quota/deepseek.conf"
        )
    return get_deepseek_balance(token)


@dataclass
class _Provider:
    name: str
    mode: str
    fetch: Callable[[list[str] | None], dict | list[dict]]
    adapt: Callable[[dict], list[Metric]]
    plan: Callable[[dict], str] | None = None
    user: Callable[[dict], str] | None = None


def _build_providers() -> dict[str, _Provider]:
    # Copilot quota lives in its own config file; load once so the adapter can
    # format used/quota.
    from providers.copilot import load_copilot_config

    copilot_quota = load_copilot_config().get("COPILOT_QUOTA") or 300
    adapters = {
        "claude": _adapt_claude,
        "codex": _adapt_codex,
        "copilot": _adapt_copilot_factory(copilot_quota),
        "zai": _adapt_zai,
        "zen": _adapt_zen,
        "go": _adapt_go,
        "openrouter": _adapt_openrouter,
        "deepseek": _adapt_deepseek,
    }
    plans = {
        "claude": _plan_claude,
        "codex": _plan_codex,
        "copilot": _plan_copilot,
        "zai": _plan_zai,
        "zen": None,
        "go": _plan_go,
        "openrouter": None,
        "deepseek": None,
    }
    users = {
        "claude": _user_claude,
        "codex": _user_codex,
        "copilot": _user_copilot,
        "zai": None,
        "zen": None,
        "go": _user_go,
        "openrouter": None,
        "deepseek": None,
    }
    fetchers = {
        "claude": _fetch_claude,
        "codex": _fetch_codex,
        "copilot": _fetch_copilot,
        "zai": _fetch_zai,
        "zen": _fetch_zen,
        "go": _fetch_go,
        "openrouter": _fetch_openrouter,
        "deepseek": _fetch_deepseek,
    }
    return {
        key: _Provider(
            name=meta.name,
            mode=meta.mode,
            fetch=fetchers[key],
            adapt=adapters[key],
            plan=plans[key],
            user=users[key],
        )
        for key, meta in PROVIDER_META.items()
    }


# ===== agent-quota config (which providers are enabled) =====


def load_config() -> dict | None:
    """Load ~/.config/agent-quota/config.toml. Returns None if missing or unreadable."""
    if not CONFIG_PATH.exists():
        return None
    try:
        with open(CONFIG_PATH, "rb") as f:
            return tomllib.load(f)
    except Exception:
        return None


def save_config(enabled: list[str]) -> None:
    """Persist the enabled-provider list as TOML.

    Hand-written rather than using a TOML writer dep — the schema is one line.
    """
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    body = ", ".join(f'"{k}"' for k in enabled)
    CONFIG_PATH.write_text(
        "# agent-quota configuration\n"
        "# Edit this file or run `agent-quota setup` to change.\n"
        f"enabled = [{body}]\n"
    )


def _load_secret_value(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        found_key, _, value = line.partition("=")
        if found_key.strip() == key:
            value = value.strip()
            return value or None
    return None


def _save_secret_value(path: Path, key: str, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# agent-quota provider credentials\n{key}={value}\n")


def _maybe_prompt_for_provider_secret(console: Console, meta: ProviderMeta) -> None:
    if not meta.secret_key or not meta.secret_path or not meta.secret_label:
        return

    existing = _load_secret_value(meta.secret_path, meta.secret_key)
    if existing:
        if not Confirm.ask(
            f"  Update saved {meta.secret_label}?",
            default=False,
        ):
            return
    else:
        if not Confirm.ask(
            f"  Enter {meta.secret_label} now?",
            default=True,
        ):
            return

    value = Prompt.ask(
        f"  {meta.secret_key}",
        password=True,
    ).strip()
    if not value:
        console.print("  [yellow]Skipped empty secret.[/]")
        return

    _save_secret_value(meta.secret_path, meta.secret_key, value)
    console.print(f"  [green]✓ saved[/] [dim]{meta.secret_path}[/]")


def run_setup() -> int:
    """Interactive picker for enabled providers. Writes config.toml and returns 0."""
    console = Console()
    console.print()
    console.rule("[bold]agent-quota setup[/]")
    console.print(
        "Pick which providers to monitor. Subscription and rate-limit providers are listed first. Re-run "
        "[cyan]agent-quota setup[/] later to change.\n"
    )

    existing = (load_config() or {}).get("enabled") or list(PROVIDER_META)
    enabled: list[str] = []
    for key, meta in PROVIDER_META.items():
        name = meta.name
        desc = meta.desc
        console.print(f"  [bold]{name:<8}[/]  [dim]{desc}[/]")
        if Confirm.ask(f"  Enable {name}?", default=key in existing):
            enabled.append(key)
            _maybe_prompt_for_provider_secret(console, meta)
        console.print()

    if not enabled:
        console.print("[yellow]No providers selected — config not saved.[/]")
        return 1

    save_config(enabled)
    console.print(f"[green]✓ saved[/] [dim]{CONFIG_PATH}[/]")
    return 0


def _resolve_keys(args, all_providers: dict[str, _Provider]) -> list[str] | None:
    """Decide which provider keys to run for this invocation.

    Precedence: --only > config.toml > interactive setup prompt > all providers.
    Returns None if user input is invalid (caller exits 2).
    """
    if args.only:
        keys = [k.strip().lower() for k in args.only.split(",") if k.strip()]
        unknown = [k for k in keys if k not in all_providers]
        if unknown:
            sys.stderr.write(f"Unknown provider(s): {', '.join(unknown)}\n")
            sys.stderr.write(f"Known: {', '.join(all_providers)}\n")
            return None
        return keys

    cfg = load_config()
    if cfg is not None and "enabled" in cfg:
        keys = [k for k in cfg["enabled"] if k in all_providers]
        if keys:
            return keys

    # No --only and no usable config. Offer to set up if interactive; otherwise
    # fall back to running everything so cron/pipe usage still works.
    if sys.stdin.isatty() and sys.stdout.isatty():
        Console().print(f"[yellow]No agent-quota config at[/] [dim]{CONFIG_PATH}[/]")
        if Confirm.ask("Run setup now?", default=True):
            run_setup()
            cfg = load_config()
            if cfg and cfg.get("enabled"):
                return [k for k in cfg["enabled"] if k in all_providers]

    return list(all_providers)


# ===== Error classification =====

_AUTH_HINTS = (
    "403",
    "401",
    "404",
    "unauthorized",
    "forbidden",
    "cookie",
    "token",
    "lastactiveorg",
)


def _classify(exc: Exception) -> str:
    msg = str(exc).lower()
    return "auth_err" if any(h in msg for h in _AUTH_HINTS) else "net_err"


# ===== Fetch orchestration =====


def fetch_one(
    key: str, prov: _Provider, browsers: list[str] | None
) -> list[ProviderStatus]:
    status = ProviderStatus(key=key, name=prov.name, mode=prov.mode)
    try:
        raw = prov.fetch(browsers)
    except Exception as exc:
        status.state = _classify(exc)
        status.error = str(exc).splitlines()[0][:120]
        return [status]

    raw_items = raw if isinstance(raw, list) else [raw]
    statuses: list[ProviderStatus] = []
    for raw_item in raw_items:
        item_status = ProviderStatus(key=key, name=prov.name, mode=prov.mode)
        try:
            item_status.metrics = _apply_provider_constraints(prov.adapt(raw_item))
            if isinstance(raw_item, dict):
                identity = raw_item.get("identity") or {}
                item_status.workspace_id = str(identity.get("workspace_id") or "")
                item_status.source = str(
                    raw_item.get("source")
                    or identity.get("source")
                    or {
                        "zai": "api",
                        "go": "browser",
                        "zen": "browser",
                        "openrouter": "api",
                        "deepseek": "api",
                    }.get(key, "")
                )
            if prov.plan:
                item_status.plan = prov.plan(raw_item)
            if prov.user:
                item_status.user = prov.user(raw_item)
        except Exception as exc:
            item_status.state = "net_err"
            item_status.error = f"adapter: {exc}"
        statuses.append(item_status)

    return statuses


def fetch_all(
    providers: dict[str, _Provider], browsers: list[str] | None
) -> list[ProviderStatus]:
    results: dict[str, list[ProviderStatus]] = {}
    with ThreadPoolExecutor(max_workers=max(1, len(providers))) as pool:
        futs = {pool.submit(fetch_one, k, p, browsers): k for k, p in providers.items()}
        for fut in as_completed(futs):
            k = futs[fut]
            results[k] = fut.result()
    return [status for key in providers for status in results[key]]


# ===== Rendering =====

_STATE_STYLE = {"ok": "green", "auth_err": "red", "net_err": "yellow"}
_STATE_LABEL = {"ok": "OK", "auth_err": "Auth Err", "net_err": "Net Err"}


class _UsageBar:
    """Full-width progress bar with the metric value overlaid in the centre."""

    def __init__(
        self,
        pct: float,
        value: str,
        is_remaining: bool = False,
        muted: bool = False,
    ) -> None:
        self.pct = max(0.0, min(100.0, pct))
        self.value = value
        self.is_remaining = is_remaining
        self.muted = muted

    def _color(self, is_remaining: bool = False) -> str:
        if self.muted:
            return "#6f8f78"
        if is_remaining:
            if self.pct > 30:
                return "green"
            if self.pct > 10:
                return "yellow"
            return "red"
        if self.pct < 70:
            return "green"
        if self.pct < 90:
            return "yellow"
        return "red"

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        width = options.max_width
        if width <= 0:
            yield Text("")
            return
        filled = int(self.pct / 100 * width + 0.5)
        text = self.value[:width]
        text_start = (width - len(text)) // 2
        text_end = text_start + len(text)
        color = self._color(self.is_remaining)

        text_color_on_filled = "black" if color == "yellow" else "white"
        result = Text()
        for i in range(width):
            char = text[i - text_start] if text_start <= i < text_end else " "
            if i < filled:
                result.append(char, style=f"bold {text_color_on_filled} on {color}")
            else:
                result.append(char, style=f"bold {color} on grey23")
        yield result

    def __rich_measure__(
        self, console: Console, options: ConsoleOptions
    ) -> Measurement:
        # Floor needs to be high enough that the bar still reads as a bar even
        # when options.max_width is small or 0 (which happens during the first
        # measure pass in Live mode). Returning Measurement(0, 0) here would
        # collapse the column and make the bar disappear.
        minimum = max(len(self.value) + 4, 12)
        maximum = max(minimum, options.max_width)
        return Measurement(minimum, maximum)


def _usage_cell(metric: Metric):
    if metric.pct is None:
        return Text(metric.value)
    return _UsageBar(metric.pct, metric.value, metric.is_remaining, metric.muted)


class _WindowUsageLine:
    """Single-line usage bar/value with window label on the left."""

    def __init__(self, metric: Metric, label_width: int) -> None:
        self.metric = metric
        self.label_width = max(0, label_width)

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        width = options.max_width
        if width <= 0:
            yield Text("")
            return

        label_width = min(self.label_width, max(0, width - 1))
        bar_width = max(0, width - label_width - 1)

        # Left side: label (right-justified within its width)
        label = self.metric.label
        if label_width > 0 and len(label) > label_width:
            label = label[: max(1, label_width - 1)] + "…"
        label = label.rjust(label_width)
        left = Text(label, style="dim")

        # Right side: bar/value into the allocated bar width
        if bar_width <= 0:
            right = Text("")
        elif self.metric.pct is None:
            value = self.metric.value
            if len(value) > bar_width:
                value = value[: max(0, bar_width - 1)] + "…" if bar_width >= 2 else "…"
            right = Text(value)
            if len(right.plain) < bar_width:
                right.append(" " * (bar_width - len(right.plain)))
        else:
            bar = _UsageBar(
                self.metric.pct,
                self.metric.value,
                self.metric.is_remaining,
                self.metric.muted,
            )
            bar_iter = bar.__rich_console__(
                console, options.update(max_width=bar_width)
            )
            bar_text = next(iter(bar_iter), Text(""))
            # _UsageBar always yields a single Text.
            right = bar_text if isinstance(bar_text, Text) else Text(str(bar_text))
            if len(right.plain) < bar_width:
                right.append(" " * (bar_width - len(right.plain)))

        result = Text()
        if label_width > 0:
            result.append_text(left)
            result.append(" ")
        result.append_text(right)
        yield result

    def __rich_measure__(
        self, console: Console, options: ConsoleOptions
    ) -> Measurement:
        bar_min = (
            max(len(self.metric.value) + 4, 12)
            if self.metric.pct is not None
            else min(max(len(self.metric.value), 4), 12)
        )
        minimum = bar_min + (1 + self.label_width if self.label_width else 0)
        maximum = max(minimum, options.max_width)
        return Measurement(minimum, maximum)


def _render_table(
    statuses: list[ProviderStatus], *, title: str, label_header: str, value_header: str
) -> Table:
    label_width = min(
        12, max((len(m.label) for s in statuses for m in s.metrics), default=0)
    )
    table = Table(
        title=title,
        title_style="bold",
        show_header=True,
        header_style="bold cyan",
        expand=True,
    )
    # vertical="middle" lets the single-line Provider/Plan/User/Reset cells sit
    # centered next to multi-line Usage cells when a provider has
    # multiple metrics (e.g. Claude's 5h + 7d).
    table.add_column(
        Text("Provider", justify="center"), no_wrap=True, vertical="middle"
    )
    table.add_column(Text("Plan", justify="center"), no_wrap=True, vertical="middle")
    table.add_column(Text("User", justify="center"), no_wrap=True, vertical="middle")
    # Custom Text header so we can center "Usage" without setting
    # justify="center" on the column itself — that would shrink the _UsageBar
    # to its measured minimum and pad around it instead of filling the column.
    table.add_column(
        Text(value_header, justify="center"),
        no_wrap=True,
        ratio=1,
        min_width=14,
        overflow="ellipsis",
        vertical="middle",
    )
    table.add_column(Text("Reset", justify="right"), no_wrap=True, vertical="middle")

    last_idx = len(statuses) - 1

    for s_idx, s in enumerate(statuses):
        end_section = s_idx != last_idx
        state = Text(_STATE_LABEL[s.state], style=_STATE_STYLE[s.state])

        if s.state != "ok":
            table.add_row(
                s.name,
                state,
                "—",
                Text(s.error or "(no detail)", style="dim"),
                "—",
                end_section=end_section,
            )
            continue
        if not s.metrics:
            table.add_row(
                s.name,
                s.plan or "Unknown",
                s.user or "—",
                Text("no data", style="dim"),
                "—",
                end_section=end_section,
            )
            continue

        # Pad name/status with leading blank lines so they land on the visual
        # middle row. For odd n this is the exact center; for even n it sits on
        # the lower of the two middle rows (Rich's vertical="middle" rounds
        # down on its own, which leaves the name stuck at the top).
        n = len(s.metrics)
        pad = "\n" * (n // 2)
        resets = Text("\n".join(m.reset for m in s.metrics))
        usage = Group(*(_WindowUsageLine(m, label_width) for m in s.metrics))
        name_cell = Text(pad + s.name)
        plan_cell = Text(pad + (s.plan or "Unknown"))
        user_cell = Text(pad + (s.user or "—"))
        table.add_row(
            name_cell,
            plan_cell,
            user_cell,
            usage,
            resets,
            end_section=end_section,
        )
    return table


def _render_payg_table(statuses: list[ProviderStatus]) -> Table:
    table = Table(
        title="Pay-As-You-Go Quota",
        title_style="bold",
        show_header=True,
        header_style="bold cyan",
        expand=True,
    )
    table.add_column(
        Text("Provider", justify="center"), no_wrap=True, vertical="middle"
    )
    table.add_column(
        Text("Quota", justify="center"),
        ratio=1,
        min_width=14,
        overflow="ellipsis",
        vertical="middle",
    )

    last_idx = len(statuses) - 1
    for s_idx, s in enumerate(statuses):
        end_section = s_idx != last_idx
        if s.state != "ok":
            err_style = _STATE_STYLE[s.state]
            label = _STATE_LABEL[s.state]
            detail = s.error or "(no detail)"
            table.add_row(
                s.name,
                Text(f"{label} — {detail}", style=err_style),
                end_section=end_section,
            )
            continue
        if not s.metrics:
            table.add_row(s.name, Text("no data", style="dim"), end_section=end_section)
            continue
        # Single-metric providers (Zen today) just show the value; multi-metric
        # providers stack "<label>  <value>" lines so the label still
        # disambiguates rows.
        if len(s.metrics) == 1:
            quota_cell = Text(s.metrics[0].value)
        else:
            quota_cell = Text("\n".join(f"{m.label}  {m.value}" for m in s.metrics))
        table.add_row(s.name, quota_cell, end_section=end_section)
    return table


def render_tables(statuses: list[ProviderStatus]):
    usage_statuses = [s for s in statuses if s.mode == "usage"]
    payg_statuses = [s for s in statuses if s.mode == "payg"]
    tables = []
    if usage_statuses:
        tables.append(
            _render_table(
                usage_statuses,
                title="Usage-Based Limits",
                label_header="Window",
                value_header="Usage / Remaining",
            )
        )
    if payg_statuses:
        tables.append(_render_payg_table(payg_statuses))
    if not tables:
        return _render_table(
            [],
            title="agent-quota",
            label_header="Window",
            value_header="Usage / Remaining",
        )
    if len(tables) == 1:
        return tables[0]
    return Group(*tables)


def _status_json(statuses: list[ProviderStatus]) -> dict:
    """Return a stable, dependency-free representation for desktop clients."""
    return {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "statuses": [
            {
                "key": status.key,
                "name": status.name,
                "mode": status.mode,
                "plan": status.plan,
                "user": status.user,
                "source": status.source,
                "workspace_id": status.workspace_id,
                "state": status.state,
                "error": status.error,
                "metrics": [
                    {
                        "label": metric.label,
                        "value": metric.value,
                        "pct": metric.pct,
                        "reset": metric.reset,
                        "is_remaining": metric.is_remaining,
                        "muted": metric.muted,
                    }
                    for metric in status.metrics
                ],
            }
            for status in statuses
        ],
    }


# ===== Main =====


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="agent-quota",
        description="Show subscription and rate-limit usage for AI products in terminal tables.",
    )
    parser.add_argument(
        "--only",
        metavar="LIST",
        help="Comma-separated providers (overrides config). Known: claude,codex,copilot,zai,zen,go,openrouter,deepseek",
    )
    parser.add_argument(
        "--view",
        choices=("usage", "payg", "both"),
        default="both",
        help="Which table(s) to render: 'usage' (usage-based limits), 'payg' (pay-as-you-go quota), or 'both' (default).",
    )
    parser.add_argument(
        "--watch",
        type=int,
        nargs="?",
        const=15,
        metavar="SECS",
        help="Refresh every SECS seconds (default 15 if SECS omitted). Ctrl+C to exit.",
    )
    parser.add_argument(
        "--browser",
        action="append",
        metavar="NAME",
        help="Browser preference for cookie-auth providers; repeatable.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of terminal tables (for desktop integrations).",
    )
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("setup", help="Pick which providers to enable (writes config.toml).")

    args = parser.parse_args()

    if args.command == "setup":
        return run_setup()

    all_providers = _build_providers()
    keys = _resolve_keys(args, all_providers)
    if keys is None:
        return 2
    providers = {k: all_providers[k] for k in keys}
    if args.view != "both":
        providers = {k: p for k, p in providers.items() if p.mode == args.view}
        if not providers:
            sys.stderr.write(
                f"No enabled providers match --view {args.view}. "
                "Enable a matching provider with `agent-quota setup` or use --only.\n"
            )
            return 2

    console = Console()
    browsers = args.browser

    if args.watch is None:
        statuses = fetch_all(providers, browsers)
        if args.json:
            print(json.dumps(_status_json(statuses), ensure_ascii=False))
            return 0 if all(s.state == "ok" for s in statuses) else 1
        console.print(render_tables(statuses))
        return 0 if all(s.state == "ok" for s in statuses) else 1

    interval = max(1, args.watch)
    try:
        with Live(console=console, refresh_per_second=4, screen=True) as live:
            while True:
                statuses = fetch_all(providers, browsers)
                live.update(render_tables(statuses))
                time.sleep(interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
