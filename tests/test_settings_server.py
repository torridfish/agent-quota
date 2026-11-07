"""Unit tests for the local Agent Quota settings server.

The HTTP layer is exercised manually against a temporary GSettings backend;
these tests cover the security-sensitive helpers: credential-file parsing,
write-only secret storage, layout validation, and metadata parsing.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import tempfile
import threading
import tomllib
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER_PATH = REPO / "gnome-shell-extension" / "settings_server.py"

spec = importlib.util.spec_from_file_location("agent_quota_settings_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)

PROVIDERS = [
    {
        "id": "copilot",
        "title": "GitHub Copilot",
        "secret": {"key": "GITHUB_TOKEN", "label": "GitHub personal access token"},
    },
    {
        "id": "zai",
        "title": "Z.ai",
        "secret": {"key": "ZAI_TOKEN", "label": "API token"},
    },
]


class AssignmentTests(unittest.TestCase):
    def test_last_assignment_wins(self) -> None:
        contents = "GITHUB_TOKEN=old\nOTHER=x\nGITHUB_TOKEN = new  \n"
        self.assertEqual(server.read_assignment(contents, "GITHUB_TOKEN"), "new")

    def test_upsert_replaces_duplicates_and_preserves_other_lines(self) -> None:
        contents = "# comment\nA=1\nGITHUB_TOKEN=old\nB=2\nGITHUB_TOKEN=older\n"
        updated = server.upsert_assignment(contents, "GITHUB_TOKEN", "new")
        self.assertEqual(updated.count("GITHUB_TOKEN="), 1)
        self.assertIn("A=1", updated)
        self.assertIn("B=2", updated)
        self.assertIn("GITHUB_TOKEN=new", updated)
        self.assertNotIn("old", updated)

    def test_upsert_appends_to_empty_file(self) -> None:
        self.assertEqual(server.upsert_assignment("", "ZAI_TOKEN", "abc"), "ZAI_TOKEN=abc\n")


class MetadataTests(unittest.TestCase):
    def test_metric_options_group_and_dedupe(self) -> None:
        grouped = server.metric_options(["claude:5h", "claude:7d", "claude:5h", "bad", "codex:5h"])
        self.assertEqual(grouped["claude"], ["5h", "7d"])
        self.assertEqual(grouped["codex"], ["5h"])

    def test_workspace_options_ignore_invalid_json(self) -> None:
        options = server.workspace_options([
            json.dumps({"id": "ws-1", "label": "Business"}),
            "not-json",
            json.dumps({"id": "", "label": "ignored"}),
            json.dumps({"id": "ws-1", "label": "duplicate"}),
        ])
        self.assertEqual(options, [{"id": "ws-1", "label": "Business"}])


class LayoutValidationTests(unittest.TestCase):
    def test_layout_is_normalized_and_unknown_fields_are_dropped(self) -> None:
        raw = server.validate_layout({
            "version": 99,
            "columns": 3,
            "providers": [{
                "id": "copilot",
                "gaugeColumns": 2,
                "order": ["5h", "7d"],
                "col": 1,
                "row": 2,
                "w": 99,
                "h": 99,
                "unknown": True,
            }],
        }, {"copilot"})
        layout = json.loads(raw)
        self.assertEqual(layout["version"], 1)
        self.assertEqual(layout["columns"], 3)
        self.assertNotIn("w", layout["providers"][0])
        self.assertNotIn("unknown", layout["providers"][0])

    def test_layout_rejects_unknown_provider(self) -> None:
        with self.assertRaises(ValueError):
            server.validate_layout({"columns": 3, "providers": [{"id": "nope", "gaugeColumns": 1, "order": []}]}, {"copilot"})

    def test_layout_rejects_out_of_range_columns(self) -> None:
        with self.assertRaises(ValueError):
            server.validate_layout({"columns": 6, "providers": []}, {"copilot"})


class TomlValueTests(unittest.TestCase):
    def test_scalars(self) -> None:
        self.assertEqual(server.toml_value(True), "true")
        self.assertEqual(server.toml_value(False), "false")
        self.assertEqual(server.toml_value(12), "12")
        self.assertEqual(server.toml_value("bar"), '"bar"')

    def test_strings_are_escaped(self) -> None:
        self.assertEqual(server.toml_value('say "hi"'), '"say \\"hi\\""')
        self.assertEqual(server.toml_value("back\\slash"), '"back\\\\slash"')

    def test_non_bmp_and_control_characters_round_trip(self) -> None:
        for text in ("Team \U0001F680", "caf\u00e9 \u4e2d\u6587", "tab\there", "nl\nx", "bell\x07 del\x7f", 'q"\\'):
            with self.subTest(text=text):
                parsed = tomllib.loads(f"v = {server.toml_value(text)}\n")
                self.assertEqual(parsed["v"], text)
        workspace = json.dumps({"id": "w1", "label": "Team \U0001F680"})
        self.assertEqual(tomllib.loads(f"v = {server.toml_value([workspace])}\n")["v"], [workspace])

    def test_lone_surrogate_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            server.toml_value("\ud83d")

    def test_lists(self) -> None:
        self.assertEqual(server.toml_value(["claude", "codex"]), '["claude", "codex"]')
        self.assertEqual(server.toml_value([]), "[]")

    def test_unsupported_type_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            server.toml_value({"nope": 1})


class GnomeSectionTests(unittest.TestCase):
    def test_replace_appends_when_missing(self) -> None:
        updated = server.replace_gnome_section('enabled = ["claude"]\n', {"meter-style": "bar"})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["enabled"], ["claude"])
        self.assertEqual(parsed["gnome"], {"meter-style": "bar"})

    def test_replace_updates_in_place_and_keeps_unmanaged_keys(self) -> None:
        contents = (
            'enabled = ["claude"]\n\n[gnome]\n'
            "# hand written\n"
            'meter-style = "circle"\n'
            "circle-radius = 20\n"
            "warning-threshold = 25\n"
        )
        updated = server.replace_gnome_section(contents, {"meter-style": "bar"})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["enabled"], ["claude"])
        # The mirror owns meter-style only; the rest of the table survives.
        self.assertEqual(
            parsed["gnome"],
            {"meter-style": "bar", "circle-radius": 20, "warning-threshold": 25},
        )
        self.assertIn("# hand written", updated)

    def test_replace_keeps_quoted_keys_untouched(self) -> None:
        contents = '[gnome]\n"warning-threshold" = 40\n"meter-style" = "bar"\n'
        updated = server.replace_gnome_section(contents, {"meter-style": "circle"})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["gnome"], {"warning-threshold": 40, "meter-style": "circle"})

    def test_replace_appends_missing_keys_inside_the_table(self) -> None:
        contents = '[gnome]\nwarning-threshold = 25\n\n[other]\nb = "x"\n'
        updated = server.replace_gnome_section(contents, {"meter-style": "bar", "popup-width": 480})
        parsed = tomllib.loads(updated)
        self.assertEqual(
            parsed["gnome"],
            {"warning-threshold": 25, "meter-style": "bar", "popup-width": 480},
        )
        self.assertEqual(parsed["other"], {"b": "x"})

    def test_replace_preserves_later_tables(self) -> None:
        contents = '[gnome]\na = 1\n\n[other]\nb = "x"\n'
        updated = server.replace_gnome_section(contents, {"a": 2})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["gnome"], {"a": 2})
        self.assertEqual(parsed["other"], {"b": "x"})

    def test_array_of_tables_after_gnome_ends_the_section(self) -> None:
        contents = '[gnome]\na = 1\n\n[[servers]]\nname = "x"\n\n[[servers]]\nname = "y"\n'
        updated = server.replace_gnome_section(contents, {"a": 2, "b": 3})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["gnome"], {"a": 2, "b": 3})
        self.assertEqual(parsed["servers"], [{"name": "x"}, {"name": "y"}])

    def test_header_with_spaces_ends_the_section(self) -> None:
        contents = '[gnome]\na = 1\n\n[ other ]\nb = "x"\n'
        updated = server.replace_gnome_section(contents, {"c": 3})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["gnome"], {"a": 1, "c": 3})
        self.assertEqual(parsed["other"], {"b": "x"})

    def test_spaced_gnome_header_is_found(self) -> None:
        updated = server.replace_gnome_section("[ gnome ]\na = 1\n", {"a": 2})
        self.assertEqual(tomllib.loads(updated), {"gnome": {"a": 2}})

    def test_multiline_array_in_gnome_is_replaced_whole(self) -> None:
        contents = (
            '[gnome]\nhidden = [\n  "a",\n  "b", # note\n]\nkeep = 1\n\n[other]\nx = 1\n'
        )
        updated = server.replace_gnome_section(contents, {"hidden": ["c"]})
        parsed = tomllib.loads(updated)
        self.assertEqual(parsed["gnome"], {"hidden": ["c"], "keep": 1})
        self.assertEqual(parsed["other"], {"x": 1})
        self.assertNotIn('"b"', updated)

    def test_multiline_string_in_gnome_is_replaced_whole(self) -> None:
        contents = '[gnome]\ntext = """\n[not-a-header]\nline\n"""\nkeep = 1\n'
        updated = server.replace_gnome_section(contents, {"text": "new"})
        self.assertEqual(tomllib.loads(updated)["gnome"], {"text": "new", "keep": 1})

    def test_bracket_line_inside_multiline_array_is_not_a_header(self) -> None:
        contents = '[gnome]\nvals = [\n  [1, 2],\n  [3],\n]\n'
        updated = server.replace_gnome_section(contents, {"extra": 1})
        self.assertEqual(tomllib.loads(updated)["gnome"], {"vals": [[1, 2], [3]], "extra": 1})

    def test_write_does_not_create_the_file_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            self.assertFalse(server.write_gnome_section(path, {"meter-style": "bar"}))
            self.assertFalse(path.exists())

    def test_write_leaves_unparseable_file_alone(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"\n')
            with self.assertRaises(ValueError):
                server.write_gnome_section(path, {"meter-style": "bar"})
            self.assertEqual(path.read_text(), 'enabled = ["claude"\n')

    def test_write_preserves_header_and_enabled_with_unicode_label(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('# header\nenabled = ["claude"]\n')
            label = json.dumps({"id": "w", "label": "Team \U0001F680"})
            server.write_gnome_section(path, {"codex-workspace-options": [label]})
            server.write_gnome_section(path, {"meter-style": "bar"})
            text = path.read_text(encoding="utf-8")
            self.assertTrue(text.startswith('# header\nenabled = ["claude"]\n'))
            data = tomllib.loads(text)
            self.assertEqual(data["enabled"], ["claude"])
            self.assertEqual(data["gnome"]["codex-workspace-options"], [label])
            self.assertEqual(server.load_gnome_section(path)["meter-style"], "bar")

    def test_concurrent_writes_stay_valid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            errors: list[BaseException] = []

            def work(index: int) -> None:
                try:
                    for step in range(20):
                        server.write_gnome_section(path, {f"k{index}": step})
                except BaseException as error:  # pragma: no cover
                    errors.append(error)

            threads = [threading.Thread(target=work, args=(index,)) for index in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(errors, [])
            gnome = tomllib.loads(path.read_text())["gnome"]
            self.assertEqual(gnome, {f"k{index}": 19 for index in range(8)})
            self.assertEqual([item.name for item in Path(temporary).iterdir()], ["config.toml"])

    def test_write_creates_and_roundtrips(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            server.write_gnome_section(path, {"meter-style": "bar", "popup-width": 480}, create=True)
            self.assertEqual(tomllib.loads(path.read_text())["gnome"], {"meter-style": "bar", "popup-width": 480})
            server.write_gnome_section(path, {"meter-style": "circle"})
            # Saving one key must not drop the others.
            self.assertEqual(
                tomllib.loads(path.read_text())["gnome"],
                {"meter-style": "circle", "popup-width": 480},
            )

    def test_write_keeps_keys_it_does_not_manage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(
                'enabled = ["claude"]\n'
                "\n"
                "[gnome]\n"
                "warning-threshold = 25\n"
                "critical-threshold = 5\n"
            )
            server.write_gnome_section(path, {"refresh-seconds": 120})
            data = tomllib.loads(path.read_text())
            self.assertEqual(
                data["gnome"],
                {"warning-threshold": 25, "critical-threshold": 5, "refresh-seconds": 120},
            )
            self.assertEqual(data["enabled"], ["claude"])

    def test_load_section(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            self.assertEqual(server.load_gnome_section(path), {})
            path.write_text('enabled = ["a"]\n[gnome]\n"refresh-seconds" = 30\n')
            self.assertEqual(server.load_gnome_section(path), {"refresh-seconds": 30})
            path.write_text("this is not toml [")
            self.assertEqual(server.load_gnome_section(path), {})


class FakeBackend:
    keys = {
        "popup-width", "meter-style", "popup-layout", "hidden-metrics",
        "metric-options", "codex-workspace-options", "layout-gap", "layout-columns",
    }
    ranges = {"popup-width": (50, 720), "layout-gap": (0, 32), "layout-columns": (1, 5)}
    choices = {"meter-style": {"circle", "bar"}}

    def __init__(self) -> None:
        self.values: dict[str, object] = {
            "popup-width": 400, "meter-style": "circle", "popup-layout": "",
            "hidden-metrics": ["claude:5h"], "metric-options": ["claude:5h"],
            "codex-workspace-options": [], "layout-gap": 12, "layout-columns": 3,
        }
        self.ranges = dict(type(self).ranges)
        self.writes: list[str] = []
        self.fail_on: str | None = None

    def validate(self, key: str, value: object) -> object:
        if key in self.ranges and isinstance(value, int):
            lower, upper = self.ranges[key]
            if not lower <= value <= upper:
                raise ValueError(f"{key} must be between {lower} and {upper}")
        if key in self.choices and value not in self.choices[key]:
            raise ValueError(f"{key} is not an allowed value")
        return value

    def set(self, key: str, value: object) -> object:
        if key == "popup-width" and isinstance(value, int) and not -(2**31) <= value < 2**31:
            raise OverflowError("out of range")
        self.validate(key, value)
        if key == self.fail_on:
            raise ValueError(f"{key} rejected")
        self.writes.append(key)
        self.values[key] = value
        return value

    def get(self, key: str) -> object:
        return self.values[key]

    def all(self) -> dict[str, object]:
        return dict(self.values)


class ApplyCliConfigTests(unittest.TestCase):
    def app(self, path: Path) -> "server.App":
        app = object.__new__(server.App)
        app.backend = FakeBackend()
        app.cli_config_path = path
        return app

    def test_unparseable_file_is_left_alone(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"\n[gnome]\n')
            self.app(path)._apply_cli_config()
            self.assertEqual(path.read_text(), 'enabled = ["claude"\n[gnome]\n')

    def test_missing_file_is_not_created(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            self.app(path)._apply_cli_config()
            self.assertFalse(path.exists())

    def test_out_of_range_int_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n[gnome]\npopup-width = 99999999999\nmeter-style = "bar"\n')
            app = self.app(path)
            app._apply_cli_config()
            self.assertEqual(app.backend.values["meter-style"], "bar")
            self.assertEqual(app.backend.values["popup-width"], 400)
            # The bad key is topped up with the live value so the file is valid.
            self.assertEqual(tomllib.loads(path.read_text())["gnome"]["popup-width"], 400)

    def test_out_of_range_and_bad_choice_are_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n[gnome]\npopup-width = 5\nmeter-style = "bogus"\n')
            app = self.app(path)
            app._apply_cli_config()
            self.assertEqual(app.backend.values["popup-width"], 400)
            self.assertEqual(app.backend.values["meter-style"], "circle")

    def test_extension_owned_keys_are_not_pushed_and_are_refreshed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            hostile = json.dumps({"version": 1, "columns": 3, "providers": [
                {"id": "claude", "gaugeColumns": 1, "order": [], "row": 1000000000}]})
            path.write_text(
                'enabled = ["claude"]\n[gnome]\n'
                'hidden-metrics = ["claude:old-label"]\n'
                'metric-options = ["claude:old-label"]\n'
                f"popup-layout = {server.toml_value(hostile)}\n"
                'codex-workspace-options = ["stale"]\n'
                'meter-style = "bar"\n'
            )
            app = self.app(path)
            app._apply_cli_config()
            self.assertEqual(app.backend.values["hidden-metrics"], ["claude:5h"])
            self.assertEqual(app.backend.values["metric-options"], ["claude:5h"])
            self.assertEqual(app.backend.values["popup-layout"], "")
            self.assertEqual(app.backend.values["codex-workspace-options"], [])
            self.assertEqual(app.backend.values["meter-style"], "bar")
            self.assertNotIn("popup-layout", app.backend.writes)
            gnome = tomllib.loads(path.read_text())["gnome"]
            # The stale file copy is replaced by the dconf truth.
            self.assertEqual(gnome["hidden-metrics"], ["claude:5h"])
            self.assertEqual(gnome["popup-layout"], "")
            self.assertEqual(gnome["meter-style"], "bar")


class SetLayoutTests(unittest.TestCase):
    def app(self, path: Path) -> "server.App":
        app = object.__new__(server.App)
        app.backend = FakeBackend()
        app.cli_config_path = path
        app.provider_ids = {"claude"}
        return app

    layout = {"columns": 3, "providers": [{"id": "claude", "gaugeColumns": 1, "order": []}]}

    def test_rejected_key_leaves_nothing_applied(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary) / "config.toml")
            app.backend.ranges["layout-gap"] = (0, 5)  # schema narrower than the API check
            with self.assertRaises(ValueError):
                app.set_layout({"layout": self.layout, "settings": {"layout-gap": 20}})
            self.assertEqual(app.backend.writes, [])
            self.assertEqual(app.backend.values["popup-layout"], "")

    def test_write_failure_rolls_back_earlier_keys(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app.backend.fail_on = "layout-gap"
            with self.assertRaises(ValueError):
                app.set_layout({"layout": self.layout, "settings": {"layout-gap": 8}})
            self.assertEqual(app.backend.values["popup-layout"], "")
            self.assertEqual(app.backend.values["layout-gap"], 12)
            self.assertNotIn("gnome", tomllib.loads(path.read_text()))

    def test_success_persists_after_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app.set_layout({"layout": self.layout, "settings": {"layout-gap": 8}})
            self.assertEqual(app.backend.values["layout-gap"], 8)
            self.assertEqual(tomllib.loads(path.read_text())["gnome"]["layout-gap"], 8)

    def test_set_setting_failure_does_not_persist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            with self.assertRaises(ValueError):
                app.set_setting("popup-width", 5000)
            self.assertNotIn("gnome", tomllib.loads(path.read_text()))


class FakeVariant:
    def __init__(self, type_string: str, value: object) -> None:
        if type_string == "i" and not -(2**31) <= value < 2**31:
            raise OverflowError("int32")
        self.type_string, self.value = type_string, value

    def unpack(self) -> object:
        return self.value


class FakeSchemaKey:
    def __init__(self, type_string: str, rng: tuple | None, choices: list[str] | None) -> None:
        self.type_string, self.rng, self.choices = type_string, rng, choices

    def get_value_type(self) -> "FakeSchemaKey":
        return self

    def dup_string(self) -> str:
        return self.type_string

    def range_check(self, variant: FakeVariant) -> bool:
        if self.rng is not None:
            return self.rng[0] <= variant.value <= self.rng[1]
        if self.choices is not None:
            return variant.value in self.choices
        return True

    def get_range(self) -> FakeVariant:
        if self.rng is not None:
            return FakeVariant("(sv)", ("range", self.rng))
        return FakeVariant("(sv)", ("enum", self.choices))


class FakeGSettings:
    def __init__(self, accept: bool = True) -> None:
        self.stored = {"circle-radius": 16, "gauge-percent": "percent"}
        self.accept = accept

    def set_value(self, key: str, variant: FakeVariant) -> bool:
        if not self.accept:
            return False
        self.stored[key] = variant.value
        return True

    def get_value(self, key: str) -> FakeVariant:
        return FakeVariant("x", self.stored[key])


class FakeGLib:
    Variant = FakeVariant


class SettingsBackendSetTests(unittest.TestCase):
    def backend(self, accept: bool = True) -> "server.SettingsBackend":
        backend = object.__new__(server.SettingsBackend)
        keys = {
            "circle-radius": FakeSchemaKey("i", (10, 32), None),
            "gauge-percent": FakeSchemaKey("s", None, ["percent", "number", "hidden"]),
        }
        backend.schema = type("Schema", (), {"get_key": staticmethod(lambda key: keys[key])})()
        backend.settings = FakeGSettings(accept)
        backend.keys = set(keys)
        return backend

    def setUp(self) -> None:
        self.original = server.GLib
        server.GLib = FakeGLib

    def tearDown(self) -> None:
        server.GLib = self.original

    def test_valid_value_is_written(self) -> None:
        backend = self.backend()
        self.assertEqual(backend.set("circle-radius", 20), 20)
        self.assertEqual(backend.set("gauge-percent", "number"), "number")

    def test_out_of_range_raises_with_bounds(self) -> None:
        backend = self.backend()
        with self.assertRaisesRegex(ValueError, "between 10 and 32"):
            backend.set("circle-radius", 500)
        self.assertEqual(backend.settings.stored["circle-radius"], 16)

    def test_bad_choice_raises_with_choices(self) -> None:
        backend = self.backend()
        with self.assertRaisesRegex(ValueError, "percent, number, hidden"):
            backend.set("gauge-percent", "bogus")
        self.assertEqual(backend.settings.stored["gauge-percent"], "percent")

    def test_int32_overflow_raises(self) -> None:
        with self.assertRaises(ValueError):
            self.backend().set("circle-radius", 2**40)

    def test_set_value_false_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, "rejected"):
            self.backend(accept=False).set("circle-radius", 20)


class SecretStoreTests(unittest.TestCase):
    def test_secret_is_written_private_and_never_read_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "config"
            store = server.SecretStore(PROVIDERS, directory)
            self.assertFalse(store.configured("copilot"))
            self.assertTrue(store.set("copilot", "GITHUB_TOKEN", "dummy"))
            self.assertTrue(store.configured("copilot"))
            path = directory / "copilot.conf"
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.read_text().strip().splitlines()[-1], "GITHUB_TOKEN=dummy")
            self.assertFalse(store.set("copilot", "GITHUB_TOKEN", ""))
            self.assertFalse(store.configured("copilot"))

    def test_secret_rejects_multiline_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = server.SecretStore(PROVIDERS, Path(temporary))
            with self.assertRaises(ValueError):
                store.set("copilot", "GITHUB_TOKEN", "good\nINJECTED=yes")

    def test_secret_rejects_fields_not_belonging_to_provider(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = server.SecretStore(PROVIDERS, Path(temporary))
            with self.assertRaises(ValueError):
                store.set("copilot", "ZAI_TOKEN", "nope")
            with self.assertRaises(ValueError):
                store.set("unknown", "GITHUB_TOKEN", "nope")


class PrivateFileTests(unittest.TestCase):
    def test_info_file_is_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings-server.json"
            server.write_private_json(path, {"token": "x"})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(json.loads(path.read_text()), {"token": "x"})

    def test_symlinked_config_is_written_through(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            real = Path(temporary) / "dotfiles" / "config.toml"
            real.parent.mkdir()
            real.write_text('enabled = ["claude"]\n')
            real.chmod(0o600)
            link = Path(temporary) / "config.toml"
            link.symlink_to(real)
            server.write_gnome_section(link, {"meter-style": "bar"})
            self.assertTrue(link.is_symlink())
            self.assertEqual(tomllib.loads(real.read_text())["gnome"], {"meter-style": "bar"})
            self.assertEqual(stat.S_IMODE(real.stat().st_mode), 0o600)
            self.assertEqual(sorted(item.name for item in real.parent.iterdir()), ["config.toml"])

    def test_config_mode_is_preserved_and_defaults_on_create(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            server.write_gnome_section(path, {"a": 1}, create=True)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            path.chmod(0o600)
            server.write_gnome_section(path, {"a": 2})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_secret_file_is_narrowed_to_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "x.conf"
            path.write_text("A=1\n")
            path.chmod(0o644)
            server.atomic_write_text(path, "A=2\n", 0o600)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_info_file_removed_only_by_its_owner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "settings-server.json"
            server.write_private_json(path, {"pid": 100, "token": "new"})
            server.remove_info_file(path, 99, "old")
            self.assertTrue(path.exists())
            server.remove_info_file(path, 100, "old")
            self.assertTrue(path.exists())
            server.remove_info_file(path, 100, "new")
            self.assertFalse(path.exists())
            server.remove_info_file(path, 100, "new")  # already gone

    def test_concurrent_secret_writes_stay_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store = server.SecretStore(PROVIDERS, Path(temporary))
            errors: list[BaseException] = []

            def work(index: int) -> None:
                try:
                    for step in range(20):
                        store.set("zai", "ZAI_TOKEN", f"t{index}-{step}")
                except BaseException as error:  # pragma: no cover
                    errors.append(error)

            threads = [threading.Thread(target=work, args=(index,)) for index in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(errors, [])
            path = Path(temporary) / "zai.conf"
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.read_text().count("ZAI_TOKEN="), 1)
            self.assertEqual(sorted(item.name for item in Path(temporary).iterdir()), ["zai.conf"])


if __name__ == "__main__":
    unittest.main()
