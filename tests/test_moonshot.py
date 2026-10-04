import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from agent_quota import _adapt_moonshot, _build_providers
from providers.moonshot import (
    DEFAULT_BASE_URL,
    _api_get,
    _balance_url,
    _currency_for,
    _fetch_moonshot_balance_uncached,
    get_moonshot_balance,
    load_moonshot_config,
)


class MoonshotConfigTests(unittest.TestCase):
    def test_missing_config_uses_international_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config = load_moonshot_config(Path(tmp) / "missing.conf")

        self.assertIsNone(config["MOONSHOT_API_KEY"])
        self.assertEqual(config["MOONSHOT_BASE_URL"], DEFAULT_BASE_URL)

    def test_config_reads_key_and_china_base_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "moonshot.conf"
            path.write_text(
                "# comment\n"
                "MOONSHOT_API_KEY = sk-test\n"
                "MOONSHOT_BASE_URL=https://api.moonshot.cn/v1/\n"
                "IGNORED=value\n"
            )
            config = load_moonshot_config(path)

        self.assertEqual(config["MOONSHOT_API_KEY"], "sk-test")
        self.assertEqual(
            config["MOONSHOT_BASE_URL"], "https://api.moonshot.cn/v1/"
        )


class MoonshotEndpointTests(unittest.TestCase):
    def test_balance_url_handles_default_and_trailing_slash(self) -> None:
        self.assertEqual(
            _balance_url(None),
            "https://api.moonshot.ai/v1/users/me/balance",
        )
        self.assertEqual(
            _balance_url("https://api.moonshot.cn/v1/"),
            "https://api.moonshot.cn/v1/users/me/balance",
        )

    def test_currency_is_inferred_from_platform_host(self) -> None:
        self.assertEqual(_currency_for(None), "USD")
        self.assertEqual(_currency_for("https://api.moonshot.ai/v1"), "USD")
        self.assertEqual(_currency_for("https://api.moonshot.cn/v1"), "CNY")

    def test_api_get_sends_bearer_token_and_parses_json(self) -> None:
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"code": 0, "data": {}}
        ).encode()

        with mock.patch(
            "providers.moonshot.urllib.request.urlopen", return_value=response
        ) as urlopen:
            payload = _api_get("https://example.test/balance", "secret-token")

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 10)
        self.assertEqual(payload, {"code": 0, "data": {}})


class MoonshotFetchTests(unittest.TestCase):
    def test_fetch_normalizes_balances_and_preserves_debt(self) -> None:
        payload = {
            "code": 0,
            "status": True,
            "data": {
                "available_balance": "13.19",
                "cash_balance": "-1.00",
                "voucher_balance": "14.19",
            },
        }
        with mock.patch("providers.moonshot._api_get", return_value=payload):
            balance = _fetch_moonshot_balance_uncached(
                "token", "https://api.moonshot.cn/v1"
            )

        self.assertEqual(
            balance,
            {
                "currency": "CNY",
                "available_balance": 13.19,
                "cash_balance": -1.0,
                "voucher_balance": 14.19,
            },
        )

    def test_nonzero_code_from_http_200_raises(self) -> None:
        with mock.patch(
            "providers.moonshot._api_get",
            return_value={"code": 7, "status": True, "scode": "bad_request"},
        ):
            with self.assertRaisesRegex(RuntimeError, "code 7"):
                _fetch_moonshot_balance_uncached("token", None)

    def test_false_status_raises(self) -> None:
        with mock.patch(
            "providers.moonshot._api_get",
            return_value={"code": 0, "status": False, "error": "denied"},
        ):
            with self.assertRaisesRegex(RuntimeError, "denied"):
                _fetch_moonshot_balance_uncached("token", None)

    def test_missing_data_raises(self) -> None:
        with mock.patch(
            "providers.moonshot._api_get", return_value={"code": 0, "status": True}
        ):
            with self.assertRaisesRegex(RuntimeError, "missing data"):
                _fetch_moonshot_balance_uncached("token", None)

    def test_non_numeric_balance_raises(self) -> None:
        payload = {
            "code": 0,
            "data": {
                "available_balance": None,
                "cash_balance": 1,
                "voucher_balance": 2,
            },
        }
        with mock.patch("providers.moonshot._api_get", return_value=payload):
            with self.assertRaisesRegex(RuntimeError, "available_balance"):
                _fetch_moonshot_balance_uncached("token", None)

    def test_cached_fetch_uses_moonshot_cache_key(self) -> None:
        expected = {"currency": "USD", "available_balance": 1.0}
        with mock.patch(
            "providers.moonshot.get_cached_or_fetch", return_value=expected
        ) as cached:
            result = get_moonshot_balance("token")

        self.assertIs(result, expected)
        self.assertEqual(cached.call_args.args[0], "moonshot")


class MoonshotAdapterTests(unittest.TestCase):
    def test_adapter_formats_available_cash_and_voucher(self) -> None:
        metrics = _adapt_moonshot(
            {
                "currency": "USD",
                "available_balance": 13.19,
                "cash_balance": -1.0,
                "voucher_balance": 14.19,
            }
        )

        self.assertEqual(len(metrics), 1)
        self.assertEqual(metrics[0].label, "USD")
        self.assertEqual(
            metrics[0].value,
            "13.19 available (-1.00 cash, 14.19 voucher)",
        )
        self.assertIsNone(metrics[0].pct)

    def test_adapter_marks_exhausted_balance(self) -> None:
        metric = _adapt_moonshot(
            {
                "currency": "USD",
                "available_balance": 0,
                "cash_balance": 0,
                "voucher_balance": 0,
            }
        )[0]

        self.assertTrue(metric.value.endswith("— exhausted"))

    def test_adapter_rejects_null_and_boolean_balances(self) -> None:
        for value in (None, True):
            with self.subTest(value=value):
                with self.assertRaisesRegex(RuntimeError, "available_balance"):
                    _adapt_moonshot(
                        {
                            "currency": "USD",
                            "available_balance": value,
                            "cash_balance": 0,
                            "voucher_balance": 0,
                        }
                    )

    def test_provider_registry_exposes_moonshot_as_kimi_payg(self) -> None:
        provider = _build_providers()["moonshot"]

        self.assertEqual(provider.name, "Kimi")
        self.assertEqual(provider.mode, "payg")


if __name__ == "__main__":
    unittest.main()
