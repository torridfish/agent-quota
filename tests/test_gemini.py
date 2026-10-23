import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from agent_quota import (
    _adapt_gemini,
    _build_providers,
    _classify,
    _plan_gemini,
    _user_gemini,
)
from providers import antigravity
from providers.antigravity import (
    _ensure_gemini_pool,
    _parse_summary,
    _short_group_name,
    _window_label,
    _worst_gemini_bucket,
    gemini_usage_windows,
    get_gemini_usage,
)


SAMPLE_PAYLOAD = {
    "groups": [
        {
            "displayName": "Gemini Models",
            "buckets": [
                {
                    "bucketId": "gemini-weekly",
                    "displayName": "Weekly Limit Remaining",
                    "window": "weekly",
                    "resetTime": "2026-10-29T07:59:20Z",
                    "remainingFraction": 0.583,
                },
                {
                    "bucketId": "gemini-5h",
                    "displayName": "Five Hour Limit Remaining",
                    "window": "5h",
                    "resetTime": "2026-10-22T12:59:20Z",
                    "remainingFraction": 0.853,
                },
            ],
        },
        {
            "displayName": "Claude and GPT models",
            "buckets": [
                {
                    "bucketId": "3p-weekly",
                    "window": "weekly",
                    "resetTime": "2026-10-31T11:50:43Z",
                    "remainingFraction": 0.886,
                }
            ],
        },
        {
            "displayName": "Gemini 4 Argon",
            "buckets": [
                {
                    "bucketId": "gemini-argon-wtu-weekly",
                    "displayName": "Gemini 4 Argon Weekly Limit",
                    "window": "weekly",
                    "resetTime": "2026-10-29T08:46:43Z",
                    "remainingFraction": 0.97735745,
                }
            ],
        },
    ]
}


class ParseSummaryTests(unittest.TestCase):
    def test_groups_and_buckets_are_normalized(self) -> None:
        groups = _parse_summary(SAMPLE_PAYLOAD)

        self.assertEqual(len(groups), 3)
        self.assertEqual(groups[0]["name"], "Gemini Models")
        buckets = groups[0]["buckets"]
        self.assertEqual(len(buckets), 2)
        self.assertEqual(buckets[0]["bucket_id"], "gemini-weekly")
        self.assertEqual(buckets[0]["window"], "weekly")
        self.assertAlmostEqual(buckets[0]["usage_percent"], 41.7)
        self.assertAlmostEqual(buckets[1]["usage_percent"], 14.7)

    def test_missing_fraction_and_malformed_entries_are_skipped(self) -> None:
        payload = {
            "groups": [
                {"displayName": "X", "buckets": [{"bucketId": "no-fraction"}]},
                "not-a-dict",
                {"displayName": "Y", "buckets": [{"remainingFraction": 1}]},
                {"buckets": "not-a-list"},
            ]
        }
        groups = _parse_summary(payload)

        self.assertEqual([g["name"] for g in groups], ["X", "Y", "Quota"])
        self.assertEqual(groups[0]["buckets"], [])
        self.assertEqual(groups[1]["buckets"][0]["usage_percent"], 0.0)
        self.assertEqual(groups[2]["buckets"], [])

    def test_fraction_is_clamped_to_unit_interval(self) -> None:
        groups = _parse_summary(
            {"groups": [{"displayName": "G", "buckets": [{"remainingFraction": 7.5}]}]}
        )
        self.assertEqual(groups[0]["buckets"][0]["usage_percent"], 0.0)


class WindowLabelTests(unittest.TestCase):
    def test_group_names_are_shortened(self) -> None:
        self.assertEqual(_short_group_name("Gemini Models"), "Gemini")
        self.assertEqual(_short_group_name("Claude and GPT models"), "Claude/GPT")
        self.assertEqual(_short_group_name("Gemini 4 Argon"), "Argon")
        self.assertEqual(_short_group_name("Something Else"), "Something")

    def test_window_label_from_window_and_bucket_id(self) -> None:
        self.assertEqual(_window_label({"window": "5h"}), "5h")
        self.assertEqual(_window_label({"window": "weekly"}), "7d")
        self.assertEqual(_window_label({"bucket_id": "gemini-5h"}), "5h")
        self.assertEqual(_window_label({"bucket_id": "gemini-weekly"}), "7d")
        self.assertEqual(_window_label({"window": "daily"}), "Daily")

    def test_windows_are_prefixed_with_group_label(self) -> None:
        labels = [label for label, _ in gemini_usage_windows({"groups": _parse_summary(SAMPLE_PAYLOAD)})]

        self.assertEqual(
            labels,
            ["Gemini 7d", "Gemini 5h", "Claude/GPT 7d", "Argon 7d"],
        )

    def test_every_pool_renders_weekly_window_as_7d(self) -> None:
        labels = [label for label, _ in gemini_usage_windows({"groups": _parse_summary(SAMPLE_PAYLOAD)})]

        self.assertFalse(any("weekly" in label.lower() for label in labels))
        self.assertEqual(sum(label.endswith(" 7d") for label in labels), 3)

    def test_argon_weekly_does_not_collide_with_gemini_weekly(self) -> None:
        labels = [label for label, _ in gemini_usage_windows({"groups": _parse_summary(SAMPLE_PAYLOAD)})]

        self.assertEqual(labels.count("Gemini 7d"), 1)
        self.assertIn("Argon 7d", labels)


class AdapterTests(unittest.TestCase):
    def test_adapt_gemini_renders_remaining_and_marks_weekly_blocking(self) -> None:
        metrics = _adapt_gemini({"groups": _parse_summary(SAMPLE_PAYLOAD)})

        self.assertEqual(
            [m.label for m in metrics],
            ["Gemini 7d", "Gemini 5h", "Claude/GPT 7d", "Argon 7d"],
        )
        self.assertEqual([m.value for m in metrics], ["58%", "85%", "89%", "98%"])
        self.assertTrue(metrics[0].is_blocking_period)
        self.assertFalse(metrics[1].is_blocking_period)
        self.assertTrue(metrics[3].is_blocking_period)
        # resetTime carries a trailing Z; format_eta handles the ISO form.
        self.assertNotEqual(metrics[0].reset, "—")

    def test_empty_payload_yields_no_metrics(self) -> None:
        self.assertEqual(_adapt_gemini({}), [])

    def test_plan_strips_tier_suffix(self) -> None:
        self.assertEqual(_plan_gemini({"identity": {"plan": "free-tier"}}), "Free")
        self.assertEqual(_plan_gemini({"identity": {"plan": "pro-tier"}}), "Pro")
        self.assertEqual(
            _plan_gemini({"identity": {"plan_name": "Antigravity"}}), "Antigravity"
        )
        self.assertEqual(_plan_gemini({"identity": {}}), "Unknown")

    def test_user_falls_back_to_unknown(self) -> None:
        self.assertEqual(_user_gemini({"identity": {"email": "a@b.c"}}), "a@b.c")
        self.assertEqual(_user_gemini({}), "Unknown")

    def test_provider_is_registered_in_usage_mode(self) -> None:
        providers = _build_providers()

        self.assertIn("gemini", providers)
        self.assertEqual(providers["gemini"].mode, "usage")
        self.assertEqual(providers["gemini"].name, "Gemini")


class GeminiPoolFallbackTests(unittest.TestCase):
    PER_MODEL = {
        "chat_20706": {"quotaInfo": {"remainingFraction": 1, "resetTime": ""}},
        "claude-opus-5-5-high": {
            "quotaInfo": {"remainingFraction": 0.5, "resetTime": "2026-10-22T13:17:18Z"}
        },
        "gemini-2.5-pro": {
            "quotaInfo": {"remainingFraction": 0.998176, "resetTime": "2026-10-22T12:01:06Z"}
        },
        "gemini-3.8-flash-tiered": {
            "quotaInfo": {"remainingFraction": 0.9, "resetTime": "2026-10-22T12:01:06Z"}
        },
        "gemini-broken": {"quotaInfo": {"remainingFraction": "NaN-ish"}},
        "gemini-empty": {},
    }

    def test_worst_bucket_uses_lowest_gemini_fraction(self) -> None:
        bucket = _worst_gemini_bucket(self.PER_MODEL)

        self.assertEqual(bucket["bucket_id"], "gemini-5h")
        self.assertEqual(bucket["window"], "5h")
        self.assertAlmostEqual(bucket["usage_percent"], 10.0)
        self.assertEqual(bucket["reset_at"], "2026-10-22T12:01:06Z")

    def test_worst_bucket_returns_none_without_gemini_data(self) -> None:
        models = {"claude-opus": {"quotaInfo": {"remainingFraction": 1}}}
        self.assertIsNone(_worst_gemini_bucket(models))
        self.assertIsNone(_worst_gemini_bucket({}))

    THREE_P_ONLY_GROUPS = _parse_summary(
        {"groups": [SAMPLE_PAYLOAD["groups"][1]]}
    )

    def test_missing_gemini_group_is_backfilled(self) -> None:
        merged = _ensure_gemini_pool(
            self.THREE_P_ONLY_GROUPS,
            "token",
            "project",
            fetch_model_fractions=lambda token, project: self.PER_MODEL,
        )

        labels = [label for label, _ in gemini_usage_windows({"groups": merged})]
        self.assertEqual(labels[-1], "Gemini 5h")

    def test_existing_gemini_5h_is_not_duplicated(self) -> None:
        groups = list(self.THREE_P_ONLY_GROUPS)
        groups.append(
            {
                "name": "Gemini Models",
                "buckets": [
                    {"bucket_id": "gemini-5h", "window": "5h", "usage_percent": 5.0}
                ],
            }
        )
        merged = _ensure_gemini_pool(
            groups,
            "token",
            "project",
            fetch_model_fractions=lambda token, project: self.fail("fetch must not be called"),
        )

        labels = [label for label, _ in gemini_usage_windows({"groups": merged})]
        self.assertEqual(labels.count("Gemini 5h"), 1)

    def test_gemini_group_without_5h_gets_bucket_appended(self) -> None:
        groups = [{"name": "Gemini Models", "buckets": []}]
        merged = _ensure_gemini_pool(
            groups,
            "token",
            "project",
            fetch_model_fractions=lambda token, project: self.PER_MODEL,
        )

        self.assertEqual(len(merged), 1)
        self.assertEqual(len(merged[0]["buckets"]), 1)

    def test_fetch_failure_leaves_groups_untouched(self) -> None:
        merged = _ensure_gemini_pool(
            self.THREE_P_ONLY_GROUPS,
            "token",
            "project",
            fetch_model_fractions=lambda token, project: None,
        )

        self.assertEqual(merged, self.THREE_P_ONLY_GROUPS)


class ClientUserAgentTests(unittest.TestCase):
    def setUp(self) -> None:
        antigravity._agy_version.cache_clear()
        antigravity._agy_binary.cache_clear()

    def tearDown(self) -> None:
        antigravity._agy_version.cache_clear()
        antigravity._agy_binary.cache_clear()

    def test_version_comes_from_the_installed_cli(self) -> None:
        proc = mock.Mock(stdout="1.4.5\n", returncode=0)
        with mock.patch.object(
            antigravity, "_agy_binary", return_value="/usr/bin/agy"
        ):
            with mock.patch.object(
                antigravity.subprocess, "run", return_value=proc
            ) as run:
                self.assertEqual(antigravity._agy_version(), "1.4.5")
                user_agent = antigravity._agy_user_agent()

        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ["/usr/bin/agy", "--version"])
        self.assertTrue(user_agent.startswith("antigravity/cli/1.4.5 ("))
        self.assertIn("auth_method=consumer", user_agent)

    def test_prerelease_version_is_preserved(self) -> None:
        proc = mock.Mock(stdout="1.5.0-beta.2\n", returncode=0)
        with mock.patch.object(antigravity.subprocess, "run", return_value=proc):
            self.assertEqual(antigravity._agy_version(), "1.5.0-beta.2")

    def test_missing_cli_falls_back_to_the_pinned_version(self) -> None:
        with mock.patch.object(antigravity, "_agy_binary", return_value=None):
            with mock.patch.object(
                antigravity.subprocess, "run", side_effect=AssertionError("no spawn")
            ):
                self.assertEqual(
                    antigravity._agy_version(), antigravity._AGY_UA_FALLBACK_VERSION
                )
                user_agent = antigravity._agy_user_agent()

        self.assertTrue(
            user_agent.startswith(
                f"antigravity/cli/{antigravity._AGY_UA_FALLBACK_VERSION} ("
            )
        )

    def test_broken_binary_falls_back_to_the_pinned_version(self) -> None:
        with mock.patch.object(
            antigravity, "_agy_binary", return_value="/usr/bin/agy"
        ):
            with mock.patch.object(
                antigravity.subprocess, "run", side_effect=FileNotFoundError
            ):
                self.assertEqual(
                    antigravity._agy_version(), antigravity._AGY_UA_FALLBACK_VERSION
                )

    def test_unparseable_output_falls_back(self) -> None:
        proc = mock.Mock(stdout="garbage", returncode=1)
        with mock.patch.object(antigravity.subprocess, "run", return_value=proc):
            self.assertEqual(
                antigravity._agy_version(), antigravity._AGY_UA_FALLBACK_VERSION
            )


class IdentityTests(unittest.TestCase):
    def test_paid_tier_outranks_free_current_tier(self) -> None:
        identity = antigravity._api_identity(
            {},
            {
                "tier": {"id": "free-tier", "name": "Antigravity"},
                "paid_tier": {"id": "g1-pro-tier", "name": "Google AI Pro"},
                "project": "aicode-consumers",
            },
        )

        self.assertEqual(identity["plan"], "pro")
        self.assertEqual(identity["plan_name"], "Google AI Pro")
        self.assertEqual(_plan_gemini({"identity": identity}), "Pro")

    def test_without_paid_tier_the_current_tier_is_used(self) -> None:
        identity = antigravity._api_identity(
            {}, {"tier": {"id": "free-tier", "name": "Antigravity"}}
        )

        self.assertEqual(identity["plan"], "free")
        self.assertEqual(_plan_gemini({"identity": identity}), "Free")

    def test_plan_ids_are_normalized(self) -> None:
        self.assertEqual(antigravity._normalize_plan_id("g1-pro-tier"), "pro")
        self.assertEqual(antigravity._normalize_plan_id("g1-ultra-tier"), "ultra")
        self.assertEqual(antigravity._normalize_plan_id("standard-tier"), "standard")
        self.assertEqual(antigravity._normalize_plan_id(""), "")

    def test_empty_code_assist_yields_unknown_plan(self) -> None:
        identity = antigravity._api_identity({}, {})

        self.assertEqual(identity["plan"], "")
        self.assertEqual(_plan_gemini({"identity": identity}), "Unknown")

    def test_account_email_prefers_direct_id_token_email_field(self) -> None:
        self.assertEqual(
            antigravity._account_email({"id_token_email": "user@example.com"}),
            "user@example.com",
        )


class CodeAssistTests(unittest.TestCase):
    PAYLOAD = {
        "currentTier": {"id": "free-tier", "name": "Antigravity"},
        "paidTier": {"id": "g1-pro-tier", "name": "Google AI Pro"},
        "cloudaicompanionProject": "aicode-consumers",
    }
    INFO = {
        "tier": {"id": "free-tier", "name": "Antigravity"},
        "paid_tier": {"id": "g1-pro-tier", "name": "Google AI Pro"},
        "project": "aicode-consumers",
    }

    @staticmethod
    def _response(payload: dict) -> mock.Mock:
        resp = mock.Mock(status_code=200)
        resp.raise_for_status = mock.Mock()
        resp.json.return_value = payload
        return resp

    def test_project_and_tiers_are_parsed(self) -> None:
        with mock.patch.object(
            antigravity.requests, "post", return_value=self._response(self.PAYLOAD)
        ):
            info = antigravity._fetch_code_assist("token")

        self.assertEqual(info["project"], "aicode-consumers")
        self.assertEqual(info["tier"]["id"], "free-tier")
        self.assertEqual(info["paid_tier"]["id"], "g1-pro-tier")

    def test_failure_returns_an_empty_dict(self) -> None:
        with mock.patch.object(
            antigravity.requests, "post", side_effect=RuntimeError("boom")
        ):
            self.assertEqual(antigravity._fetch_code_assist("token"), {})

    def test_quota_request_uses_the_code_assist_project(self) -> None:
        payload = {"groups": [SAMPLE_PAYLOAD["groups"][0]]}
        with (
            mock.patch.object(antigravity, "_load_token_data", return_value={"token": {}}),
            mock.patch.object(antigravity, "_resolve_access_token", return_value="tok"),
            mock.patch.object(antigravity, "_fetch_code_assist", return_value=self.INFO),
            mock.patch.object(
                antigravity, "_fetch_quota_summary", return_value=payload
            ) as summary,
        ):
            usage = antigravity._fetch_gemini_usage_uncached()

        summary.assert_called_once_with("tok", "aicode-consumers")
        self.assertEqual(usage["identity"]["plan"], "pro")

    def test_quota_request_falls_back_to_the_cached_project(self) -> None:
        payload = {"groups": [SAMPLE_PAYLOAD["groups"][0]]}
        with (
            mock.patch.object(antigravity, "_load_token_data", return_value={"token": {}}),
            mock.patch.object(antigravity, "_resolve_access_token", return_value="tok"),
            mock.patch.object(antigravity, "_fetch_code_assist", return_value={}),
            mock.patch.object(
                antigravity, "_read_project_id", return_value="cached-project"
            ),
            mock.patch.object(
                antigravity, "_fetch_quota_summary", return_value=payload
            ) as summary,
        ):
            antigravity._fetch_gemini_usage_uncached()

        summary.assert_called_once_with("tok", "cached-project")

    def test_quota_request_retries_once_with_forced_refresh_on_401(self) -> None:
        payload = {"groups": [SAMPLE_PAYLOAD["groups"][0]]}
        with (
            mock.patch.object(antigravity, "_load_token_data", return_value={"token": {}}),
            mock.patch.object(
                antigravity,
                "_resolve_access_token",
                side_effect=["stale-tok", "fresh-tok"],
            ) as resolve,
            mock.patch.object(antigravity, "_fetch_code_assist", return_value=self.INFO),
            mock.patch.object(
                antigravity,
                "_fetch_quota_summary",
                side_effect=[
                    RuntimeError("401 Unauthorized on retrieveUserQuotaSummary"),
                    payload,
                ],
            ) as summary,
        ):
            usage = antigravity._fetch_gemini_usage_uncached()

        self.assertEqual(resolve.call_count, 2)
        resolve.assert_called_with(force_refresh=True)
        self.assertEqual(summary.call_count, 2)
        self.assertEqual(usage["identity"]["plan"], "pro")


class TokenStorageTests(unittest.TestCase):
    def test_expiry_parses_iso_and_z_forms(self) -> None:
        self.assertIsNotNone(antigravity._parse_expiry("2026-10-22T16:57:35.707355781+08:00"))
        self.assertIsNotNone(antigravity._parse_expiry("2026-10-22T08:57:35Z"))
        self.assertIsNone(antigravity._parse_expiry("garbage"))
        self.assertIsNone(antigravity._parse_expiry(None))

    def test_missing_project_id_falls_back_to_blank(self) -> None:
        with mock.patch.object(
            antigravity, "PROJECT_ID_PATH", antigravity.Path("/nonexistent/project.txt")
        ):
            self.assertEqual(antigravity._read_project_id(), " ")

    def test_get_gemini_usage_ignores_browser_argument(self) -> None:
        with mock.patch.object(
            antigravity, "get_cached_or_fetch", return_value={"groups": []}
        ) as cached:
            self.assertEqual(get_gemini_usage(["firefox"]), {"groups": []})
            cached.assert_called_once_with(
                "gemini", antigravity._fetch_gemini_usage_uncached, ttl=antigravity.CACHE_TTL
            )


# Fake credentials only: no real OAuth client values appear in this file.
FAKE_CLIENT_ID = "fake-client-id"
FAKE_CLIENT_SECRET = "fake-client-secret"


def _expiry(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat()


def _stored_token(expiry: str | None) -> dict:
    token: dict = {
        "access_token": "stored-access-token",
        "refresh_token": "stored-refresh-token",
    }
    if expiry is not None:
        token["expiry"] = expiry
    return {"token": token}


class GeminiConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def test_missing_file_yields_no_credentials(self) -> None:
        config = antigravity.load_gemini_config(self.dir / "missing.conf")

        self.assertEqual(
            config,
            {"GEMINI_CLIENT_ID": None, "GEMINI_CLIENT_SECRET": None},
        )

    def test_values_are_read_and_whitespace_trimmed(self) -> None:
        path = self.dir / "gemini.conf"
        path.write_text(
            "# comment\n"
            "\n"
            f"GEMINI_CLIENT_ID = {FAKE_CLIENT_ID}  \n"
            f"GEMINI_CLIENT_SECRET={FAKE_CLIENT_SECRET}\n"
            "UNRELATED=ignored\n"
        )

        config = antigravity.load_gemini_config(path)

        self.assertEqual(config["GEMINI_CLIENT_ID"], FAKE_CLIENT_ID)
        self.assertEqual(config["GEMINI_CLIENT_SECRET"], FAKE_CLIENT_SECRET)

    def test_blank_and_malformed_entries_stay_missing(self) -> None:
        path = self.dir / "gemini.conf"
        path.write_text(
            "GEMINI_CLIENT_ID=\n"
            "GEMINI_CLIENT_SECRET   # no '=' separator\n"
            "GEMINI_CLIENT_SECRET=   \n"
        )

        config = antigravity.load_gemini_config(path)

        self.assertIsNone(config["GEMINI_CLIENT_ID"])
        self.assertIsNone(config["GEMINI_CLIENT_SECRET"])

    def test_unreadable_path_is_treated_as_missing(self) -> None:
        # A directory exists but cannot be read as a text file.
        config = antigravity.load_gemini_config(self.dir)

        self.assertEqual(
            config,
            {"GEMINI_CLIENT_ID": None, "GEMINI_CLIENT_SECRET": None},
        )


class GeminiRefreshTests(unittest.TestCase):
    def setUp(self) -> None:
        antigravity._cached_access.clear()
        antigravity._agy_binary_credentials.cache_clear()
        self.addCleanup(antigravity._cached_access.clear)
        self.addCleanup(antigravity._agy_binary_credentials.cache_clear)
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.token_cache_path = Path(self._tmp.name) / "gemini-token.json"
        self._cache_patch = mock.patch.object(
            antigravity, "TOKEN_CACHE_PATH", self.token_cache_path
        )
        self._cache_patch.start()
        self.addCleanup(self._cache_patch.stop)

    @staticmethod
    def _response(payload: dict, status: int = 200) -> mock.Mock:
        resp = mock.Mock(status_code=status)
        resp.json.return_value = payload
        return resp

    def test_refresh_posts_the_configured_client_credentials(self) -> None:
        with mock.patch.object(
            antigravity.requests,
            "post",
            return_value=self._response({"access_token": "fresh", "expires_in": 3600}),
        ) as post:
            payload = antigravity._refresh_access_token(
                "stored-refresh-token", FAKE_CLIENT_ID, FAKE_CLIENT_SECRET
            )

        self.assertEqual(payload["access_token"], "fresh")
        post.assert_called_once_with(
            antigravity._TOKEN_URL,
            json={
                "client_id": FAKE_CLIENT_ID,
                "client_secret": FAKE_CLIENT_SECRET,
                "refresh_token": "stored-refresh-token",
                "grant_type": "refresh_token",
            },
            timeout=antigravity.REQUEST_TIMEOUT,
            impersonate="chrome",
        )

    def test_refresh_http_error_is_reported(self) -> None:
        with mock.patch.object(
            antigravity.requests, "post", return_value=self._response({}, status=400)
        ):
            with self.assertRaisesRegex(RuntimeError, "HTTP 400"):
                antigravity._refresh_access_token(
                    "stored-refresh-token", FAKE_CLIENT_ID, FAKE_CLIENT_SECRET
                )

    def test_refresh_without_access_token_is_rejected(self) -> None:
        with mock.patch.object(
            antigravity.requests,
            "post",
            return_value=self._response({"expires_in": 3600}),
        ):
            with self.assertRaisesRegex(RuntimeError, "no access_token"):
                antigravity._refresh_access_token(
                    "stored-refresh-token", FAKE_CLIENT_ID, FAKE_CLIENT_SECRET
                )

    def test_unexpired_token_never_reads_the_config(self) -> None:
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value=_stored_token(_expiry(timedelta(hours=1))),
            ),
            mock.patch.object(
                antigravity, "load_gemini_config", side_effect=AssertionError("config read")
            ),
            mock.patch.object(
                antigravity, "_refresh_access_token", side_effect=AssertionError("refresh")
            ),
        ):
            self.assertEqual(antigravity._resolve_access_token(), "stored-access-token")

    def test_in_memory_token_is_reused_without_touching_disk_or_config(self) -> None:
        antigravity._cached_access["access_token"] = "cached-access-token"
        antigravity._cached_access["expires_monotonic"] = (
            antigravity.time.monotonic() + 3600
        )

        with (
            mock.patch.object(
                antigravity, "_load_token_data", side_effect=AssertionError("disk read")
            ),
            mock.patch.object(
                antigravity, "load_gemini_config", side_effect=AssertionError("config read")
            ),
        ):
            self.assertEqual(antigravity._resolve_access_token(), "cached-access-token")

    def test_expired_token_without_config_names_file_and_keys(self) -> None:
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value=_stored_token(_expiry(timedelta(hours=-1))),
            ),
            mock.patch.object(
                antigravity,
                "load_gemini_config",
                return_value={"GEMINI_CLIENT_ID": None, "GEMINI_CLIENT_SECRET": None},
            ),
            mock.patch.object(antigravity, "_agy_binary_credentials", return_value=[]),
            mock.patch.object(
                antigravity, "_refresh_access_token", side_effect=AssertionError("refresh")
            ),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                antigravity._resolve_access_token()

        message = str(ctx.exception)
        self.assertIn(str(antigravity.CONFIG_PATH), message)
        self.assertIn("GEMINI_CLIENT_ID", message)
        self.assertIn("GEMINI_CLIENT_SECRET", message)
        self.assertIn("agy", message)
        self.assertEqual(_classify(ctx.exception), "auth_err")

    def test_partial_config_names_only_the_missing_key(self) -> None:
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value=_stored_token(_expiry(timedelta(hours=-1))),
            ),
            mock.patch.object(
                antigravity,
                "load_gemini_config",
                return_value={"GEMINI_CLIENT_ID": FAKE_CLIENT_ID, "GEMINI_CLIENT_SECRET": None},
            ),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                antigravity._resolve_access_token()

        message = str(ctx.exception)
        self.assertIn("GEMINI_CLIENT_SECRET", message)
        self.assertNotIn("GEMINI_CLIENT_ID,", message)

    def test_expired_token_with_config_refreshes_and_caches_in_memory(self) -> None:
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value=_stored_token(_expiry(timedelta(hours=-1))),
            ),
            mock.patch.object(
                antigravity,
                "load_gemini_config",
                return_value={
                    "GEMINI_CLIENT_ID": FAKE_CLIENT_ID,
                    "GEMINI_CLIENT_SECRET": FAKE_CLIENT_SECRET,
                },
            ),
            mock.patch.object(
                antigravity,
                "_refresh_access_token",
                return_value={"access_token": "fresh-access-token", "expires_in": 3600},
            ) as refresh,
        ):
            self.assertEqual(antigravity._resolve_access_token(), "fresh-access-token")
            # Second call within the same process uses the in-memory token.
            self.assertEqual(antigravity._resolve_access_token(), "fresh-access-token")

        refresh.assert_called_once_with(
            "stored-refresh-token", FAKE_CLIENT_ID, FAKE_CLIENT_SECRET
        )

    def test_refreshed_token_is_persisted_on_disk_for_subsequent_processes(self) -> None:
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value=_stored_token(_expiry(timedelta(hours=-1))),
            ),
            mock.patch.object(
                antigravity,
                "load_gemini_config",
                return_value={
                    "GEMINI_CLIENT_ID": FAKE_CLIENT_ID,
                    "GEMINI_CLIENT_SECRET": FAKE_CLIENT_SECRET,
                },
            ),
            mock.patch.object(
                antigravity,
                "_refresh_access_token",
                return_value={"access_token": "disk-cached-token", "expires_in": 3600},
            ) as refresh,
        ):
            self.assertEqual(antigravity._resolve_access_token(), "disk-cached-token")

        self.assertTrue(self.token_cache_path.is_file())
        # Simulate a new process where the in-memory cache is empty.
        antigravity._cached_access.clear()
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value=_stored_token(_expiry(timedelta(hours=-1))),
            ),
            mock.patch.object(
                antigravity, "load_gemini_config", side_effect=AssertionError("config read")
            ),
            mock.patch.object(
                antigravity, "_refresh_access_token", side_effect=AssertionError("refresh")
            ),
        ):
            self.assertEqual(antigravity._resolve_access_token(), "disk-cached-token")

        self.assertEqual(refresh.call_count, 1)

    def test_disk_cached_token_is_invalidated_when_refresh_token_changes(self) -> None:
        antigravity._write_cached_access_token(
            "old-refresh-token", "stale-cached-token", 3600.0
        )
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value=_stored_token(_expiry(timedelta(hours=-1))),
            ),
            mock.patch.object(
                antigravity,
                "load_gemini_config",
                return_value={
                    "GEMINI_CLIENT_ID": FAKE_CLIENT_ID,
                    "GEMINI_CLIENT_SECRET": FAKE_CLIENT_SECRET,
                },
            ),
            mock.patch.object(
                antigravity,
                "_refresh_access_token",
                return_value={"access_token": "new-account-token", "expires_in": 3600},
            ) as refresh,
        ):
            self.assertEqual(antigravity._resolve_access_token(), "new-account-token")

        refresh.assert_called_once()

    def test_extract_agy_credentials_prioritizes_73_byte_client_id(self) -> None:
        cid_72 = "1" * 12 + "-" + "a" * 32 + ".apps.googleusercontent.com"
        cid_73 = "2" * 13 + "-" + "b" * 32 + ".apps.googleusercontent.com"
        csec_1 = "GOCSPX-" + "x" * 28
        csec_2 = "GOCSPX-" + "y" * 28
        blob = (
            b"padding"
            + csec_1.encode("ascii")
            + csec_2.encode("ascii")
            + b"middle"
            + cid_72.encode("ascii")
            + cid_73.encode("ascii")
            + b"tail"
        )

        candidates = antigravity._extract_agy_credentials_from_bytes(blob)

        self.assertEqual(candidates[0], (cid_73, csec_1))
        self.assertIn((cid_72, csec_2), candidates)

    def test_expired_token_falls_back_to_agy_binary_credentials_and_retries_candidates(
        self,
    ) -> None:
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value=_stored_token(_expiry(timedelta(hours=-1))),
            ),
            mock.patch.object(
                antigravity,
                "load_gemini_config",
                return_value={"GEMINI_CLIENT_ID": None, "GEMINI_CLIENT_SECRET": None},
            ),
            mock.patch.object(
                antigravity,
                "_agy_binary_credentials",
                return_value=[("wrong-id", "wrong-secret"), (FAKE_CLIENT_ID, FAKE_CLIENT_SECRET)],
            ),
            mock.patch.object(
                antigravity,
                "_refresh_access_token",
                side_effect=[
                    RuntimeError("Token refresh failed with HTTP 401."),
                    {"access_token": "binary-refreshed-token", "expires_in": 3600},
                ],
            ) as refresh,
        ):
            self.assertEqual(
                antigravity._resolve_access_token(), "binary-refreshed-token"
            )

        self.assertEqual(refresh.call_count, 2)

    def test_expired_token_without_refresh_token_does_not_read_config(self) -> None:
        with (
            mock.patch.object(
                antigravity,
                "_load_token_data",
                return_value={"token": {"access_token": "stored-access-token"}},
            ),
            mock.patch.object(
                antigravity, "load_gemini_config", side_effect=AssertionError("config read")
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "no refresh token"):
                antigravity._resolve_access_token()


if __name__ == "__main__":
    unittest.main()
