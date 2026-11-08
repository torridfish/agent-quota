import unittest

from agent_quota import (
    Metric,
    ProviderStatus,
    _Provider,
    _UsageBar,
    _adapt_go,
    _apply_provider_constraints,
    _status_json,
    fetch_one,
)
from providers.codex import (
    _extract_codex_identity,
    adapt_codex as _adapt_codex,
    extract_codex_identity,
    plan_codex as _plan_codex,
)
from providers.go import _go_window_label, go_usage_windows


class ProviderConstraintTests(unittest.TestCase):
    def test_exhausted_weekly_metric_mutes_every_other_percentage(self) -> None:
        short = Metric("5h", "80%", 80, is_remaining=True)
        weekly = Metric(
            "7d",
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
            "7d",
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
            "7d",
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

        self.assertEqual([metric.label for metric in metrics], ["5h", "7d"])
        self.assertTrue(metrics[0].muted)
        self.assertTrue(metrics[1].is_blocking_period)
        self.assertFalse(metrics[1].muted)

    def test_codex_string_duration_seven_day_window_renders_7d(self) -> None:
        metrics = _adapt_codex(
            {
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 25,
                        "limit_window_seconds": 18_000,
                    },
                    "secondary_window": {
                        "used_percent": 20,
                        "limit_window_seconds": "604800",
                    },
                }
            }
        )

        self.assertEqual([metric.label for metric in metrics], ["5h", "7d"])
        self.assertFalse(any("weekly" in m.label.lower() for m in metrics))

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


class GoWindowLabelTests(unittest.TestCase):
    def test_weekly_keys_render_as_7d(self) -> None:
        self.assertEqual(_go_window_label("weekly"), "7d")
        self.assertEqual(_go_window_label("weeklyUsage"), "7d")
        self.assertEqual(_go_window_label("rolling"), "5h")
        self.assertEqual(_go_window_label("rollingUsage"), "5h")
        self.assertEqual(_go_window_label("monthly"), "30d")
        self.assertEqual(_go_window_label("monthlyUsage"), "30d")

    def test_go_windows_display_7d_but_keep_raw_weekly_key(self) -> None:
        usage = {
            "windows": {
                "rolling": {"usage_percent": 20},
                "weekly": {"usage_percent": 40},
            }
        }

        rows = go_usage_windows(usage)

        self.assertEqual([label for label, _ in rows], ["5h", "7d"])
        self.assertIn("weekly", usage["windows"])
        self.assertEqual(rows[1][1]["usage_percent"], 40)

    def test_go_labels_are_canonical_whatever_the_key_casing(self) -> None:
        metrics = _adapt_go(
            {
                "windows": {
                    "rolling": {"usage_percent": 10},
                    "weekly": {"usage_percent": 20},
                    "monthly": {"usage_percent": 30},
                    "Weekly": {"usage_percent": 40},
                    "MonthlyUsage": {"usage_percent": 50},
                }
            }
        )

        self.assertEqual([m.label for m in metrics], ["5h", "7d", "30d", "7d", "30d"])

    def test_exhausted_go_7d_window_blocks_provider_and_mutes_5h(self) -> None:
        metrics = _adapt_go(
            {
                "windows": {
                    "rolling": {"usage_percent": 20},
                    "weekly": {"usage_percent": 100},
                }
            }
        )

        _apply_provider_constraints(metrics)

        self.assertEqual([m.label for m in metrics], ["5h", "7d"])
        self.assertTrue(metrics[1].is_blocking_period)
        self.assertTrue(metrics[0].muted)
        self.assertFalse(metrics[1].muted)

    def test_available_go_7d_window_leaves_5h_unmuted(self) -> None:
        metrics = _adapt_go(
            {
                "windows": {
                    "rolling": {"usage_percent": 20},
                    "weekly": {"usage_percent": 30},
                }
            }
        )

        _apply_provider_constraints(metrics)

        self.assertFalse(any(m.muted for m in metrics))
        self.assertTrue(metrics[1].is_blocking_period)


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
                    "7d",
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


def _credit_usage(**overrides) -> dict:
    usage = {
        "plan_type": "self_serve_business_usage_based",
        "credits": {"has_credits": False, "unlimited": False, "balance": "0"},
        "spend_control": {
            "individual_limit": {
                "limit": "10",
                "used": "8.131699562072754",
                "remaining": "1.868300437927246",
                "remaining_percent": 19,
                "reset_at": 1793491200,
            }
        },
        "identity": {
            "plan": "self_serve_business_usage_based",
            "team_name": "Studio",
            "account_kind": "workspace",
        },
    }
    usage.update(overrides)
    return usage


class CodexPlanLabelTests(unittest.TestCase):
    def test_codex_seat_plan_uses_workspace_name(self) -> None:
        raw = _credit_usage()
        self.assertEqual(_plan_codex(raw), "Business (Studio)")

    def test_standard_seat_plan_uses_workspace_name(self) -> None:
        raw = {
            "identity": {
                "plan": "team",
                "team_name": "Studio",
                "account_kind": "workspace",
            }
        }
        self.assertEqual(_plan_codex(raw), "Business (Studio)")

    def test_business_plan_without_workspace_name_has_no_suffix(self) -> None:
        raw = {
            "identity": {
                "plan": "team",
                "team_name": "",
                "account_kind": "workspace",
            }
        }
        self.assertEqual(_plan_codex(raw), "Business")

    def test_personal_account_keeps_personal_plan(self) -> None:
        raw = {
            "identity": {
                "plan": "self_serve_business_usage_based",
                "account_plan": "plus",
                "account_kind": "personal",
            }
        }
        self.assertEqual(_plan_codex(raw), "Plus")


class CodexCreditMetricTests(unittest.TestCase):
    def test_codex_seat_uses_credit_limit_instead_of_usage_windows(self) -> None:
        metrics = _adapt_codex(
            {
                **_credit_usage(),
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 10,
                        "limit_window_seconds": 18000,
                    }
                },
            }
        )

        self.assertEqual([metric.label for metric in metrics], ["Credits"])
        self.assertEqual(metrics[0].value, "1.87 / 10")
        self.assertEqual(metrics[0].pct, 19)
        self.assertTrue(metrics[0].is_credit)

    def test_zero_balance_keeps_percentage_but_marks_insufficient(self) -> None:
        metrics = _adapt_codex(_credit_usage())

        self.assertEqual(metrics[0].pct, 19)
        self.assertTrue(metrics[0].insufficient)

    def test_positive_balance_is_not_insufficient(self) -> None:
        metrics = _adapt_codex(
            _credit_usage(
                credits={"has_credits": True, "unlimited": False, "balance": "25"}
            )
        )

        self.assertFalse(metrics[0].insufficient)

    def test_unlimited_credits_render_as_plain_text(self) -> None:
        metrics = _adapt_codex(
            _credit_usage(
                credits={"has_credits": True, "unlimited": True, "balance": None},
                spend_control={},
            )
        )

        self.assertEqual(metrics[0].value, "Unlimited")
        self.assertIsNone(metrics[0].pct)
        self.assertFalse(metrics[0].insufficient)

    def test_balance_without_monthly_limit_has_no_percentage(self) -> None:
        metrics = _adapt_codex(
            _credit_usage(
                credits={"has_credits": True, "unlimited": False, "balance": "12.5"},
                spend_control={},
            )
        )

        self.assertEqual(metrics[0].value, "12.5 credits")
        self.assertIsNone(metrics[0].pct)

    def test_standard_seat_shows_usage_windows_and_credits(self) -> None:
        metrics = _adapt_codex(
            {
                "plan_type": "team",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 40,
                        "limit_window_seconds": 18000,
                        "reset_at": 1793491200,
                    }
                },
                "credits": {"has_credits": True, "unlimited": False, "balance": "25"},
                "spend_control": {
                    "individual_limit": {
                        "limit": "10",
                        "remaining": "4",
                        "remaining_percent": 40,
                        "reset_at": 1793491200,
                    }
                },
                "identity": {
                    "plan": "team",
                    "team_name": "Studio",
                    "account_kind": "workspace",
                    "usage_based_seat": False,
                },
            }
        )

        self.assertEqual([metric.label for metric in metrics], ["5h", "Credits"])
        self.assertFalse(metrics[1].insufficient)

    def test_exhausted_included_usage_does_not_mute_credits(self) -> None:
        metrics = _adapt_codex(
            {
                "plan_type": "team",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 100,
                        "limit_window_seconds": 7 * 24 * 60 * 60,
                        "reset_at": 1793491200,
                    }
                },
                "credits": {"has_credits": True, "unlimited": False, "balance": "25"},
                "spend_control": {
                    "individual_limit": {
                        "limit": "10",
                        "remaining": "4",
                        "remaining_percent": 40,
                        "reset_at": 1793491200,
                    }
                },
                "identity": {
                    "plan": "team",
                    "team_name": "Studio",
                    "account_kind": "workspace",
                    "usage_based_seat": False,
                },
            }
        )

        _apply_provider_constraints(metrics)

        self.assertEqual(metrics[0].label, "7d")
        self.assertTrue(metrics[0].is_blocking_period)
        self.assertFalse(metrics[1].muted)

    def test_workspace_name_falls_back_to_accounts_payload(self) -> None:
        identity = _extract_codex_identity(
            {"plan_type": "team"},
            {
                "account": {
                    "id": "workspace-123",
                    "structure": "workspace",
                    "planType": "team",
                }
            },
            "Studio",
        )

        self.assertEqual(identity["team_name"], "Studio")

    def test_standard_seat_without_spend_control_omits_credits_row(self) -> None:
        # isUsageBasedSeatEnabled is workspace-wide and stays true after a
        # member moves to a standard seat, so it must not hide included usage.
        metrics = _adapt_codex(
            {
                "plan_type": "team",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 0,
                        "limit_window_seconds": 18000,
                        "reset_at": 1793491200,
                    },
                    "secondary_window": {
                        "used_percent": 1,
                        "limit_window_seconds": 604800,
                        "reset_at": 1793491200,
                    },
                },
                "credits": {"has_credits": False, "balance": "0"},
                "spend_control": {"reached": False, "individual_limit": None},
                "identity": {
                    "plan": "team",
                    "team_name": "Studio",
                    "account_kind": "workspace",
                    "usage_based_seat": True,
                },
            }
        )

        self.assertEqual([metric.label for metric in metrics], ["5h", "7d"])
        self.assertTrue(all(metric.is_remaining for metric in metrics))

    def test_status_json_exposes_insufficient_state(self) -> None:
        status = ProviderStatus(
            key="codex",
            name="Codex",
            mode="usage",
            metrics=[_adapt_codex(_credit_usage())[0]],
        )

        payload = _status_json([status])

        self.assertTrue(payload["statuses"][0]["metrics"][0]["insufficient"])


if __name__ == "__main__":
    unittest.main()
