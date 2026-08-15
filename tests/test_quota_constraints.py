import unittest

from agent_quota import (
    Metric,
    ProviderStatus,
    _Provider,
    _UsageBar,
    _adapt_codex,
    _apply_provider_constraints,
    _status_json,
    fetch_one,
)
from providers.codex import extract_codex_identity


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


class CodexWorkspaceTests(unittest.TestCase):
    def test_workspace_id_is_normalized_from_codex_session(self) -> None:
        identity = extract_codex_identity(
            {
                "plan_type": "team",
                "_session": {
                    "account": {"id": "workspace-123", "name": "Studio"},
                    "user": {"email": "person@example.com"},
                },
            }
        )

        self.assertEqual(identity["workspace_id"], "workspace-123")

    def test_fetch_and_json_preserve_workspace_and_muted_state(self) -> None:
        raw = {
            "identity": {"workspace_id": "workspace-123"},
            "metrics": [
                Metric("5h", "90%", 90, is_remaining=True),
                Metric(
                    "Weekly",
                    "0%",
                    0,
                    is_remaining=True,
                    is_blocking_period=True,
                ),
            ],
        }
        provider = _Provider(
            name="Codex",
            mode="usage",
            fetch=lambda _browsers: [raw],
            adapt=lambda item: item["metrics"],
        )

        statuses = fetch_one("codex", provider, None)
        payload = _status_json(statuses)

        self.assertEqual(statuses[0].workspace_id, "workspace-123")
        self.assertTrue(statuses[0].metrics[0].muted)
        self.assertEqual(payload["statuses"][0]["workspace_id"], "workspace-123")
        self.assertTrue(payload["statuses"][0]["metrics"][0]["muted"])

    def test_status_json_defaults_workspace_id_for_other_providers(self) -> None:
        payload = _status_json(
            [ProviderStatus(key="claude", name="Claude", mode="usage")]
        )

        self.assertEqual(payload["statuses"][0]["workspace_id"], "")


if __name__ == "__main__":
    unittest.main()
