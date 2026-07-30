# Agent Quota

`agent-quota` shows the remaining quotas and balances for AI coding services,
including Claude, Codex, Copilot, OpenCode, and Z.ai. It provides a Rich-based
terminal CLI and a GNOME Shell top-bar extension, both powered by the same
Python backend.

- `agent_quota.py` fetches providers in parallel, normalizes their metrics, and
  renders CLI/JSON output.
- `providers/` contains isolated adapters for each service's authentication and
  quota endpoint; shared caching, cookie loading, and time parsing live in
  `common.py`.
- `gnome-shell-extension/` presents the CLI data in GNOME and bundles the
  backend during installation.

Use `uv run agent-quota` for local development. Provider configuration lives in
`~/.config/agent-quota/`, while cached responses live in
`~/.cache/agent-quota/`.
