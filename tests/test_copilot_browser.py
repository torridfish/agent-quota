"""Copilot browser-preference regressions (PR #4).

`--browser firefox` must reach the cookie loader instead of being dropped at
the fetcher boundary, and the browser fallback cache must be scoped to the
browser preference so different accounts do not share cached pages.
"""

import unittest
from unittest import mock

import providers.copilot as copilot

FEATURES_HTML = """
<html><head><meta name="user-login" content="octocat"></head>
<body><h2>Included credits</h2>
<div class="progress">3 / 30 AI credits</div>
</body></html>
"""


class FakeResponse:
    status_code = 200
    text = FEATURES_HTML


class BrowserPreferenceTests(unittest.TestCase):
    def test_browser_preference_reaches_cookie_loader(self) -> None:
        seen = {}

        def fake_load_cookies(domain, browsers=None):
            seen["domain"] = domain
            seen["browsers"] = browsers
            return {}, "firefox"

        with mock.patch.object(copilot, "load_cookies", fake_load_cookies), \
                mock.patch.object(copilot.requests, "get", lambda *a, **k: FakeResponse()):
            data = copilot._fetch_copilot_usage_from_browser(["firefox"])

        self.assertEqual(seen, {"domain": "github.com", "browsers": ["firefox"]})
        self.assertEqual(data["identity"]["user_name"], "octocat")
        self.assertEqual(data["source"], "firefox:copilot-features")

    def test_no_preference_uses_default_cookie_order(self) -> None:
        seen = {}

        def fake_load_cookies(domain, browsers=None):
            seen["browsers"] = browsers
            return {}, "chrome"

        with mock.patch.object(copilot, "load_cookies", fake_load_cookies), \
                mock.patch.object(copilot.requests, "get", lambda *a, **k: FakeResponse()):
            copilot._fetch_copilot_usage_from_browser()

        self.assertIsNone(seen["browsers"])

    def test_cache_name_scoped_to_browser_preference(self) -> None:
        self.assertEqual(copilot._browser_cache_name(None), "copilot_browser")
        self.assertEqual(copilot._browser_cache_name([]), "copilot_browser")
        self.assertEqual(
            copilot._browser_cache_name(["firefox"]), "copilot_browser:firefox"
        )
        self.assertEqual(
            copilot._browser_cache_name(["chrome", "firefox"]),
            "copilot_browser:chrome,firefox",
        )

    def test_get_copilot_usage_threads_preference_and_cache_name(self) -> None:
        calls = []

        def fake_cache(name, fetch, ttl=60):
            calls.append((name, ttl))
            return fetch()

        fetched = []

        def fake_browser_fetch(browsers=None):
            fetched.append(browsers)
            return {"identity": {"user_name": "octocat", "source": "browser"}}

        with mock.patch.object(copilot, "get_cached_or_fetch", fake_cache), \
                mock.patch.object(copilot, "_fetch_copilot_usage_from_browser", fake_browser_fetch):
            data = copilot.get_copilot_usage(None, ["firefox"])

        self.assertEqual(data["identity"]["user_name"], "octocat")
        self.assertEqual(fetched, [["firefox"]])
        self.assertEqual(calls, [("copilot_browser:firefox", 60)])

    def test_fetch_copilot_forwards_browsers(self) -> None:
        import agent_quota

        with mock.patch.object(
            copilot, "load_copilot_config", lambda config_path=None: {"GITHUB_TOKEN": None}
        ), mock.patch.object(
            copilot, "get_copilot_usage", mock.Mock(return_value={"identity": {}})
        ) as usage:
            agent_quota._fetch_copilot(["firefox"])

        usage.assert_called_once_with(None, ["firefox"])
