import tempfile
import unittest
from pathlib import Path
from unittest import mock

import agent_quota
from agent_quota import _adapt_zai, _classify
from providers.claude import claude_limit_windows
from providers.zen import (
    _FatalUsageError,
    _resolve_org,
    get_zen_balance,
    load_zen_config,
)


class ClaudeWindowTests(unittest.TestCase):
    def test_model_window_without_reset_inherits_shared_seven_day_reset(self) -> None:
        usage = {
            "limits": [
                {"kind": "weekly_all", "percent": 25, "resets_at": 1790000000},
                {
                    "group": "weekly",
                    "scope": {"model": {"display_name": "Fable"}},
                    "percent": 10,
                },
            ]
        }
        windows = dict(claude_limit_windows(usage))
        self.assertEqual(windows["7d"].get("resets_at"), 1790000000)
        self.assertEqual(windows["7d Fable"].get("resets_at"), 1790000000)

    def test_missing_shared_reset_leaves_model_window_reset_untouched(self) -> None:
        usage = {
            "limits": [
                {
                    "group": "weekly",
                    "scope": {"model": {"display_name": "Fable"}},
                    "percent": 10,
                },
            ]
        }
        windows = dict(claude_limit_windows(usage))
        self.assertIsNone(windows["7d Fable"].get("resets_at"))


class ErrorClassificationTests(unittest.TestCase):
    def test_missing_api_key_message_is_auth_error(self) -> None:
        self.assertEqual(
            _classify(
                RuntimeError(
                    "No OpenCode API key found (searched: x). "
                    "Run `opencode auth login` first."
                )
            ),
            "auth_err",
        )

    def test_no_usable_chatgpt_accounts_is_auth_error(self) -> None:
        self.assertEqual(
            _classify(RuntimeError("No usable ChatGPT accounts found")),
            "auth_err",
        )

    def test_endpoint_unavailable_404_is_net_error(self) -> None:
        self.assertEqual(
            _classify(
                RuntimeError(
                    "Codex usage endpoint unavailable: "
                    "https://chatgpt.com/backend-api/usage: 404"
                )
            ),
            "net_err",
        )


class ZenConfigTests(unittest.TestCase):
    def test_workspace_id_read_from_conf(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "zen.conf"
            path.write_text("# comment\nWORKSPACE_ID = wrk_123\n")
            self.assertEqual(load_zen_config(path)["WORKSPACE_ID"], "wrk_123")

    def test_missing_conf_returns_none_workspace_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(
                load_zen_config(Path(tmp) / "zen.conf")["WORKSPACE_ID"]
            )


class ResolveOrgTests(unittest.TestCase):
    @staticmethod
    def _orgs_response(orgs: list[dict]) -> mock.Mock:
        resp = mock.Mock(status_code=200)
        resp.json.return_value = orgs
        return resp

    def test_explicit_workspace_id_selects_matching_org(self) -> None:
        orgs = [{"id": "wrk_aaa"}, {"id": "wrk_bbb"}]
        with mock.patch(
            "providers.zen.requests.get", return_value=self._orgs_response(orgs)
        ):
            self.assertEqual(_resolve_org({}, "wrk_bbb"), "wrk_bbb")

    def test_unknown_workspace_id_raises_fatal(self) -> None:
        orgs = [{"id": "wrk_aaa"}]
        with mock.patch(
            "providers.zen.requests.get", return_value=self._orgs_response(orgs)
        ):
            with self.assertRaises(_FatalUsageError):
                _resolve_org({}, "wrk_bbb")

    def test_pinned_workspace_error_is_not_swallowed_by_legacy_fallback(self) -> None:
        # A pinned workspace that is not among the account's workspaces
        # must surface as _FatalUsageError, not silently fall through to
        # the legacy scrape (which would return the first workspace's
        # balance instead).
        with mock.patch(
            "providers.zen.load_zen_config",
            return_value={"WORKSPACE_ID": "wrk_missing"},
        ), mock.patch(
            "providers.zen.load_cookies", return_value=({}, "chrome")
        ), mock.patch(
            "providers.zen._fetch_balance_from_console", side_effect=AssertionError(
                "fallback must not be attempted for fatal console errors"
            )
        ), mock.patch(
            "providers.zen._fetch_balance_from_legacy_page",
            side_effect=AssertionError(
                "legacy fallback must not run for fatal console errors"
            ),
        ), mock.patch(
            "providers.zen._resolve_org",
            side_effect=_FatalUsageError(
                "Workspace wrk_missing is not among the account's workspaces"
            ),
        ):
            with self.assertRaises(_FatalUsageError):
                from providers.zen import _fetch_zen_balance_uncached

                _fetch_zen_balance_uncached()

    def test_cache_key_includes_pinned_workspace(self) -> None:
        with mock.patch(
            "providers.zen.load_zen_config",
            return_value={"WORKSPACE_ID": "wrk_bbb"},
        ), mock.patch(
            "providers.zen.get_cached_or_fetch", return_value={"balance": 1.0}
        ) as fetch:
            get_zen_balance()
            self.assertEqual(fetch.call_args.args[0], "zen-balance-wrk_bbb")

        with mock.patch(
            "providers.zen.load_zen_config",
            return_value={"WORKSPACE_ID": None},
        ), mock.patch(
            "providers.zen.get_cached_or_fetch", return_value={"balance": 1.0}
        ) as fetch:
            get_zen_balance()
            self.assertEqual(fetch.call_args.args[0], "zen-balance")


class ZaiWindowTests(unittest.TestCase):
    def test_duplicate_window_labels_are_deduplicated(self) -> None:
        raw = {
            "limits": [
                {"type": "TOKENS_LIMIT", "unit": 3, "percentage": 10},
                {"type": "TOKENS_LIMIT", "unit": 3, "percentage": 20},
            ]
        }
        labels = [m.label for m in _adapt_zai(raw)]
        self.assertEqual(labels, ["5h", "5h 2"])

    def test_unknown_tokens_unit_still_renders(self) -> None:
        raw = {
            "limits": [{"type": "TOKENS_LIMIT", "unit": 7, "percentage": 30}]
        }
        labels = [m.label for m in _adapt_zai(raw)]
        self.assertEqual(labels, ["Tokens"])

    def test_credit_limit_windows_render_through_fallthrough(self) -> None:
        raw = {
            "limits": [
                {
                    "type": "CREDIT_LIMIT",
                    "unit": 3,
                    "usage": 12000,
                    "currentValue": 94,
                    "remaining": 11905,
                    "percentage": 1,
                    "nextResetTime": 1791028382045,
                },
                {
                    "type": "CREDIT_LIMIT",
                    "unit": 6,
                    "usage": 60000,
                    "currentValue": 13637,
                    "remaining": 46362,
                    "percentage": 22,
                    "nextResetTime": 1791198120983,
                },
            ]
        }
        metrics = _adapt_zai(raw)
        self.assertEqual([m.label for m in metrics], ["5h", "Weekly"])
        self.assertEqual(metrics[0].value, "11905 / 12000")
        self.assertAlmostEqual(metrics[0].pct, 99.0)
        self.assertTrue(metrics[1].is_blocking_period)

    def test_unknown_window_type_and_unit_render_with_type_label(self) -> None:
        raw = {
            "limits": [
                {
                    "type": "MYSTERY_LIMIT",
                    "percentage": 40,
                    "remaining": 6,
                    "usage": 10,
                }
            ]
        }
        metrics = _adapt_zai(raw)
        self.assertEqual([m.label for m in metrics], ["Mystery Limit"])
        self.assertEqual(metrics[0].value, "6 / 10")


if __name__ == "__main__":
    unittest.main()
