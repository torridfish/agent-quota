import unittest

from common import finite_float, parse_window_direct, parse_window_percent
from providers.codex import codex_credit_metric, format_credit_amount
from providers.metrics import Metric, pad_reset


class PadResetTests(unittest.TestCase):
    def test_already_passed_reset_matches_existing_zero_form(self) -> None:
        # format_eta returns "0m00s" for a reset in the past and "0′00″" for
        # a missing one; both must render as a zero reset, never "00m".
        self.assertEqual(pad_reset("0m00s"), "0′00″")
        self.assertEqual(pad_reset("0′00″"), "0′00″")

    def test_sub_minute_reset_keeps_seconds(self) -> None:
        self.assertEqual(pad_reset("0m30s"), "0′30″")
        self.assertEqual(pad_reset("0m01s"), "0′01″")
        self.assertEqual(pad_reset("0m59s"), "0′59″")

    def test_minute_level_reset_drops_seconds(self) -> None:
        # Compact form keeps only the largest unit once a minute or more remains.
        self.assertEqual(pad_reset("19m30s"), "19m")

    def test_other_format_eta_outputs(self) -> None:
        self.assertEqual(pad_reset("1m05s"), "01m")
        self.assertEqual(pad_reset("59m00s"), "59m")
        self.assertEqual(pad_reset("1h02m"), "01h02m")
        self.assertEqual(pad_reset("2d03h"), "02d03h")
        self.assertEqual(pad_reset("1d00h"), "01d")

    def test_passthrough_values(self) -> None:
        self.assertEqual(pad_reset("—"), "—")
        self.assertEqual(pad_reset("??′??″"), "??′??″")
        self.assertEqual(pad_reset(""), "")
        self.assertIsNone(pad_reset(None))


class NonFiniteNumberTests(unittest.TestCase):
    BAD = ["NaN", "nan", "inf", "-inf", "Infinity", "1e999", float("nan"), float("inf"), float("-inf")]

    def test_finite_float(self) -> None:
        for value in self.BAD + [None, "", "abc", 10**400]:
            with self.subTest(value=value):
                self.assertIsNone(finite_float(value))
        self.assertEqual(finite_float("12.5"), 12.5)
        self.assertEqual(finite_float(3), 3.0)

    def test_format_credit_amount_never_prints_nan_or_inf(self) -> None:
        for value in self.BAD:
            with self.subTest(value=value):
                self.assertEqual(format_credit_amount(value), "—")
        self.assertEqual(format_credit_amount("12.50"), "12.5")

    def test_non_finite_balance_is_treated_as_missing(self) -> None:
        for value in self.BAD:
            with self.subTest(value=value):
                metric = codex_credit_metric({"credits": {"balance": value}})
                self.assertIsNone(metric)
        metric = codex_credit_metric({"credits": {"balance": "inf", "has_credits": True}})
        self.assertEqual(metric.value, "Available")
        self.assertFalse(metric.insufficient)

    def test_non_finite_remaining_percent_is_not_a_full_gauge(self) -> None:
        from providers import codex

        for value in self.BAD:
            with self.subTest(value=value):
                with unittest_mock_limit(codex, {"remaining_percent": value}):
                    metric = codex_credit_metric({"credits": {}})
                self.assertIsNone(metric.pct)
                self.assertEqual(metric.value, "—")

    def test_limit_with_non_finite_amounts_falls_back_to_percent_or_dash(self) -> None:
        from providers import codex

        limit = {"remaining": "inf", "limit": 50, "remaining_percent": 40}
        with unittest_mock_limit(codex, limit):
            metric = codex_credit_metric({"credits": {}})
        self.assertEqual(metric.value, "40%")
        self.assertEqual(metric.pct, 40.0)
        for bad in (dict(limit, remaining_percent="nan"), {"remaining": "nan", "limit": "nan"}):
            with unittest_mock_limit(codex, bad):
                metric = codex_credit_metric({"credits": {}})
            self.assertEqual(metric.value, "—")
            self.assertIsNone(metric.pct)

    def test_finite_limit_still_renders_amounts(self) -> None:
        from providers import codex

        with unittest_mock_limit(codex, {"remaining": 25, "limit": 50}):
            metric = codex_credit_metric({"credits": {}})
        self.assertEqual(metric.value, "25 / 50")
        self.assertEqual(metric.pct, 50.0)

    def test_window_parsers_treat_non_finite_as_unparsable(self) -> None:
        for value in self.BAD:
            with self.subTest(value=value):
                self.assertEqual(parse_window_direct({"used_percent": value}).utilization, 0.0)
                self.assertEqual(parse_window_percent({"utilization": value}).utilization, 0.0)
        self.assertEqual(parse_window_direct({"used_percent": "12"}).utilization, 12.0)

    def test_metric_drops_a_non_finite_percentage(self) -> None:
        for value in (float("nan"), float("inf"), float("-inf")):
            self.assertIsNone(Metric("x", "y", value).pct)
        self.assertEqual(Metric("x", "y", 0.0).pct, 0.0)
        self.assertEqual(Metric("x", "y", 55.5).pct, 55.5)


def unittest_mock_limit(module: object, limit: dict):
    from unittest import mock

    return mock.patch.object(module, "codex_credit_limit", return_value=limit)


if __name__ == "__main__":
    unittest.main()
