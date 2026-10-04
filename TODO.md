# TODO: pay-as-you-go providers to integrate

Candidate providers for the **Pay-As-You-Go Quota** table (`mode="payg"` in
`PROVIDER_META`). Sorted by ease of integration and fit with the existing
"agent coding tool" theme.

For each, the implementation pattern is the same (see CLAUDE.md → "Adding a
provider"): a new `providers/<name>.py` with `get_<name>_balance()`, plus a
lazy-import fetcher, adapter, and `PROVIDER_META` entry in `agent_quota.py`.
The adapter should emit a single `Metric(label, value)` with no `pct`.

## Tier 1 — clean public balance APIs (start here)

- [x] **OpenRouter** — `GET /api/v1/credits`, `Authorization: Bearer <key>`.
  Returns `total_credits` and `total_usage`. Token-in-config-file auth, no
  Cloudflare, no scraping. Mirror `providers/zai.py` shape.
- [x] **DeepSeek** — `GET https://api.deepseek.com/user/balance`,
  `Authorization: Bearer <key>`. Returns currency + available balance.
  Trivial; same shape as OpenRouter.
- [x] **Kimi / Moonshot AI** — `GET /v1/users/me/balance`,
  `Authorization: Bearer <key>`. Returns `available_balance`,
  `voucher_balance` and `cash_balance`. No currency field, so it is inferred
  from the base URL: `api.moonshot.ai` is USD, `api.moonshot.cn` is CNY and is
  configurable via `MOONSHOT_BASE_URL`.

## Tier 2 — natural pairings with already-supported subscriptions

- [ ] **Anthropic API (console.anthropic.com)** — direct API credit balance,
  complements the existing Claude.ai subscription row. Workspace API key
  auth; balance endpoint is on the org billing API. May require cookie
  scrape if no public balance endpoint is exposed.
- [ ] **OpenAI Platform (platform.openai.com)** — credit balance,
  complements the ChatGPT/Codex row. Likely cookie-auth scrape of the
  billing page (the old `/dashboard/billing/credit_grants` endpoint is
  deprecated).

## Tier 3 — common agent backends

- [ ] **Together AI** — `GET /v1/account/balance` or dashboard scrape.
  Token-in-config auth.
- [ ] **Groq** — credits visible in console; no official balance API as of
  writing. Cookie scrape of the console billing page.
- [ ] **Fireworks AI** — prepaid; account API with token.
- [ ] **Mistral La Plateforme** — prepaid; console-only → cookie scrape.
- [ ] **xAI (Grok API)** — `console.x.ai` prepaid credits → cookie scrape.

## Tier 4 — mixed subscription + payg, or mode TBD

- [ ] **Cursor** — subscription with included premium requests *plus* payg
  overflow. Could span both tables: a `usage` row for the included quota
  and a `payg` row for the overflow $ balance. Cookie auth via
  `cursor.com`.
- [ ] **Google Antigravity** — Google's agentic IDE. Likely `usage` mode
  (daily / weekly agent-run caps backed by Gemini quotas) rather than
  `payg`, but mode depends on how the limits surface to the user once
  metering stabilizes. Auth is Google account cookies; the balance/quota
  page lives in the Antigravity web app — verify endpoint shape before
  picking a fetch strategy (HTML scrape vs. JSON API).
- [ ] **Perplexity API** — prepaid credits.
- [ ] **Replicate** — `GET /v1/account` returns balance.

## Future feature: multiple accounts per provider

Today the architecture is one-account-per-provider: `PROVIDER_META` is keyed
by provider name, each provider reads a single
`~/.config/agent-quota/<name>.conf`, `get_cached_or_fetch` uses one cache
file per key, and `load_cookies` returns the first matching cookie jar
across `DEFAULT_BROWSERS`. Useful for users who keep e.g. a personal and
work Claude account, or multiple OpenRouter keys.

Suggested minimal shape:

- [ ] Allow instance suffixes in `config.toml`'s `enabled` list:
  `enabled = ["claude", "claude:work", "openrouter:personal"]`. The part
  after `:` is a free-form label.
- [ ] Per-instance config and cache filenames:
  `~/.config/agent-quota/<name>@<label>.conf` and
  `~/.cache/agent-quota/<name>@<label>.json`. Bare `<name>` (no label)
  keeps working for the default instance — backwards compatible.
- [ ] Render the label in the Provider column as a parenthetical:
  `Claude (work)`. Single-instance providers stay unchanged.
- [ ] Token-auth providers (`copilot`, `zai`, future `openrouter` /
  `deepseek`) — trivial: each instance stores a different token in its
  config file.
- [ ] Cookie-auth providers (`claude`, `codex`, `zen`, `go`) — harder.
  Cookies are global per browser profile, so distinct instances must
  target distinct browser profiles. Requires extending `load_cookies` /
  the `--browser` flag to accept `browser:profile` (e.g.
  `firefox:profile-work`) and threading the selection through to
  `browser_cookie3`'s per-profile path argument. `DEFAULT_BROWSERS`
  fallback semantics need a rethink — probably "no fallback when a
  profile is pinned."
- [ ] Setup picker (`agent-quota setup`) gains an "add another account"
  prompt per provider so users don't have to hand-edit `config.toml`.

Order of work: ship token-auth multi-account first (small, useful on its
own), then tackle cookie-auth profile selection.

## Notes

- Token-auth providers should not retry on failure (single 10s timeout, per
  CLAUDE.md → "Retry").
- Cookie-auth providers behind Cloudflare must use `curl_cffi` with
  `impersonate="chrome"`.
- Cache TTL: default 60s is fine; bump to 120s+ if the provider rate-limits
  balance polling.
