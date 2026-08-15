import unittest

from agent_quota import (
    Metric,
    _UsageBar,
    _adapt_codex,
    _apply_provider_constraints,
)

class ProviderConstraintTests(unittest.TestCase):
    def test_exhausted_weekly_metric_mutes_every_other_percentage(self) -> None:
        short = Metric("5h", "80%", 80, is_remaining=True)
        weekly = Metric(
            "Weekly",
            "0%",
            0,
            is_remaining=True,
            is_blocking_period=True,
        )
        scoped_weekly = Metric("7d Model", "40%", 40, is_remaining=True)

        _apply_provider_constraints([short, weekly, scoped_weekly])

        self.assertTrue(short.muted)
        self.assertFalse(weekly.muted)
        self.assertTrue(scoped_weekly.muted)

    def test_available_weekly_metric_does_not_mute_short_window(self) -> None:
        short = Metric("5h", "80%", 80, is_remaining=True)
        weekly = Metric(
            "Weekly",
            "1%",
            1,
            is_remaining=True,
            is_blocking_period=True,
        )

        _apply_provider_constraints([short, weekly])

        self.assertFalse(short.muted)
        self.assertFalse(weekly.muted)

    def test_reapplying_constraints_clears_stale_muted_state(self) -> None:
        short = Metric("5h", "80%", 80, is_remaining=True, muted=True)
        weekly = Metric(
            "Weekly",
            "1%",
            1,
            is_remaining=True,
            is_blocking_period=True,
        )

        _apply_provider_constraints([short, weekly])

        self.assertFalse(short.muted)

    def test_codex_string_duration_marks_weekly_window_as_blocking(self) -> None:
        metrics = _adapt_codex(
            {
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 25,
                        "limit_window_seconds": 18_000,
                    },
                    "secondary_window": {
                        "used_percent": 100,
                        "limit_window_seconds": "604800",
                    },
                }
            }
        )

        _apply_provider_constraints(metrics)

        self.assertEqual([metric.label for metric in metrics], ["5h", "Weekly"])
        self.assertTrue(metrics[0].muted)
        self.assertTrue(metrics[1].is_blocking_period)
        self.assertFalse(metrics[1].muted)

    def test_scoped_codex_weekly_limit_does_not_block_provider(self) -> None:
        metrics = _adapt_codex(
            {
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 25,
                        "limit_window_seconds": 18_000,
                    },
                    "secondary_window": {
                        "used_percent": 20,
                        "limit_window_seconds": 604_800,
                    },
                },
                "code_review_rate_limit": {
                    "weekly_window": {
                        "used_percent": 100,
                        "limit_window_seconds": 604_800,
                    }
                },
            }
        )

        _apply_provider_constraints(metrics)

        self.assertEqual(
            [metric.is_blocking_period for metric in metrics],
            [False, True, False],
        )
        self.assertFalse(any(metric.muted for metric in metrics))

    def test_muted_terminal_bar_uses_gray_green(self) -> None:
        bar = _UsageBar(80, "80%", is_remaining=True, muted=True)

        self.assertEqual(bar._color(True), "#6f8f78")


if __name__ == "__main__":
    unittest.main()
