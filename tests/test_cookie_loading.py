"""Cookie loader pre-checks and short-circuiting (Issue #6).

browser_cookie3 queries the Linux keyring (Secret Service, then KWallet over
D-Bus) inside ChromiumBased.__init__ before checking whether the browser's
Cookies database exists on disk.  Browsers without a Cookies file must be
skipped before invoking browser_cookie3, and load_cookies must stop at the
first browser that returns cookies.
"""

from http.cookiejar import Cookie
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import common


def _fake_jar(items: dict[str, str]) -> list[Cookie]:
    return [SimpleNamespace(name=k, value=v) for k, v in items.items()]


class CookieFilePrecheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.home = Path(self._tmp.name)
        self._env = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        self._plat = mock.patch.object(common.sys, "platform", "linux")
        self._env.start()
        self._plat.start()

    def tearDown(self) -> None:
        self._plat.stop()
        self._env.stop()
        self._tmp.cleanup()

    def _touch(self, rel_path: str) -> Path:
        path = self.home / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"")
        return path

    def test_skips_chromium_loader_when_only_directories_exist(self) -> None:
        self._touch(".config/google-chrome/Default/Cookies")
        # A directory without a Cookies file (e.g. NativeMessagingHosts or an
        # empty Default directory) must not trigger the Chromium loader.
        (self.home / ".config/chromium/NativeMessagingHosts").mkdir(parents=True)
        (self.home / ".config/chromium/Default").mkdir(parents=True)

        with mock.patch.object(
            common.browser_cookie3,
            "chrome",
            return_value=_fake_jar({"session": "tok"}),
        ) as chrome_loader, mock.patch.object(
            common.browser_cookie3,
            "chromium",
            side_effect=AssertionError("chromium loader must not be called"),
        ) as chromium_loader:
            candidates = common.load_cookie_candidates(
                "chatgpt.com", ["chrome", "chromium"]
            )

        self.assertEqual(candidates, [({"session": "tok"}, "chrome")])
        chrome_loader.assert_called_once_with(domain_name="chatgpt.com")
        chromium_loader.assert_not_called()

    def test_calls_chromium_loader_when_profile_cookie_file_exists(self) -> None:
        self._touch(".config/chromium/Profile 1/Cookies")

        with mock.patch.object(
            common.browser_cookie3,
            "chromium",
            return_value=_fake_jar({"sid": "123"}),
        ) as chromium_loader:
            candidates = common.load_cookie_candidates("chatgpt.com", ["chromium"])

        self.assertEqual(candidates, [({"sid": "123"}, "chromium")])
        chromium_loader.assert_called_once_with(domain_name="chatgpt.com")

    def test_helium_does_not_call_chromium_loader_when_cookie_file_absent(self) -> None:
        with mock.patch.object(
            common.browser_cookie3,
            "chromium",
            side_effect=AssertionError("chromium loader must not be called"),
        ) as chromium_loader:
            with self.assertRaises(common.browser_cookie3.BrowserCookieError):
                common.helium(domain_name="chatgpt.com")
            with self.assertRaises(RuntimeError):
                common.load_cookie_candidates("chatgpt.com", ["helium"])

        chromium_loader.assert_not_called()

    def test_load_cookies_stops_at_first_matching_browser(self) -> None:
        self._touch(".config/google-chrome/Default/Cookies")
        self._touch(".config/chromium/Default/Cookies")

        with mock.patch.object(
            common.browser_cookie3,
            "chrome",
            return_value=_fake_jar({"auth": "ok"}),
        ) as chrome_loader, mock.patch.object(
            common.browser_cookie3,
            "chromium",
            side_effect=AssertionError("chromium loader must not be called after chrome matched"),
        ) as chromium_loader:
            cookies, browser_name = common.load_cookies(
                "opencode.ai", ["chrome", "chromium"]
            )

        self.assertEqual(cookies, {"auth": "ok"})
        self.assertEqual(browser_name, "chrome")
        chrome_loader.assert_called_once_with(domain_name="opencode.ai")
        chromium_loader.assert_not_called()

    def test_load_cookies_falls_through_when_first_browser_is_empty(self) -> None:
        self._touch(".config/google-chrome/Default/Cookies")
        self._touch(".config/BraveSoftware/Brave-Browser/Default/Cookies")

        with mock.patch.object(
            common.browser_cookie3,
            "chrome",
            return_value=_fake_jar({}),
        ) as chrome_loader, mock.patch.object(
            common.browser_cookie3,
            "brave",
            return_value=_fake_jar({"auth": "brave-tok"}),
        ) as brave_loader:
            cookies, browser_name = common.load_cookies(
                "github.com", ["chrome", "brave"]
            )

        self.assertEqual((cookies, browser_name), ({"auth": "brave-tok"}, "brave"))
        chrome_loader.assert_called_once_with(domain_name="github.com")
        brave_loader.assert_called_once_with(domain_name="github.com")

    def test_helium_falls_back_to_numbered_profile_when_default_missing(self) -> None:
        profile_cookie = self._touch(".config/net.imput.helium/Profile 1/Cookies")

        with mock.patch.object(
            common.browser_cookie3,
            "chromium",
            return_value=_fake_jar({"sid": "helium-profile"}),
        ) as chromium_loader:
            candidates = common.load_cookie_candidates("chatgpt.com", ["helium"])

        self.assertEqual(candidates, [({"sid": "helium-profile"}, "helium")])
        chromium_loader.assert_called_once_with(
            cookie_file=str(profile_cookie),
            domain_name="chatgpt.com",
            key_file=None,
        )

    def test_arc_skipped_on_linux_without_keyring_lookup(self) -> None:
        self.assertFalse(common._has_cookie_file("arc"))

        with mock.patch.object(
            common.browser_cookie3,
            "arc",
            side_effect=AssertionError("arc loader must not be called on Linux"),
        ) as arc_loader:
            with self.assertRaises(RuntimeError):
                common.load_cookie_candidates("chatgpt.com", ["arc"])

        arc_loader.assert_not_called()

    def test_other_chromium_family_browsers_unaffected(self) -> None:
        cases = (
            ("chrome", ".config/google-chrome/Default/Cookies"),
            ("chromium", ".config/chromium/Default/Cookies"),
            ("brave", ".config/BraveSoftware/Brave-Browser/Default/Cookies"),
            ("edge", ".config/microsoft-edge/Default/Cookies"),
            ("helium", ".config/net.imput.helium/Default/Cookies"),
            ("vivaldi", ".config/vivaldi/Default/Cookies"),
            ("opera", ".config/opera/Cookies"),
        )
        for browser_name, _ in cases:
            self.assertFalse(common._has_cookie_file(browser_name))

        for browser_name, rel_path in cases:
            self._touch(rel_path)
            self.assertTrue(common._has_cookie_file(browser_name))


if __name__ == "__main__":
    unittest.main()
