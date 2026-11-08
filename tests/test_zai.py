from __future__ import annotations

import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from providers import zai


def _item(limit_type: str, unit: int | None, percentage: int) -> dict:
    item = {"type": limit_type, "percentage": percentage, "nextResetTime": 1791028382045}
    if unit is not None:
        item["unit"] = unit
    return item


def _normalize(limits: list[dict]) -> dict:
    payload = {"success": True, "data": {"level": "pro", "limits": limits}}
    with mock.patch.object(zai, "_api_get", return_value=payload):
        return zai._fetch_zai_quota_uncached("token")


class ZaiLimitTypeTests(unittest.TestCase):
    def test_shared_constant_lists_both_types(self) -> None:
        self.assertEqual(zai.TOKEN_LIMIT_TYPES, ("TOKENS_LIMIT", "CREDIT_LIMIT"))

    def test_tokens_limit_only(self) -> None:
        quota = _normalize([_item("TOKENS_LIMIT", 3, 10), _item("TOKENS_LIMIT", 6, 20)])
        self.assertEqual(quota["token_limit"]["percentage"], 10)
        self.assertEqual(quota["weekly_limit"]["percentage"], 20)

    def test_credit_limit_only(self) -> None:
        quota = _normalize([_item("CREDIT_LIMIT", 3, 1), _item("CREDIT_LIMIT", 6, 22)])
        self.assertEqual(quota["token_limit"]["percentage"], 1)
        self.assertEqual(quota["weekly_limit"]["percentage"], 22)

    def test_both_types_classify_by_unit(self) -> None:
        quota = _normalize([
            _item("CREDIT_LIMIT", 3, 5),
            _item("TOKENS_LIMIT", 6, 40),
            _item("TIME_LIMIT", None, 7),
        ])
        self.assertEqual(quota["token_limit"]["type"], "CREDIT_LIMIT")
        self.assertEqual(quota["weekly_limit"]["type"], "TOKENS_LIMIT")
        self.assertEqual(quota["time_limit"]["percentage"], 7)

    def test_unitless_credit_limit_is_the_legacy_single_window(self) -> None:
        quota = _normalize([_item("CREDIT_LIMIT", None, 30)])
        self.assertEqual(quota["token_limit"]["percentage"], 30)
        self.assertIsNone(quota["weekly_limit"])

    def test_print_cli_shows_windows_for_credit_limit(self) -> None:
        quota = _normalize([_item("CREDIT_LIMIT", 3, 1), _item("CREDIT_LIMIT", 6, 22)])
        out = io.StringIO()
        with redirect_stdout(out):
            zai.print_cli(quota)
        text = out.getvalue()
        self.assertIn("5h quota remaining    : 99%", text)
        self.assertIn("7d quota remaining    : 78%", text)


if __name__ == "__main__":
    unittest.main()
