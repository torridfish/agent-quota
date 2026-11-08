import unittest

from providers.metrics import pad_reset


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


if __name__ == "__main__":
    unittest.main()
