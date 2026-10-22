"""Tests for the Google Colab compute-unit provider.

Everything here is mocked: no token file from the real user is read, no Colab
endpoint is contacted, and no request is made to the token refresh endpoint.
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from agent_quota import (
    PROVIDER_META,
    _adapt_colab,
    _build_providers,
    _classify,
    _fetch_colab,
    _plan_colab,
    _Provider,
    fetch_one,
)
from providers import colab

FAKE_ACCESS = "fake-access-token"
FAKE_REFRESH = "fake-refresh-token"


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat().replace("+00:00", "Z")


def _credentials(**overrides) -> dict:
    data = {
        "token": FAKE_ACCESS,
        "refresh_token": FAKE_REFRESH,
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": "fake-client-id.apps.googleusercontent.com",
        "client_secret": "fake-client-secret",
        "scopes": ["https://www.googleapis.com/auth/colaboratory"],
        "expiry": _iso(timedelta(hours=1)),
    }
    data.update(overrides)
    return data


def _fake_response(body: bytes | str):
    response = mock.MagicMock()
    response.__enter__.return_value.read.return_value = (
        body.encode() if isinstance(body, str) else body
    )
    return response


class ColabTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        colab._cached_access.clear()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.addCleanup(colab._cached_access.clear)
        self.path = Path(self._tmp.name) / "token.json"

    def _write(self, data: object) -> bytes:
        raw = json.dumps(data)
        self.path.write_text(raw)
        return raw.encode()

    def test_missing_token_file_names_path_and_how_to_sign_in(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            colab._load_credentials(self.path)

        message = str(ctx.exception)
        self.assertIn(str(self.path), message)
        self.assertIn("colab usage", message)
        # Missing credentials are an auth problem, not a transient network one.
        self.assertEqual(_classify(ctx.exception), "auth_err")

    def test_malformed_json_is_reported_without_echoing_contents(self) -> None:
        self.path.write_text("not-json but contains super-secret-value")

        with self.assertRaises(RuntimeError) as ctx:
            colab._load_credentials(self.path)

        message = str(ctx.exception)
        self.assertIn("not valid JSON", message)
        self.assertNotIn("super-secret-value", message)
        self.assertEqual(_classify(ctx.exception), "auth_err")

    def test_token_file_must_be_a_json_object(self) -> None:
        self._write([FAKE_ACCESS])

        with self.assertRaisesRegex(RuntimeError, "not a JSON object"):
            colab._load_credentials(self.path)

    def test_token_file_without_any_token_is_rejected(self) -> None:
        self._write({"client_id": "abc", "client_secret": "def"})

        with self.assertRaisesRegex(RuntimeError, "neither an access token nor"):
            colab._load_credentials(self.path)

    def test_unexpired_access_token_is_used_without_refresh(self) -> None:
        self._write(_credentials())

        with mock.patch.object(
            colab, "_refresh_access_token", side_effect=AssertionError("refreshed")
        ):
            token = colab._resolve_access_token(self.path)

        self.assertEqual(token, FAKE_ACCESS)

    def test_missing_expiry_forces_a_refresh(self) -> None:
        payload = _credentials()
        payload.pop("expiry")
        self._write(payload)

        with mock.patch.object(
            colab,
            "_refresh_access_token",
            return_value={"access_token": "fresh", "expires_in": 3600},
        ) as refresh:
            token = colab._resolve_access_token(self.path)

        self.assertEqual(token, "fresh")
        refresh.assert_called_once()

    def test_expired_token_refreshes_in_memory_and_leaves_file_untouched(self) -> None:
        original = self._write(
            _credentials(
                expiry=_iso(timedelta(hours=-1)),
                token="stale-access-token",
            )
        )

        with mock.patch.object(
            colab.urllib.request,
            "urlopen",
            return_value=_fake_response(
                json.dumps({"access_token": "fresh-access", "expires_in": 3599})
            ),
        ) as urlopen:
            token = colab._resolve_access_token(self.path)

        self.assertEqual(token, "fresh-access")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_method(), "POST")
        body = request.data.decode()
        self.assertIn("grant_type=refresh_token", body)
        self.assertIn(f"refresh_token={FAKE_REFRESH}", body)
        self.assertNotIn(FAKE_ACCESS, body)
        # Never persist refreshed credentials: the colab-cli file is read-only
        # to us.
        self.assertEqual(self.path.read_bytes(), original)

    def test_missing_expiry_and_refresh_token_is_an_auth_error(self) -> None:
        payload = _credentials(expiry=None)
        payload.pop("refresh_token")
        self._write(payload)

        with self.assertRaises(RuntimeError) as ctx:
            colab._resolve_access_token(self.path)

        self.assertIn("no refresh token", str(ctx.exception).lower())
        self.assertEqual(_classify(ctx.exception), "auth_err")

    def test_refresh_without_client_credentials_is_explained(self) -> None:
        payload = _credentials(expiry=_iso(timedelta(hours=-1)))
        payload.pop("client_secret")
        self._write(payload)

        with self.assertRaisesRegex(RuntimeError, "client_secret"):
            colab._resolve_access_token(self.path)

    def test_refresh_http_error_does_not_expose_secrets(self) -> None:
        self._write(_credentials(expiry=_iso(timedelta(hours=-1))))
        error = urllib.error.HTTPError(
            "https://oauth2.googleapis.com/token", 400, "Bad Request", {}, io.BytesIO(b"")
        )

        with mock.patch.object(colab.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(RuntimeError) as ctx:
                colab._resolve_access_token(self.path)

        message = str(ctx.exception)
        self.assertIn("HTTP 400", message)
        self.assertIn("colab usage", message)
        self.assertNotIn(FAKE_REFRESH, message)
        self.assertEqual(_classify(ctx.exception), "auth_err")

    def test_refresh_response_without_access_token_is_rejected(self) -> None:
        self._write(_credentials(expiry=_iso(timedelta(hours=-1))))

        with mock.patch.object(
            colab.urllib.request,
            "urlopen",
            return_value=_fake_response(json.dumps({"expires_in": 3600})),
        ):
            with self.assertRaisesRegex(RuntimeError, "no access_token"):
                colab._resolve_access_token(self.path)

    def test_refreshed_token_is_reused_within_the_process(self) -> None:
        self._write(_credentials(expiry=_iso(timedelta(hours=-1))))

        with mock.patch.object(
            colab.urllib.request,
            "urlopen",
            return_value=_fake_response(
                json.dumps({"access_token": "fresh-access", "expires_in": 3600})
            ),
        ) as urlopen:
            first = colab._resolve_access_token(self.path)
            second = colab._resolve_access_token(self.path)

        self.assertEqual(first, "fresh-access")
        self.assertEqual(second, "fresh-access")
        urlopen.assert_called_once()


class ColabApiParsingTests(unittest.TestCase):
    def test_xssi_prefixed_payload_is_parsed(self) -> None:
        body = (
            ")]}'\n"
            + json.dumps(
                {
                    "currentBalance": 42.5,
                    "consumptionRateHourly": 1.25,
                    "assignmentsCount": 2,
                }
            )
        )

        self.assertEqual(
            colab._parse_ccu_info(body),
            {"balance": 42.5, "rate_per_hour": 1.25, "assignments": 2},
        )

    def test_payload_without_xssi_prefix_is_accepted(self) -> None:
        body = json.dumps(
            {
                "currentBalance": 0.0,
                "consumptionRateHourly": 0.0,
                "assignmentsCount": 0,
            }
        )

        self.assertEqual(
            colab._parse_ccu_info(body),
            {"balance": 0.0, "rate_per_hour": 0.0, "assignments": 0},
        )

    def test_empty_response_is_an_error(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "empty ccu-info response"):
            colab._parse_ccu_info(")]}'\n")

    def test_invalid_json_is_an_error(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "not valid JSON"):
            colab._parse_ccu_info(")]}'\n<not json>")

    def test_non_object_payload_is_an_error(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "not a JSON object"):
            colab._parse_ccu_info("[]")

    def test_missing_field_is_an_error(self) -> None:
        body = json.dumps(
            {"currentBalance": 1.0, "consumptionRateHourly": 1.0}
        )

        with self.assertRaisesRegex(RuntimeError, "assignmentsCount"):
            colab._parse_ccu_info(body)

    def test_non_numeric_field_is_an_error(self) -> None:
        body = json.dumps(
            {
                "currentBalance": "12.0",
                "consumptionRateHourly": 1.0,
                "assignmentsCount": 0,
            }
        )

        with self.assertRaisesRegex(RuntimeError, "non-numeric currentBalance"):
            colab._parse_ccu_info(body)

    def test_boolean_field_is_not_accepted_as_a_number(self) -> None:
        body = json.dumps(
            {
                "currentBalance": True,
                "consumptionRateHourly": 1.0,
                "assignmentsCount": 0,
            }
        )

        with self.assertRaisesRegex(RuntimeError, "non-numeric currentBalance"):
            colab._parse_ccu_info(body)


class ColabRequestTests(unittest.TestCase):
    def setUp(self) -> None:
        colab._cached_access.clear()
        self.addCleanup(colab._cached_access.clear)

    def test_request_uses_colab_headers_and_bearer_token(self) -> None:
        body = (
            ")]}'\n"
            + json.dumps(
                {
                    "currentBalance": 7.0,
                    "consumptionRateHourly": 0.5,
                    "assignmentsCount": 1,
                }
            )
        )

        with mock.patch.object(
            colab, "_resolve_access_token", return_value=FAKE_ACCESS
        ), mock.patch.object(
            colab.urllib.request, "urlopen", return_value=_fake_response(body)
        ) as urlopen:
            data = colab._get_ccu_info(FAKE_ACCESS)

        request = urlopen.call_args.args[0]
        self.assertIn("/tun/m/ccu-info", request.full_url)
        self.assertIn("authuser=0", request.full_url)
        self.assertEqual(request.get_header("Authorization"), f"Bearer {FAKE_ACCESS}")
        self.assertEqual(request.get_header("Accept"), "application/json")
        self.assertEqual(request.get_header("X-colab-client-agent"), "colab-cli")
        self.assertEqual(data["balance"], 7.0)

    def test_401_is_reported_as_an_auth_error_without_the_token(self) -> None:
        error = urllib.error.HTTPError(
            colab.CCU_INFO_URL, 401, "Unauthorized", {}, io.BytesIO(b"")
        )

        with mock.patch.object(colab.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(RuntimeError) as ctx:
                colab._get_ccu_info(FAKE_ACCESS)

        message = str(ctx.exception)
        self.assertIn("HTTP 401", message)
        self.assertIn("colab usage", message)
        self.assertNotIn(FAKE_ACCESS, message)
        self.assertEqual(_classify(ctx.exception), "auth_err")

    def test_server_error_is_reported_as_a_network_error(self) -> None:
        error = urllib.error.HTTPError(
            colab.CCU_INFO_URL, 503, "Service Unavailable", {}, io.BytesIO(b"")
        )

        with mock.patch.object(colab.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                colab._get_ccu_info(FAKE_ACCESS)

    def test_missing_endpoint_is_a_network_error_not_an_auth_failure(self) -> None:
        error = urllib.error.HTTPError(
            colab.CCU_INFO_URL, 404, "Not Found", {}, io.BytesIO(b"")
        )

        with mock.patch.object(colab.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(RuntimeError) as ctx:
                colab._get_ccu_info(FAKE_ACCESS)

        self.assertEqual(_classify(ctx.exception), "net_err")

    def test_connection_error_is_reported(self) -> None:
        error = urllib.error.URLError("boom")

        with mock.patch.object(colab.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "network error: boom"):
                colab._get_ccu_info(FAKE_ACCESS)

    def test_usage_uses_the_shared_cache_helper(self) -> None:
        sentinel = {"balance": 1.0}

        with mock.patch.object(
            colab, "get_cached_or_fetch", return_value=sentinel
        ) as cached:
            usage = colab.get_colab_usage()

        self.assertEqual(usage, sentinel)
        self.assertEqual(cached.call_args.args[0], "colab")
        self.assertEqual(cached.call_args.kwargs["ttl"], colab.CACHE_TTL)
        self.assertTrue(callable(cached.call_args.args[1]))



class ColabAdapterTests(unittest.TestCase):
    RAW = {"balance": 100.0, "rate_per_hour": 2.5, "assignments": 1}

    def test_only_the_remaining_balance_is_rendered(self) -> None:
        metrics = _adapt_colab(self.RAW)

        self.assertEqual(len(metrics), 1)
        self.assertEqual([metric.label for metric in metrics], ["Balance"])
        self.assertEqual(metrics[0].value, "100.00 CU remaining")
        self.assertTrue(metrics[0].is_remaining)

    def test_rate_active_and_estimate_metrics_are_gone(self) -> None:
        metrics = _adapt_colab(self.RAW)
        labels = {metric.label.lower() for metric in metrics}

        for obsolete in ("rate", "active", "est. hours", "estimated"):
            self.assertNotIn(obsolete, labels)
        self.assertFalse(any("estimate" in metric.value.lower() for metric in metrics))
        self.assertFalse(any("cu/hr" in metric.value.lower() for metric in metrics))

    def test_reset_is_unknown_rather_than_a_fabricated_date(self) -> None:
        metric = _adapt_colab(self.RAW)[0]

        self.assertEqual(metric.reset, "\u2014")
        self.assertFalse(any(character.isdigit() for character in metric.reset))

    def test_zero_balance(self) -> None:
        metric = _adapt_colab({**self.RAW, "balance": 0.0})[0]

        self.assertEqual(metric.value, "0.00 CU remaining")
        self.assertEqual(metric.pct, 0.0)
        self.assertTrue(metric.is_remaining)

    def test_partial_balance_maps_onto_the_200_cu_bar(self) -> None:
        metric = _adapt_colab({**self.RAW, "balance": 50.0})[0]

        self.assertEqual(metric.value, "50.00 CU remaining")
        self.assertAlmostEqual(metric.pct, 25.0)

    def test_full_balance_fills_the_bar(self) -> None:
        metric = _adapt_colab({**self.RAW, "balance": 200.0})[0]

        self.assertEqual(metric.value, "200.00 CU remaining")
        self.assertAlmostEqual(metric.pct, 100.0)

    def test_balance_above_the_cap_keeps_its_number_and_clamps_the_bar(self) -> None:
        metric = _adapt_colab({**self.RAW, "balance": 500.0})[0]

        self.assertEqual(metric.value, "500.00 CU remaining")
        self.assertEqual(metric.pct, 100.0)
        self.assertTrue(metric.is_remaining)

    def test_negative_balance_keeps_its_number_and_floors_the_bar(self) -> None:
        metric = _adapt_colab({**self.RAW, "balance": -5.0})[0]

        self.assertEqual(metric.value, "-5.00 CU remaining")
        self.assertEqual(metric.pct, 0.0)

    def test_non_numeric_balance_raises(self) -> None:
        with self.assertRaisesRegex(RuntimeError, "non-numeric balance"):
            _adapt_colab({"balance": None, "rate_per_hour": 1.0, "assignments": 0})


class ColabPlanTests(unittest.TestCase):
    def test_plan_is_the_exact_google_ai_plans_label(self) -> None:
        self.assertEqual(_plan_colab({}), "Google AI Plans")

    def test_provider_plan_callable_is_wired(self) -> None:
        provider = _build_providers()["colab"]

        self.assertIsNotNone(provider.plan)
        self.assertEqual(provider.plan({"balance": 1.0}), "Google AI Plans")


class ColabStandaloneCliTests(unittest.TestCase):
    def test_print_cli_shows_only_the_remaining_balance(self) -> None:
        buffer = io.StringIO()
        with mock.patch("sys.stdout", buffer):
            colab.print_cli(
                {
                    "balance": 42.5,
                    "rate_per_hour": 1.25,
                    "assignments": 3,
                }
            )

        output = buffer.getvalue()
        self.assertIn("42.50 CU", output)
        lowered = output.lower()
        for obsolete in ("rate", "active", "machines", "estimated", "cu/hr"):
            self.assertNotIn(obsolete, lowered)
        # The estimate helper is gone, so nothing can derive hours from a rate.
        self.assertFalse(hasattr(colab, "colab_estimate_hours"))


class ColabRegistrationTests(unittest.TestCase):
    def test_metadata_registers_colab_as_usage_with_no_secret(self) -> None:
        meta = PROVIDER_META["colab"]

        self.assertEqual(meta.name, "Colab")
        self.assertEqual(meta.mode, "usage")
        self.assertIsNone(meta.secret_key)
        # Metadata must describe what is shown: remaining CU only.
        self.assertIn("compute-unit", meta.desc)
        self.assertNotIn("rate", meta.desc)

    def test_provider_build_includes_fetcher_adapter_plan_and_no_user(self) -> None:
        provider = _build_providers()["colab"]

        self.assertEqual(provider.name, "Colab")
        self.assertEqual(provider.mode, "usage")
        self.assertIs(provider.fetch, _fetch_colab)
        self.assertIs(provider.adapt, _adapt_colab)
        self.assertIs(provider.plan, _plan_colab)
        self.assertIsNone(provider.user)

    def test_fetch_one_labels_the_source_and_keeps_one_metric(self) -> None:
        provider = _Provider(
            name="Colab",
            mode="usage",
            fetch=lambda browsers=None: {
                "balance": 10.0,
                "rate_per_hour": 1.0,
                "assignments": 1,
                "source": "colab-cli oauth",
            },
            adapt=_adapt_colab,
            plan=_plan_colab,
        )

        statuses = fetch_one("colab", provider, None)

        self.assertEqual(len(statuses), 1)
        status = statuses[0]
        self.assertEqual(status.state, "ok")
        self.assertEqual(status.mode, "usage")
        self.assertEqual(status.source, "colab-cli oauth")
        self.assertEqual(status.plan, "Google AI Plans")
        self.assertEqual(len(status.metrics), 1)
        self.assertEqual(status.metrics[0].label, "Balance")
        self.assertEqual(status.metrics[0].reset, "\u2014")
        self.assertTrue(status.metrics[0].is_remaining)


if __name__ == "__main__":
    unittest.main()
