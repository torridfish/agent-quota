import contextlib
import io
import json
import subprocess
import sys
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
        self.assertEqual(windows["Fable 7d"].get("resets_at"), 1790000000)

    def test_distinct_model_windows_keep_their_own_labels(self) -> None:
        usage = {
            "limits": [
                {"kind": "weekly_all", "percent": 25, "resets_at": 1790000000},
                {
                    "group": "weekly",
                    "scope": {"model": {"display_name": "Sonnet"}},
                    "percent": 40,
                },
                {
                    "group": "weekly",
                    "scope": {"model": {"display_name": "Fable"}},
                    "percent": 10,
                },
            ]
        }
        windows = dict(claude_limit_windows(usage))
        self.assertEqual(windows["Sonnet 7d"]["percent"], 40)
        self.assertEqual(windows["Fable 7d"]["percent"], 10)

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
        self.assertIsNone(windows["Fable 7d"].get("resets_at"))


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
        self.assertEqual([m.label for m in metrics], ["5h", "7d"])
        self.assertEqual(metrics[0].value, "99%")
        self.assertEqual(metrics[1].value, "78%")
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


class CliUserVisibilityTests(unittest.TestCase):
    def test_render_table_omits_user_column_when_show_user_is_false(self) -> None:
        status = agent_quota.ProviderStatus(
            key="claude",
            name="Claude",
            mode="usage",
            plan="Team (Elsa Lab)",
            user="person@example.com",
            metrics=[agent_quota.Metric("5h", "100%", 100.0, "—", is_remaining=True)],
        )
        with_user = agent_quota.render_tables([status], show_user=True)
        without_user = agent_quota.render_tables([status], show_user=False)

        self.assertEqual(len(with_user.columns), 5)
        self.assertEqual(len(without_user.columns), 4)
        headers = [col.header.plain for col in without_user.columns]
        self.assertEqual(headers, ["Provider", "Plan", "Usage / Remaining", "Reset"])


class LazyProviderImportTests(unittest.TestCase):
    """One provider's import failure must not take the whole tool down."""

    class _Broken:
        """sys.modules stand-in whose attribute access raises ImportError."""

        def __getattr__(self, name):
            raise ImportError(f"simulated broken provider module (wanted {name})")

    def test_importing_agent_quota_does_not_import_provider_modules(self) -> None:
        code = (
            "import sys, agent_quota\n"
            "agent_quota._build_providers()\n"
            "bad = [m for m in ('providers.codex', 'providers.zai', 'providers.copilot', 'curl_cffi') if m in sys.modules]\n"
            "print(','.join(bad))\n"
        )
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=Path(__file__).resolve().parent.parent,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "")

    def test_only_claude_works_when_codex_cannot_be_imported(self) -> None:
        out = io.StringIO()
        with mock.patch.dict(sys.modules, {"providers.codex": self._Broken(), "providers.copilot": self._Broken()}), \
                mock.patch.object(agent_quota, "_fetch_claude", lambda browsers: {"source": "test"}), \
                mock.patch.object(agent_quota, "_adapt_claude", lambda raw: []), \
                mock.patch.object(sys, "argv", ["agent-quota", "--json", "--only", "claude"]), \
                contextlib.redirect_stdout(out):
            agent_quota.main()
        payload = json.loads(out.getvalue())
        self.assertEqual([s["key"] for s in payload["statuses"]], ["claude"])
        self.assertFalse(payload["statuses"][0].get("error"))

    def test_only_codex_fails_when_codex_cannot_be_imported(self) -> None:
        providers = agent_quota._build_providers()  # builds fine with the module broken
        with mock.patch.dict(sys.modules, {"providers.codex": self._Broken()}):
            with self.assertRaises(ImportError):
                providers["codex"].fetch(None)
            with self.assertRaises(ImportError):
                providers["codex"].adapt({})
            with self.assertRaises(ImportError):
                providers["codex"].plan({})
            self.assertEqual(providers["claude"].plan.__name__, "_plan_claude")

    def test_token_limit_types_has_one_definition(self) -> None:
        from providers import metrics, zai

        self.assertIs(agent_quota.TOKEN_LIMIT_TYPES, metrics.TOKEN_LIMIT_TYPES)
        self.assertIs(zai.TOKEN_LIMIT_TYPES, metrics.TOKEN_LIMIT_TYPES)


if __name__ == "__main__":
    unittest.main()
