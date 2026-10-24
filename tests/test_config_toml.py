"""Config file safety: one owner per table, validated and atomic writes.

These are the regressions behind the config-file review: the line-based writer
used to truncate multi-line values, edit tables it did not own, emit invalid
TOML for non-BMP text, and lose concurrent updates.
"""

from __future__ import annotations

import os
import tempfile
import threading
import tomllib
import unittest
from pathlib import Path

import config_toml


class TomlStringTests(unittest.TestCase):
    def test_roundtrips_through_tomllib(self):
        for value in [
            "plain",
            'say "hi"',
            "back\\slash",
            "tab\there",
            "line\nbreak",
            "control\x01char",
            "emoji 😀 and 中文字",
            "quote \" and \\ together",
        ]:
            rendered = f"x = {config_toml.toml_string(value)}"
            self.assertEqual(tomllib.loads(rendered)["x"], value, rendered)

    def test_non_bmp_characters_stay_literal(self):
        # json.dumps would emit a surrogate pair, which tomllib rejects.
        self.assertIn("😀", config_toml.toml_string("😀"))
        self.assertNotIn("\\ud83d", config_toml.toml_string("😀"))


class TomlValueTests(unittest.TestCase):
    def test_scalars_and_lists(self):
        self.assertEqual(config_toml.toml_value(True), "true")
        self.assertEqual(config_toml.toml_value(12), "12")
        self.assertEqual(config_toml.toml_value(["a", "b"]), '["a", "b"]')
        self.assertEqual(config_toml.toml_value([]), "[]")

    def test_non_finite_floats_are_rejected(self):
        for value in (float("inf"), float("-inf"), float("nan")):
            with self.assertRaises(config_toml.ConfigError):
                config_toml.toml_value(value)

    def test_unknown_types_are_rejected(self):
        with self.assertRaises(config_toml.ConfigError):
            config_toml.toml_value({"nope": 1})


class TempConfig(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "config.toml"

    def parsed(self) -> dict:
        return tomllib.loads(self.path.read_text())


class ReplaceTableTests(TempConfig):
    def test_creates_the_file(self):
        config_toml.replace_tables(self.path, {"gnome": {"meter-style": "bar"}})
        self.assertEqual(self.parsed()["gnome"], {"meter-style": "bar"})

    def test_keeps_root_keys_comments_and_other_tables(self):
        self.path.write_text(
            "# top comment\n"
            'enabled = ["claude"]\n'
            "\n"
            "[other]\n"
            'kept = "x"  # inline\n'
            "\n"
            "[gnome]\n"
            'meter-style = "circle"\n'
        )
        config_toml.replace_tables(self.path, {"gnome": {"meter-style": "bar"}})
        data = self.parsed()
        self.assertEqual(data["enabled"], ["claude"])
        self.assertEqual(data["other"], {"kept": "x"})
        self.assertEqual(data["gnome"], {"meter-style": "bar"})
        self.assertIn("# top comment", self.path.read_text())

    def test_replaces_a_multi_line_value_in_place(self):
        # The old writer left `"a",\n]` behind and produced invalid TOML.
        self.path.write_text('[gnome]\nmetric-options = [\n "a",\n "b",\n]\n')
        config_toml.replace_tables(self.path, {"gnome": {"metric-options": ["c"]}})
        self.assertEqual(self.parsed()["gnome"], {"metric-options": ["c"]})

    def test_does_not_touch_array_of_tables(self):
        self.path.write_text('[gnome]\nx = 1\n\n[[other]]\nx = 2\n\n[[other]]\nx = 3\n')
        # Array-of-tables cannot be located safely, so the whole write is refused
        # rather than corrupting a neighbouring table.
        with self.assertRaises(config_toml.ConfigError):
            config_toml.replace_tables(self.path, {"gnome": {"x": 9}})
        self.assertIn("[[other]]", self.path.read_text())

    def test_handles_a_quoted_table_header(self):
        self.path.write_text('["gnome"]\nmeter-style = "circle"\n')
        config_toml.replace_tables(self.path, {"gnome": {"meter-style": "bar"}})
        self.assertEqual(self.parsed()["gnome"], {"meter-style": "bar"})
        self.assertEqual(self.path.read_text().count("[gnome]"), 1)
        self.assertEqual(self.path.read_text().count('["gnome"]'), 0)

    def test_refuses_duplicate_tables(self):
        self.path.write_text("[gnome]\nx = 1\n\n[gnome]\nx = 2\n")
        with self.assertRaises(config_toml.ConfigError):
            config_toml.replace_tables(self.path, {"gnome": {"x": 3}})

    def test_refuses_invalid_toml_and_leaves_it_alone(self):
        original = "this is not toml [\n"
        self.path.write_text(original)
        with self.assertRaises(config_toml.ConfigError):
            config_toml.replace_tables(self.path, {"gnome": {"x": 1}})
        self.assertEqual(self.path.read_text(), original)

    def test_refuses_unterminated_values(self):
        self.path.write_text('[gnome]\nmetric-options = [\n "a",\n')
        with self.assertRaises(config_toml.ConfigError):
            config_toml.replace_tables(self.path, {"gnome": {"metric-options": []}})

    def test_unicode_values_survive(self):
        config_toml.replace_tables(self.path, {"gnome": {"codex": ["😀 Team"]}})
        self.assertEqual(self.parsed()["gnome"]["codex"], ["😀 Team"])

    def test_preserves_file_permissions(self):
        self.path.write_text("[gnome]\nx = 1\n")
        self.path.chmod(0o600)
        config_toml.replace_tables(self.path, {"gnome": {"x": 2}})
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_concurrent_writes_do_not_lose_updates(self):
        # Two writers touching different tables must both land.
        self.path.write_text('[gnome]\nx = 1\n\n[display]\ny = 1\n')
        errors: list[BaseException] = []

        def write_gnome():
            try:
                for _ in range(20):
                    config_toml.replace_tables(self.path, {"gnome": {"x": 5}})
            except BaseException as error:  # pragma: no cover - failure path
                errors.append(error)

        def write_display():
            try:
                for _ in range(20):
                    config_toml.replace_tables(self.path, {"display": {"y": 7}})
            except BaseException as error:  # pragma: no cover - failure path
                errors.append(error)

        threads = [threading.Thread(target=write_gnome), threading.Thread(target=write_display)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        data = self.parsed()
        self.assertEqual(data["gnome"], {"x": 5})
        self.assertEqual(data["display"], {"y": 7})

    def test_leaves_no_temporary_files(self):
        config_toml.replace_tables(self.path, {"gnome": {"x": 1}})
        leftovers = [p.name for p in self.path.parent.iterdir() if p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])


class UpdateRootTests(TempConfig):
    def test_writes_managed_keys_after_the_header(self):
        config_toml.update_root(
            self.path,
            {"enabled": ["claude", "codex"], "show_user": False},
            remove=("enabled", "show_user"),
            header=("# agent-quota configuration",),
        )
        data = self.parsed()
        self.assertEqual(data["enabled"], ["claude", "codex"])
        self.assertFalse(data["show_user"])
        self.assertTrue(self.path.read_text().startswith("# agent-quota configuration"))

    def test_clears_a_removed_key(self):
        self.path.write_text('enabled = ["a"]\nshow_user = false\n')
        config_toml.update_root(self.path, {"enabled": ["b"]}, remove=("enabled", "show_user"))
        data = self.parsed()
        self.assertEqual(data["enabled"], ["b"])
        self.assertNotIn("show_user", data)

    def test_handles_a_quoted_key_without_duplicating_it(self):
        self.path.write_text('"enabled" = ["a"]\n')
        config_toml.update_root(self.path, {"enabled": ["b"]}, remove=("enabled",))
        self.assertEqual(self.parsed()["enabled"], ["b"])
        self.assertEqual(self.path.read_text().count("enabled"), 1)

    def test_replaces_a_multi_line_statement_completely(self):
        self.path.write_text('enabled = [\n  "a",\n  "b",\n]\n\n[gnome]\nx = 1\n')
        config_toml.update_root(self.path, {"enabled": ["c"]}, remove=("enabled",))
        data = self.parsed()
        self.assertEqual(data["enabled"], ["c"])
        self.assertEqual(data["gnome"], {"x": 1})
        self.assertNotIn('"a"', self.path.read_text())

    def test_keeps_comments_and_unmanaged_root_keys(self):
        self.path.write_text(
            "# agent-quota configuration\n"
            "# Edit this file or run `agent-quota setup` to change.\n"
            'enabled = ["a"]\n'
            "custom_root = 3\n"
            "\n"
            "[gnome]\n"
            "x = 1\n"
        )
        config_toml.update_root(self.path, {"enabled": ["b"]}, remove=("enabled",))
        data = self.parsed()
        self.assertEqual(data["enabled"], ["b"])
        self.assertEqual(data["custom_root"], 3)
        self.assertEqual(data["gnome"], {"x": 1})
        self.assertIn("# Edit this file or run", self.path.read_text())

    def test_refuses_invalid_toml(self):
        self.path.write_text("nope = [\n")
        with self.assertRaises(config_toml.ConfigError):
            config_toml.update_root(self.path, {"enabled": []}, remove=("enabled",))


class LoadTests(TempConfig):
    def test_missing_is_empty(self):
        self.assertEqual(config_toml.load(self.path), {})

    def test_invalid_is_an_error_not_empty(self):
        self.path.write_text("not toml [")
        with self.assertRaises(config_toml.ConfigError):
            config_toml.load(self.path)


if __name__ == "__main__":
    unittest.main()
