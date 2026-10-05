"""Per-provider browser preferences (PR #4 review F4).

The GNOME extension passes `--provider-browser KEY=NAME` so a browser choice
for one provider neither replaces config.toml's provider subset nor leaks to
the other cookie-auth providers.
"""

import contextlib
import io
import json
import sys
import unittest
from unittest import mock

import agent_quota
from agent_quota import _Provider, _parse_provider_browsers


def fake_providers(seen: dict) -> dict[str, _Provider]:
    def make(key):
        def fetch(browsers):
            seen[key] = browsers
            return {"source": "test"}

        return _Provider(name=key.title(), mode="usage", fetch=fetch, adapt=lambda raw: [])

    return {key: make(key) for key in ("claude", "codex", "copilot", "zen")}


class ParseProviderBrowsersTests(unittest.TestCase):
    def test_parses_repeated_entries_per_key(self) -> None:
        providers = fake_providers({})
        self.assertEqual(
            _parse_provider_browsers(
                ["claude=firefox", "claude=chrome", " zen = brave "], providers
            ),
            {"claude": ["firefox", "chrome"], "zen": ["brave"]},
        )
        self.assertEqual(_parse_provider_browsers(None, providers), {})

    def test_rejects_malformed_or_unknown_entries(self) -> None:
        providers = fake_providers({})
        for bad in ("claude", "claude=", "nope=firefox", "=firefox"):
            self.assertIsNone(_parse_provider_browsers([bad], providers), bad)


class ProviderBrowserCliTests(unittest.TestCase):
    def run_main(self, argv: list[str], seen: dict) -> dict:
        out = io.StringIO()
        with mock.patch.object(agent_quota, "_build_providers", lambda: fake_providers(seen)), \
                mock.patch.object(
                    agent_quota, "load_config", lambda: {"enabled": ["claude", "codex"]}
                ), \
                mock.patch.object(sys, "argv", ["agent-quota", *argv]), \
                contextlib.redirect_stdout(out):
            agent_quota.main()
        return json.loads(out.getvalue())

    def test_browser_choice_keeps_configured_subset(self) -> None:
        seen: dict = {}
        payload = self.run_main(
            ["--json", "--provider-browser", "claude=firefox", "--browser", "chrome"], seen
        )
        # Only config.toml's two providers run; claude uses its own browser,
        # codex falls back to the global --browser.
        self.assertEqual(seen, {"claude": ["firefox"], "codex": ["chrome"]})
        self.assertEqual([s["key"] for s in payload["statuses"]], ["claude", "codex"])

    def test_without_global_browser_others_use_default_order(self) -> None:
        seen: dict = {}
        self.run_main(["--json", "--provider-browser", "codex=brave"], seen)
        self.assertEqual(seen, {"claude": None, "codex": ["brave"]})

    def test_malformed_value_exits_with_usage_error(self) -> None:
        with mock.patch.object(sys, "argv", ["agent-quota", "--provider-browser", "nope"]), \
                contextlib.redirect_stderr(io.StringIO()), \
                self.assertRaises(SystemExit) as ctx:
            agent_quota.main()
        self.assertEqual(ctx.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
