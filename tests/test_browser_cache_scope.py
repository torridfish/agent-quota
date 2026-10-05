"""Browser-preference cache scoping for cookie-auth providers (PR #4 review F3).

Different browsers can be signed in to different accounts. With a warm cache
from one browser, switching --browser must fetch the other browser's account
instead of returning the cached one; omitting --browser keeps the original
cache key so existing CLI caches stay valid.
"""

import unittest
from unittest import mock

import providers.claude as claude
import providers.codex as codex
import providers.zen as zen


def warm_cache(store: dict):
    """A get_cached_or_fetch stand-in whose entries never expire (unless ttl=0)."""

    def fake(name, fetch, ttl=60):
        if ttl and name in store:
            return store[name]
        store[name] = fetch()
        return store[name]

    return fake


class BrowserCacheScopeTests(unittest.TestCase):
    def test_claude_switching_browser_skips_other_browsers_cache(self) -> None:
        store: dict = {}

        def fetch(browsers=None):
            return {"identity": {"user_name": browsers[0]}, "source": browsers[0]}

        with mock.patch.object(claude, "get_cached_or_fetch", warm_cache(store)), \
                mock.patch.object(claude, "_fetch_claude_usage_uncached", fetch):
            claude.get_claude_usage(["chrome"])
            data = claude.get_claude_usage(["firefox"])

        self.assertEqual(data["source"], "firefox")
        self.assertEqual(set(store), {"claude:chrome", "claude:firefox"})

    def test_codex_switching_browser_skips_other_browsers_cache(self) -> None:
        store: dict = {}

        def fetch(browsers=None):
            return [{"source": browsers[0], "workspace": browsers[0]}]

        with mock.patch.object(codex, "get_cached_or_fetch", warm_cache(store)), \
                mock.patch.object(codex, "_fetch_codex_usages_uncached", fetch), \
                mock.patch.object(
                    codex, "extract_codex_identity",
                    lambda item: {"workspace_id": item["workspace"]},
                ):
            codex.get_codex_usages(["chrome"])
            data = codex.get_codex_usages(["firefox"])

        self.assertEqual(data[0]["source"], "firefox")
        self.assertEqual(set(store), {"codex:chrome", "codex:firefox"})

    def test_zen_cache_key_keeps_workspace_and_adds_browser(self) -> None:
        store: dict = {}

        with mock.patch.object(zen, "get_cached_or_fetch", warm_cache(store)), \
                mock.patch.object(
                    zen, "_fetch_zen_balance_uncached",
                    lambda browsers=None: {"source": browsers[0] if browsers else "auto"},
                ), \
                mock.patch.object(zen, "load_zen_config", lambda: {"WORKSPACE_ID": "wrk_1"}):
            zen.get_zen_balance(["chrome"])
            data = zen.get_zen_balance(["firefox"])
            zen.get_zen_balance()

        self.assertEqual(data["source"], "firefox")
        self.assertEqual(
            set(store),
            {"zen-balance-wrk_1:chrome", "zen-balance-wrk_1:firefox", "zen-balance-wrk_1"},
        )

    def test_no_preference_keeps_legacy_cache_names(self) -> None:
        store: dict = {}
        with mock.patch.object(claude, "get_cached_or_fetch", warm_cache(store)), \
                mock.patch.object(
                    claude, "_fetch_claude_usage_uncached",
                    lambda browsers=None: {"identity": {"u": 1}, "source": "chrome"},
                ):
            claude.get_claude_usage()
        self.assertEqual(set(store), {"claude"})


if __name__ == "__main__":
    unittest.main()
