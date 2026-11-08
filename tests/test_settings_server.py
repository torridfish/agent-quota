"""Unit tests for the local Agent Quota settings server.

The HTTP layer is exercised manually against a temporary GSettings backend;
these tests cover the security-sensitive helpers: credential-file parsing,
write-only secret storage, layout validation, and metadata parsing.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import stat
import tempfile
import threading
import tomllib
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SERVER_PATH = REPO / "gnome-shell-extension" / "settings_server.py"

spec = importlib.util.spec_from_file_location("agent_quota_settings_server", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)
# settings_server puts the directory holding toml_edit.py on sys.path itself,
# which is also what makes it importable from a checkout.
toml_edit = importlib.import_module("toml_edit")

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
    """The credential-file helpers live in toml_edit and are shared with the CLI."""

    def test_last_assignment_wins(self) -> None:
        contents = "GITHUB_TOKEN=old\nOTHER=x\nGITHUB_TOKEN = new  \n"
        self.assertEqual(toml_edit.find_secret_value(contents, "GITHUB_TOKEN"), "new")

    def test_upsert_replaces_duplicates_and_preserves_other_lines(self) -> None:
        contents = "# comment\nA=1\nGITHUB_TOKEN=old\nB=2\nGITHUB_TOKEN=older\n"
        updated = toml_edit.upsert_secret_value(contents, "GITHUB_TOKEN", "new")
        self.assertEqual(updated.count("GITHUB_TOKEN="), 1)
        self.assertIn("A=1", updated)
        self.assertIn("B=2", updated)
        self.assertIn("GITHUB_TOKEN=new", updated)
        self.assertNotIn("old", updated)

    def test_upsert_appends_to_empty_file(self) -> None:
        self.assertEqual(toml_edit.upsert_secret_value("", "ZAI_TOKEN", "abc"), "ZAI_TOKEN=abc\n")

    def test_the_server_keeps_no_copy_of_the_helpers(self) -> None:
        for name in ("read_assignment", "upsert_assignment", "split_config_lines"):
            self.assertFalse(hasattr(server, name), name)


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

    def test_layout_accepts_per_workspace_ids_of_known_providers(self) -> None:
        ids = ["codex:ws-1", "codex:#2", "codex:ws-1#2", "codex:org_A.b@c"]
        raw = server.validate_layout({"columns": 3, "providers": [
            {"id": identifier, "gaugeColumns": 2, "order": ["5h"], "col": 1, "row": 0}
            for identifier in ids
        ]}, {"codex"})
        self.assertEqual([item["id"] for item in json.loads(raw)["providers"]], ids)

    def test_layout_rejects_bad_workspace_ids(self) -> None:
        for identifier in ("codex:", "other:ws", ":ws", "codex:a b", "codex:a/b", "codex:" + "x" * 65, "codexx", "codex:\n"):
            with self.subTest(identifier=identifier):
                with self.assertRaises(ValueError):
                    server.validate_layout({"columns": 3, "providers": [
                        {"id": identifier, "gaugeColumns": 1, "order": []}]}, {"codex"})

    def test_workspace_ids_keep_row_col_validation(self) -> None:
        with self.assertRaises(ValueError):
            server.validate_layout({"columns": 3, "providers": [
                {"id": "codex:ws", "gaugeColumns": 1, "order": [], "row": 101}]}, {"codex"})

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

    def test_new_keys_stay_above_the_next_tables_comment(self) -> None:
        contents = "[gnome]\nlayout-gap = 12\n\n# [other] settings\n[other]\nx = 1\n"
        updated = server.replace_gnome_section(contents, {"layout-gap": 12, "popup-width": 480})
        self.assertEqual(
            updated,
            "[gnome]\nlayout-gap = 12\npopup-width = 480\n\n# [other] settings\n[other]\nx = 1\n",
        )
        self.assertEqual(tomllib.loads(updated)["gnome"], {"layout-gap": 12, "popup-width": 480})

    def test_comment_directly_above_next_table_is_not_separated(self) -> None:
        contents = "[gnome]\na = 1\n# about other\n[other]\nx = 1\n"
        updated = server.replace_gnome_section(contents, {"a": 1, "b": 2})
        self.assertEqual(updated, "[gnome]\na = 1\nb = 2\n# about other\n[other]\nx = 1\n")

    def test_comment_under_the_last_key_stays_with_gnome(self) -> None:
        contents = "[gnome]\na = 1\n# about a\n\n# about other\n[other]\nx = 1\n"
        updated = server.replace_gnome_section(contents, {"a": 1, "b": 2})
        self.assertEqual(
            updated, "[gnome]\na = 1\n# about a\nb = 2\n\n# about other\n[other]\nx = 1\n")

    def test_comments_inside_gnome_and_at_end_of_file_are_kept(self) -> None:
        contents = "[gnome]\n# first\na = 1\n\n# middle\nb = 2\n# last note\n"
        updated = server.replace_gnome_section(contents, {"a": 1, "b": 2, "c": 3})
        self.assertEqual(updated, "[gnome]\n# first\na = 1\n\n# middle\nb = 2\n# last note\nc = 3\n")

    def test_empty_gnome_table_keeps_next_tables_comment(self) -> None:
        contents = "[gnome]\n# about other\n[other]\nx = 1\n"
        updated = server.replace_gnome_section(contents, {"a": 1})
        self.assertEqual(updated, "[gnome]\na = 1\n# about other\n[other]\nx = 1\n")

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
            self.assertEqual(server.read_gnome_section(path)["meter-style"], "bar")

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
            self.assertEqual(sorted(item.name for item in Path(temporary).iterdir()), ["config.toml", "config.toml.lock"])

    def test_write_merges_and_roundtrips(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            server.write_gnome_section(path, {"meter-style": "bar", "popup-width": 480})
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

    def test_read_section(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            self.assertIsNone(server.read_gnome_section(path))
            path.write_text('enabled = ["a"]\n')
            self.assertEqual(server.read_gnome_section(path), {})
            path.write_text('enabled = ["a"]\n[gnome]\n"refresh-seconds" = 30\n')
            self.assertEqual(server.read_gnome_section(path), {"refresh-seconds": 30})
            path.write_text("this is not toml [")
            with self.assertRaises(tomllib.TOMLDecodeError):
                server.read_gnome_section(path)


class GnomeSectionOwnedKeysTests(unittest.TestCase):
    LEAKED = (
        'enabled = ["claude"]\n\n[gnome]\n'
        "# keep me\n"
        'meter-style = "bar"\n'
        'codex-workspace-options = [\n'
        '    "Pro \u00b7 someone@example.com|ws-1",\n'
        '    "Team \u00b7 other@example.com|ws-2",\n'
        "]\n"
        "warning-threshold = 25 # inline\n"
        '"metric-options" = ["claude:5h"]\n'
        'popup-layout = """\n{"a": 1}"""\n'
        "\n[other]\nb = 1\n"
    )

    def write(self, directory: str, text: str) -> Path:
        path = Path(directory) / "config.toml"
        path.write_text(text, encoding="utf-8")
        return path

    def test_leaked_owned_keys_are_removed_with_multiline_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write(temporary, self.LEAKED)
            self.assertTrue(server.write_gnome_section(
                path, {"meter-style": "bar"}, remove=server.EXTENSION_OWNED_KEYS))
            text = path.read_text(encoding="utf-8")
            parsed = tomllib.loads(text)
            self.assertEqual(
                parsed["gnome"], {"meter-style": "bar", "warning-threshold": 25})
            self.assertEqual(parsed["other"], {"b": 1})
            self.assertNotIn("example.com", text)
            self.assertIn("# keep me", text)
            self.assertIn("# inline", text)

    def test_removed_key_is_not_removed_when_handed_a_value(self) -> None:
        updated = server.replace_gnome_section(
            self.LEAKED, {"popup-layout": "x"}, remove=server.EXTENSION_OWNED_KEYS)
        self.assertEqual(tomllib.loads(updated)["gnome"]["popup-layout"], "x")

    def test_only_listed_keys_are_removed(self) -> None:
        updated = server.replace_gnome_section(self.LEAKED, {}, remove={"metric-options"})
        gnome = tomllib.loads(updated)["gnome"]
        self.assertNotIn("metric-options", gnome)
        self.assertIn("codex-workspace-options", gnome)
        self.assertIn("popup-layout", gnome)

    def test_no_gnome_table_and_nothing_to_write_leaves_text_alone(self) -> None:
        contents = 'enabled = ["claude"]\n\n\n'
        self.assertEqual(
            server.replace_gnome_section(contents, {}, remove=server.EXTENSION_OWNED_KEYS), contents)

    def test_no_write_when_nothing_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = self.write(temporary, 'enabled = ["claude"]\n\n[gnome]\nmeter-style = "bar"\n')
            before = path.stat().st_mtime_ns
            with mock.patch.object(server, "atomic_write_text") as write:
                self.assertFalse(server.write_gnome_section(
                    path, {"meter-style": "bar"}, remove=server.EXTENSION_OWNED_KEYS))
            write.assert_not_called()
            self.assertEqual(path.stat().st_mtime_ns, before)

    def test_unicode_line_separators_in_comments_and_strings(self) -> None:
        for separator in ("\u2028", "\u2029", "\u0085"):
            with self.subTest(separator=hex(ord(separator))), tempfile.TemporaryDirectory() as temporary:
                path = self.write(
                    temporary,
                    f'enabled = ["claude"]\n\n[gnome]\n# note{separator}tail of comment\n'
                    f'meter-style = "circle"\nlabel = "a{separator}b"\n',
                )
                self.assertTrue(server.write_gnome_section(path, {"meter-style": "bar"}))
                text = path.read_text(encoding="utf-8")
                parsed = tomllib.loads(text)
                self.assertEqual(parsed["gnome"], {"meter-style": "bar", "label": f"a{separator}b"})
                self.assertIn(f"# note{separator}tail of comment\n", text)

    def test_unicode_separator_after_the_table_is_preserved(self) -> None:
        contents = '[gnome]\nmeter-style = "circle"\n\n[other]\n# x\u2028y\nname = "p\u2029q"\n'
        updated = server.replace_gnome_section(contents, {"meter-style": "bar"})
        self.assertEqual(updated, contents.replace('"circle"', '"bar"'))

    def test_crlf_style_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_bytes(b'enabled = ["claude"]\r\n\r\n[gnome]\r\n# c\r\nmeter-style = "circle"\r\n')
            server.write_gnome_section(path, {"meter-style": "bar", "layout-gap": 4})
            data = path.read_bytes()
            self.assertNotIn(b"\r\r", data)
            self.assertEqual(data.count(b"\n"), data.count(b"\r\n"))
            self.assertEqual(
                tomllib.loads(data.decode())["gnome"], {"meter-style": "bar", "layout-gap": 4})

    def test_lf_file_stays_lf(self) -> None:
        updated = server.replace_gnome_section('[gnome]\na = 1\n', {"b": 2})
        self.assertNotIn("\r", updated)


class FakeBackend:
    keys = {
        "popup-width", "meter-style", "popup-layout", "hidden-metrics",
        "metric-options", "codex-workspace-options", "codex-workspaces", "layout-gap", "layout-columns",
        "provider-order", "providers", "override-providers",
    }
    ranges = {"popup-width": (50, 720), "layout-gap": (0, 32), "layout-columns": (1, 5)}
    choices = {"meter-style": {"circle", "bar"}}

    def __init__(self) -> None:
        self.values: dict[str, object] = {
            "popup-width": 400, "meter-style": "circle", "popup-layout": "",
            "hidden-metrics": ["claude:5h"], "metric-options": ["claude:5h"],
            "codex-workspace-options": [], "codex-workspaces": [], "layout-gap": 12, "layout-columns": 3,
            "provider-order": [], "providers": ["claude"], "override-providers": False,
        }
        self.ranges = dict(type(self).ranges)
        self.writes: list[str] = []
        self.fail_on: str | None = None
        self.applies = 0
        self.reverts = 0
        self.in_batch = False

    def validate(self, key: str, value: object) -> object:
        if key == "override-providers" and not isinstance(value, bool):
            raise ValueError(f"{key} expects a boolean")
        if key in {"providers", "provider-order", "hidden-metrics", "codex-workspaces"} and (
            not isinstance(value, list) or not all(isinstance(item, str) for item in value)
        ):
            raise ValueError(f"{key} expects a string array")
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

    @contextlib.contextmanager
    def batch(self):
        """Models SettingsBackend.batch: all-or-nothing, counted."""
        snapshot = dict(self.values)
        self.in_batch = True
        try:
            yield
        except BaseException:
            self.values = snapshot
            self.reverts += 1
            raise
        else:
            self.applies += 1
        finally:
            self.in_batch = False

    def type_string(self, key: str) -> str:
        return "s"

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
            # The rejected key stays in the file as the user wrote it.
            self.assertEqual(tomllib.loads(path.read_text())["gnome"]["popup-width"], 99999999999)

    def test_out_of_range_and_bad_choice_are_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n[gnome]\npopup-width = 5\nmeter-style = "bogus"\n')
            app = self.app(path)
            app._apply_cli_config()
            self.assertEqual(app.backend.values["popup-width"], 400)
            self.assertEqual(app.backend.values["meter-style"], "circle")

    def test_rejected_file_values_are_never_rewritten(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            original = (
                'enabled = ["claude"]\n\n[gnome]\n'
                "# keep me\n"
                "layout-gap = 99\n"
                'meter-style = "bogus"\n'
                "popup-width = 500\n"
            )
            path.write_text(original)
            app = self.app(path)
            with mock.patch.object(server.sys, "stderr", io.StringIO()) as stderr:
                app._apply_cli_config()
            gnome = tomllib.loads(path.read_text())["gnome"]
            self.assertEqual(gnome["layout-gap"], 99)
            self.assertEqual(gnome["meter-style"], "bogus")
            self.assertIn("# keep me", path.read_text())
            self.assertEqual(app.backend.values["layout-gap"], 12)
            self.assertEqual(app.backend.values["popup-width"], 500)
            self.assertIn("layout-gap", stderr.getvalue())
            self.assertIn("meter-style", stderr.getvalue())
            # Genuinely absent keys are still topped up from dconf.
            self.assertEqual(gnome["layout-columns"], 3)

    def test_push_logs_only_values_that_change_dconf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(
                'enabled = ["claude"]\n\n[gnome]\nlayout-gap = 12\nmeter-style = "bar"\n'
                "popup-width = 500\n")
            app = self.app(path)
            with mock.patch.object(server.sys, "stderr", io.StringIO()) as stderr:
                app._apply_cli_config()
            lines = [line for line in stderr.getvalue().splitlines() if line.startswith("settings-server:")]
            self.assertEqual(sorted(lines), [
                "settings-server: config.toml sets meter-style = 'bar' (was 'circle')",
                "settings-server: config.toml sets popup-width = 500 (was 400)",
            ])  # layout-gap already matched dconf: silent
            self.assertEqual(app.backend.values["popup-width"], 500)
            # A second start finds dconf already matching the file: no output.
            with mock.patch.object(server.sys, "stderr", io.StringIO()) as stderr:
                app._apply_cli_config()
            self.assertEqual(stderr.getvalue(), "")

    def test_push_log_truncates_long_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            ids = [f"provider-{n:03d}" for n in range(40)]
            path.write_text("enabled = []\n[gnome]\nproviders = " + json.dumps(ids) + "\n")
            app = self.app(path)
            with mock.patch.object(server.sys, "stderr", io.StringIO()) as stderr:
                app._apply_cli_config()
            line = next(l for l in stderr.getvalue().splitlines() if l.startswith("settings-server:"))
            self.assertIn("...", line)
            self.assertIn("(was ['claude'])", line)
            self.assertLess(len(line), 200)

    def test_rejected_key_survives_saving_other_settings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n\n[gnome]\npopup-width = 20\nmeter-style = "bar"\n')
            app = self.app(path)
            with mock.patch.object(server.sys, "stderr", io.StringIO()):
                app._apply_cli_config()
            app.set_setting("layout-gap", 8)
            app.set_setting("meter-style", "circle")
            gnome = tomllib.loads(path.read_text())["gnome"]
            self.assertEqual(gnome["popup-width"], 20)
            self.assertEqual(gnome["layout-gap"], 8)
            self.assertEqual(gnome["meter-style"], "circle")
            self.assertEqual(app.backend.values["popup-width"], 400)

    def test_rejected_key_is_released_by_an_explicit_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n\n[gnome]\npopup-width = 20\nlayout-gap = 99\n')
            app = self.app(path)
            app.provider_ids = {"claude"}
            with mock.patch.object(server.sys, "stderr", io.StringIO()):
                app._apply_cli_config()
            # A rejected write does not release the key.
            with self.assertRaises(ValueError):
                app.set_setting("popup-width", 10)
            app.set_setting("meter-style", "bar")
            self.assertEqual(tomllib.loads(path.read_text())["gnome"]["popup-width"], 20)
            app.set_setting("popup-width", 300)
            gnome = tomllib.loads(path.read_text())["gnome"]
            self.assertEqual(gnome["popup-width"], 300)
            # Other rejected keys stay protected; set_layout releases its own.
            self.assertEqual(gnome["layout-gap"], 99)
            layout = {"columns": 3, "providers": [{"id": "claude", "gaugeColumns": 1, "order": []}]}
            app.set_layout({"layout": layout, "settings": {"layout-gap": 8}})
            self.assertEqual(tomllib.loads(path.read_text())["gnome"]["layout-gap"], 8)

    def test_set_setting_blocks_the_extension_owned_keys_the_user_does_not_pick(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary) / "config.toml")
            for key in server.EXTENSION_OWNED_KEYS - server.USER_WRITABLE_OWNED_KEYS:
                with self.subTest(key=key), self.assertRaises(ValueError):
                    app.set_setting(key, "x")
            self.assertEqual(app.set_setting("meter-style", "bar"), "bar")

    def test_selected_workspaces_are_owned_but_still_settable_and_never_mirrored(self) -> None:
        self.assertIn("codex-workspaces", server.EXTENSION_OWNED_KEYS)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            self.assertEqual(app.set_setting("codex-workspaces", ["ws-1"]), ["ws-1"])
            self.assertEqual(app.backend.values["codex-workspaces"], ["ws-1"])
            self.assertNotIn("ws-1", path.read_text())
            self.assertNotIn("codex-workspaces", tomllib.loads(path.read_text()).get("gnome", {}))

    def test_selected_workspaces_in_the_file_are_not_pushed_and_are_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(
                'enabled = ["claude"]\n[gnome]\ncodex-workspaces = ["ws-leaked"]\nmeter-style = "bar"\n')
            app = self.app(path)
            app._apply_cli_config()
            self.assertEqual(app.backend.values["codex-workspaces"], [])
            self.assertNotIn("ws-leaked", path.read_text())
            self.assertEqual(tomllib.loads(path.read_text())["gnome"]["meter-style"], "bar")

    def test_file_is_untouched_when_every_key_is_present_or_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            backend_keys = sorted(FakeBackend.keys - {"layout-gap"} - server.EXTENSION_OWNED_KEYS)
            lines = ['enabled = ["claude"]', "", "[gnome]", "layout-gap = 99"]
            for key in backend_keys:
                lines.append(f"{key} = {server.toml_value(FakeBackend().values[key])}")
            path.write_text("\n".join(lines) + "\n")
            before = path.read_text()
            with mock.patch.object(server.sys, "stderr", io.StringIO()):
                self.app(path)._apply_cli_config()
            self.assertEqual(path.read_text(), before)

    def test_hidden_metrics_in_file_is_pushed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n[gnome]\nhidden-metrics = ["claude:weekly", "codex:5h"]\n')
            app = self.app(path)
            app._apply_cli_config()
            self.assertEqual(app.backend.values["hidden-metrics"], ["claude:weekly", "codex:5h"])
            gnome = tomllib.loads(path.read_text())["gnome"]
            self.assertEqual(gnome["hidden-metrics"], ["claude:weekly", "codex:5h"])

    def test_invalid_hidden_metrics_in_file_is_rejected_and_left_alone(self) -> None:
        bad_values = [
            '"claude:5h"',
            "[1, 2]",
            "[" + ", ".join('"claude:%d"' % i for i in range(server.MAX_HIDDEN_METRICS + 1)) + "]",
            '["' + "x" * (server.MAX_HIDDEN_METRIC_LENGTH + 1) + '"]',
            '[""]',
        ]
        for bad in bad_values:
            with self.subTest(bad=bad[:30]), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "config.toml"
                path.write_text(f'enabled = ["claude"]\n[gnome]\nhidden-metrics = {bad}\n')
                app = self.app(path)
                with mock.patch.object(server.sys, "stderr", io.StringIO()) as stderr:
                    app._apply_cli_config()
                self.assertEqual(app.backend.values["hidden-metrics"], ["claude:5h"])
                self.assertNotIn("hidden-metrics", app.backend.writes)
                self.assertIn("hidden-metrics", stderr.getvalue())
                self.assertIn(f"hidden-metrics = {bad}", path.read_text())

    def test_set_setting_checks_hidden_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary) / "config.toml")
            with self.assertRaises(ValueError):
                app.set_setting("hidden-metrics", [""])
            self.assertEqual(app.backend.values["hidden-metrics"], ["claude:5h"])

    def test_extension_owned_keys_are_not_pushed_and_are_removed_from_the_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            hostile = json.dumps({"version": 1, "columns": 3, "providers": [
                {"id": "claude", "gaugeColumns": 1, "order": [], "row": 1000000000}]})
            path.write_text(
                'enabled = ["claude"]\n[gnome]\n'
                'metric-options = ["claude:old-label"]\n'
                f"popup-layout = {server.toml_value(hostile)}\n"
                'codex-workspace-options = ["stale"]\n'
                'meter-style = "bar"\n'
            )
            app = self.app(path)
            app._apply_cli_config()
            self.assertEqual(app.backend.values["metric-options"], ["claude:5h"])
            self.assertEqual(app.backend.values["popup-layout"], "")
            self.assertEqual(app.backend.values["codex-workspace-options"], [])
            self.assertEqual(app.backend.values["meter-style"], "bar")
            self.assertNotIn("popup-layout", app.backend.writes)
            gnome = tomllib.loads(path.read_text())["gnome"]
            # The file copies are dropped, not refreshed from dconf.
            for key in server.EXTENSION_OWNED_KEYS:
                self.assertNotIn(key, gnome)
            self.assertEqual(gnome["meter-style"], "bar")
            self.assertIn("hidden-metrics", gnome)  # user-facing keys still topped up

    def test_owned_keys_are_never_topped_up_from_dconf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n[gnome]\nmeter-style = "bar"\n')
            app = self.app(path)
            app.backend.values["codex-workspace-options"] = ["Pro · someone@example.com|ws-1"]
            app._apply_cli_config()
            text = path.read_text()
            for key in server.EXTENSION_OWNED_KEYS:
                self.assertNotIn(key, tomllib.loads(text)["gnome"])
            self.assertNotIn("someone@example.com", text)
            self.assertIn("layout-gap", tomllib.loads(text)["gnome"])

    def test_startup_removes_leaked_owned_keys_even_with_nothing_to_top_up(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            keys = sorted(FakeBackend.keys - server.EXTENSION_OWNED_KEYS)
            lines = ['enabled = ["claude"]', "", "[gnome]", "# mine"]
            lines += [f"{key} = {server.toml_value(FakeBackend().values[key])}" for key in keys]
            lines.append('codex-workspace-options = ["Pro · someone@example.com|ws-1"]')
            path.write_text("\n".join(lines) + "\n")
            self.app(path)._apply_cli_config()
            text = path.read_text()
            self.assertNotIn("someone@example.com", text)
            self.assertIn("# mine", text)
            self.assertEqual(sorted(tomllib.loads(text)["gnome"]), keys)

    def test_startup_push_is_one_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n[gnome]\nmeter-style = "bar"\nlayout-gap = 8\npopup-width = 5\n')
            app = self.app(path)
            with mock.patch.object(server.sys, "stderr", io.StringIO()):
                app._apply_cli_config()
            self.assertEqual((app.backend.applies, app.backend.reverts), (1, 0))
            self.assertEqual(sorted(app.backend.writes), ["layout-gap", "meter-style"])
            self.assertEqual(app.backend.values["popup-width"], 400)  # rejected, rest applied


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

    def test_hidden_metrics_and_workspaces_are_one_batch_and_one_file_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            with mock.patch.object(server, "atomic_write_text", wraps=server.atomic_write_text) as write:
                app.set_layout({"layout": self.layout, "settings": {
                    "layout-gap": 8,
                    "hidden-metrics": ["claude:7d"],
                    "codex-workspaces": ["ws-1", "ws-2"],
                }})
            self.assertEqual(write.call_count, 1)
            self.assertEqual((app.backend.applies, app.backend.reverts), (1, 0))
            self.assertEqual(app.backend.values["hidden-metrics"], ["claude:7d"])
            self.assertEqual(app.backend.values["codex-workspaces"], ["ws-1", "ws-2"])
            self.assertEqual(app.backend.values["layout-gap"], 8)
            gnome = tomllib.loads(path.read_text())["gnome"]
            self.assertEqual(gnome["hidden-metrics"], ["claude:7d"])  # user-facing: mirrored
            self.assertEqual(gnome["layout-gap"], 8)
            self.assertNotIn("codex-workspaces", gnome)  # extension-owned: dconf only
            self.assertNotIn("ws-1", path.read_text())

    def test_empty_hidden_metrics_and_workspaces_are_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary) / "config.toml")
            app.backend.values["codex-workspaces"] = ["ws-1"]
            app.set_layout({"layout": self.layout, "settings": {"hidden-metrics": [], "codex-workspaces": []}})
            self.assertEqual(app.backend.values["hidden-metrics"], [])
            self.assertEqual(app.backend.values["codex-workspaces"], [])

    def test_invalid_hidden_metrics_or_workspaces_write_nothing(self) -> None:
        too_many = [f"claude:{index}" for index in range(server.MAX_HIDDEN_METRICS + 1)]
        too_long = ["x" * (server.MAX_HIDDEN_METRIC_LENGTH + 1)]
        cases = [
            {"hidden-metrics": "claude:5h"},
            {"hidden-metrics": ["claude:5h", 3]},
            {"hidden-metrics": [""]},
            {"hidden-metrics": too_many},
            {"hidden-metrics": too_long},
            {"codex-workspaces": "ws-1"},
            {"codex-workspaces": ["ws-1", None]},
            # One bad value must sink the good ones next to it.
            {"layout-gap": 8, "hidden-metrics": ["claude:7d"], "codex-workspaces": [1]},
        ]
        for settings in cases:
            with self.subTest(settings=str(settings)[:60]), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "config.toml"
                path.write_text('enabled = ["claude"]\n')
                app = self.app(path)
                with self.assertRaises(ValueError):
                    app.set_layout({"layout": self.layout, "settings": settings})
                self.assertEqual(app.backend.writes, [])
                self.assertEqual((app.backend.applies, app.backend.reverts), (0, 0))
                self.assertEqual(app.backend.values["popup-layout"], "")
                self.assertEqual(app.backend.values["hidden-metrics"], ["claude:5h"])
                self.assertEqual(app.backend.values["codex-workspaces"], [])
                self.assertNotIn("gnome", tomllib.loads(path.read_text()))

    def test_write_failure_reverts_hidden_metrics_and_workspaces(self) -> None:
        for failing in ("hidden-metrics", "codex-workspaces"):
            with self.subTest(failing=failing), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "config.toml"
                path.write_text('enabled = ["claude"]\n')
                app = self.app(path)
                app.backend.fail_on = failing
                with self.assertRaises(ValueError):
                    app.set_layout({"layout": self.layout, "settings": {
                        "layout-gap": 8, "hidden-metrics": ["claude:7d"], "codex-workspaces": ["ws-1"]}})
                self.assertEqual(app.backend.reverts, 1)
                self.assertEqual(app.backend.values["hidden-metrics"], ["claude:5h"])
                self.assertEqual(app.backend.values["codex-workspaces"], [])
                self.assertEqual(app.backend.values["layout-gap"], 12)
                self.assertEqual(app.backend.values["popup-layout"], "")
                self.assertNotIn("gnome", tomllib.loads(path.read_text()))

    def test_unknown_layout_setting_is_still_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            app = self.app(Path(temporary) / "config.toml")
            with self.assertRaises(ValueError):
                app.set_layout({"layout": self.layout, "settings": {"meter-style": "bar"}})

    def test_provider_settings_are_applied_atomically_with_one_persist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app.provider_ids = {"claude", "codex"}
            with mock.patch.object(app, "_persist_cli_config", wraps=app._persist_cli_config) as persist:
                app.set_layout({"layout": self.layout, "settings": {
                    "layout-gap": 8,
                    "provider-order": ["codex", "claude"],
                    "providers": ["codex"],
                    "override-providers": True,
                }})
            self.assertEqual(persist.call_count, 1)
            values = app.backend.values
            self.assertEqual(values["provider-order"], ["codex", "claude"])
            self.assertEqual(values["providers"], ["codex"])
            self.assertIs(values["override-providers"], True)
            self.assertEqual(values["layout-gap"], 8)
            self.assertNotEqual(values["popup-layout"], "")
            gnome = tomllib.loads(path.read_text())["gnome"]
            self.assertEqual(gnome["providers"], ["codex"])
            self.assertEqual(gnome["provider-order"], ["codex", "claude"])

    def test_one_bad_provider_setting_rejects_everything(self) -> None:
        bad_settings = [
            {"provider-order": ["nope"]},
            {"providers": ["claude", "nope"]},
            {"providers": "claude"},
            {"provider-order": [1]},
            {"override-providers": "yes"},
            {"layout-gap": 99},
            {"not-a-key": 1},
        ]
        for bad in bad_settings:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "config.toml"
                path.write_text('enabled = ["claude"]\n')
                app = self.app(path)
                good = {"layout-gap": 8, "provider-order": ["claude"], "override-providers": True}
                with self.assertRaises(ValueError):
                    app.set_layout({"layout": self.layout, "settings": {**good, **bad}})
                self.assertEqual(app.backend.writes, [])
                self.assertEqual(app.backend.values["popup-layout"], "")
                self.assertEqual(app.backend.values["layout-gap"], 12)
                self.assertNotIn("gnome", tomllib.loads(path.read_text()))

    def test_provider_setting_write_failure_rolls_back(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app.backend.fail_on = "providers"
            with self.assertRaises(ValueError):
                app.set_layout({"layout": self.layout, "settings": {
                    "layout-gap": 8, "provider-order": ["claude"], "providers": ["claude"]}})
            self.assertEqual(app.backend.values["popup-layout"], "")
            self.assertEqual(app.backend.values["layout-gap"], 12)
            self.assertEqual(app.backend.values["provider-order"], [])
            self.assertNotIn("gnome", tomllib.loads(path.read_text()))

    def test_layout_save_is_one_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            observed: list[bool] = []
            real_set = app.backend.set

            def watching_set(key: str, value: object) -> object:
                observed.append(app.backend.in_batch)
                return real_set(key, value)

            app.backend.set = watching_set
            app.set_layout({"layout": self.layout, "settings": {
                "layout-gap": 8, "layout-columns": 2, "provider-order": ["claude"],
                "providers": ["claude"], "override-providers": True}})
            self.assertEqual(len(observed), 6)
            self.assertTrue(all(observed))
            self.assertEqual((app.backend.applies, app.backend.reverts), (1, 0))

    def test_failed_layout_save_reverts_the_batch_and_skips_persist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app.backend.fail_on = "providers"
            with mock.patch.object(app, "_persist_cli_config") as persist, self.assertRaises(ValueError):
                app.set_layout({"layout": self.layout, "settings": {
                    "layout-gap": 8, "providers": ["claude"]}})
            self.assertEqual((app.backend.applies, app.backend.reverts), (0, 1))
            self.assertEqual(app.backend.values["layout-gap"], 12)
            persist.assert_not_called()

    def test_set_setting_failure_does_not_persist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            with self.assertRaises(ValueError):
                app.set_setting("popup-width", 5000)
            self.assertNotIn("gnome", tomllib.loads(path.read_text()))


class PersistOwnedKeysTests(unittest.TestCase):
    def app(self, path: Path) -> "server.App":
        app = object.__new__(server.App)
        app.backend = FakeBackend()
        app.cli_config_path = path
        app.provider_ids = {"claude"}
        app.backend.values["codex-workspace-options"] = ["Pro \u00b7 someone@example.com|ws-1"]
        return app

    def test_owned_keys_are_never_written_to_the_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app.set_setting("meter-style", "bar")
            text = path.read_text()
            gnome = tomllib.loads(text)["gnome"]
            self.assertEqual(gnome["meter-style"], "bar")
            for key in server.EXTENSION_OWNED_KEYS:
                self.assertNotIn(key, gnome)
            self.assertNotIn("someone@example.com", text)

    def test_set_layout_does_not_mirror_popup_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app.set_layout({"layout": SetLayoutTests.layout, "settings": {"layout-gap": 8}})
            self.assertNotEqual(app.backend.values["popup-layout"], "")
            gnome = tomllib.loads(path.read_text())["gnome"]
            self.assertEqual(gnome["layout-gap"], 8)
            self.assertNotIn("popup-layout", gnome)

    def test_next_save_removes_leaked_copies_and_keeps_the_rest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(
                'enabled = ["claude"]\n\n[gnome]\n# mine\n'
                'codex-workspace-options = [\n  "Pro \u00b7 someone@example.com|ws-1",\n]\n'
                "warning-threshold = 25\n",
                encoding="utf-8",
            )
            self.app(path).set_setting("meter-style", "bar")
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("someone@example.com", text)
            self.assertIn("# mine", text)
            gnome = tomllib.loads(text)["gnome"]
            self.assertEqual(gnome["warning-threshold"], 25)
            self.assertNotIn("codex-workspace-options", gnome)

    def test_persist_without_changes_does_not_rewrite_the_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app.set_setting("meter-style", "bar")
            with mock.patch.object(server, "atomic_write_text") as write:
                app.set_setting("meter-style", "bar")
            write.assert_not_called()


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
    """Fake Gio.Settings: delay mode keeps writes pending until apply()."""

    def __init__(self, accept: bool = True, stored: dict | None = None) -> None:
        self.stored = stored if stored is not None else {"circle-radius": 16, "gauge-percent": "percent"}
        self.accept = accept
        self.delayed = False
        self.pending: dict[str, object] = {}
        self.applies = 0
        self.reverts = 0

    def delay(self) -> None:
        self.delayed = True

    def apply(self) -> None:
        self.applies += 1
        self.stored.update(self.pending)
        self.pending = {}

    def revert(self) -> None:
        self.reverts += 1
        self.pending = {}

    def set_value(self, key: str, variant: FakeVariant) -> bool:
        if not self.accept:
            return False
        if self.delayed:
            self.pending[key] = variant.value
        else:
            self.stored[key] = variant.value
        return True

    def get_value(self, key: str) -> FakeVariant:
        # Like Gio.Settings in delay mode, a read sees the pending value.
        return FakeVariant("x", self.pending.get(key, self.stored[key]))


class FakeGio:
    """Hands out delayed settings objects sharing the backend's store."""

    created: list[FakeGSettings] = []
    store: dict = {}
    accept = True

    class Settings:
        @staticmethod
        def new_full(schema: object, backend: object, path: object) -> FakeGSettings:
            settings = FakeGSettings(FakeGio.accept, FakeGio.store)
            FakeGio.created.append(settings)
            return settings


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

    def batched(self, accept: bool = True) -> "server.SettingsBackend":
        backend = self.backend(accept)
        FakeGio.created = []
        FakeGio.store = backend.settings.stored
        FakeGio.accept = accept
        original = server.Gio
        server.Gio = FakeGio
        self.addCleanup(setattr, server, "Gio", original)
        return backend

    def test_batch_applies_once_and_hides_writes_until_then(self) -> None:
        backend = self.batched()
        with backend.batch():
            self.assertEqual(backend.set("circle-radius", 20), 20)
            backend.set("gauge-percent", "number")
            # A second reader still sees the committed state.
            self.assertEqual(backend.get("circle-radius"), 16)
            self.assertEqual(backend.get("gauge-percent"), "percent")
        self.assertEqual(len(FakeGio.created), 1)
        delayed = FakeGio.created[0]
        self.assertEqual((delayed.applies, delayed.reverts), (1, 0))
        self.assertEqual(backend.get("circle-radius"), 20)
        self.assertEqual(backend.get("gauge-percent"), "number")

    def test_batch_failure_reverts_and_applies_nothing(self) -> None:
        backend = self.batched()
        with self.assertRaisesRegex(ValueError, "between 10 and 32"):
            with backend.batch():
                backend.set("gauge-percent", "number")
                backend.set("circle-radius", 500)
        delayed = FakeGio.created[0]
        self.assertEqual((delayed.applies, delayed.reverts), (0, 1))
        self.assertEqual(backend.settings.stored, {"circle-radius": 16, "gauge-percent": "percent"})

    def test_batch_set_value_false_reverts(self) -> None:
        backend = self.batched(accept=False)
        with self.assertRaisesRegex(ValueError, "rejected"):
            with backend.batch():
                backend.set("circle-radius", 20)
        self.assertEqual((FakeGio.created[0].applies, FakeGio.created[0].reverts), (0, 1))

    def test_single_key_set_after_a_batch_is_written_straight_through(self) -> None:
        backend = self.batched()
        with backend.batch():
            backend.set("circle-radius", 20)
        backend.set("circle-radius", 24)
        self.assertEqual(backend.settings.stored["circle-radius"], 24)
        self.assertFalse(backend.settings.delayed)
        self.assertEqual(len(FakeGio.created), 1)

    def test_failed_batch_does_not_leave_later_writes_pending(self) -> None:
        backend = self.batched()
        with self.assertRaises(ValueError):
            with backend.batch():
                backend.set("circle-radius", 500)
        backend.set("circle-radius", 24)
        self.assertEqual(backend.settings.stored["circle-radius"], 24)

    def test_batches_do_not_nest(self) -> None:
        backend = self.batched()
        with backend.batch():
            with self.assertRaises(RuntimeError):
                with backend.batch():
                    pass
        self.assertEqual((FakeGio.created[0].applies, FakeGio.created[0].reverts), (1, 0))


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


class SecretStoreUnreadableFileTests(unittest.TestCase):
    ORIGINAL = "# my notes\nOTHER=keep\nZAI_TOKEN=old\n"

    def store(self, temporary: str) -> tuple["server.SecretStore", Path]:
        directory = Path(temporary)
        path = directory / "zai.conf"
        path.write_text(self.ORIGINAL)
        return server.SecretStore(PROVIDERS, directory), path

    def test_permission_error_leaves_the_file_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, path = self.store(temporary)
            real = open

            def deny(file: object, *args: object, **kwargs: object) -> object:
                if file == path:
                    raise PermissionError(13, "Permission denied", str(path))
                return real(file, *args, **kwargs)

            with mock.patch.object(toml_edit, "open", deny, create=True):
                with self.assertRaises(server.SettingsError) as raised:
                    store.set("zai", "ZAI_TOKEN", "new")
            self.assertIsInstance(raised.exception, server.CredentialFileError)
            self.assertEqual(raised.exception.code, "credential_unreadable")
            self.assertIn(str(path), str(raised.exception))
            self.assertIn("Permission denied", str(raised.exception))
            self.assertEqual(path.read_text(), self.ORIGINAL)

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root ignores file modes")
    def test_chmod_000_leaves_the_file_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, path = self.store(temporary)
            path.chmod(0)
            try:
                with self.assertRaises(server.CredentialFileError):
                    store.set("zai", "ZAI_TOKEN", "new")
            finally:
                path.chmod(0o600)
            self.assertEqual(path.read_text(), self.ORIGINAL)

    def test_undecodable_file_raises_settings_error_not_value_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, path = self.store(temporary)
            path.write_bytes(b"ZAI_TOKEN=\xff\xfe\n")
            with self.assertRaises(server.CredentialFileError) as raised:
                store.set("zai", "ZAI_TOKEN", "new")
            self.assertNotIsInstance(raised.exception, ValueError)
            self.assertIn(str(path), str(raised.exception))
            self.assertEqual(path.read_bytes(), b"ZAI_TOKEN=\xff\xfe\n")
            self.assertFalse(store.configured("zai"))  # state() must not crash on it

    def test_set_waits_for_the_cross_process_file_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, path = self.store(temporary)
            done = threading.Event()

            def work() -> None:
                store.set("zai", "ZAI_TOKEN", "new")
                done.set()

            with toml_edit.file_lock(path):
                thread = threading.Thread(target=work)
                thread.start()
                self.assertFalse(done.wait(0.3))
                self.assertEqual(path.read_text(), self.ORIGINAL)
            thread.join(5)
            self.assertTrue(done.is_set())
            self.assertEqual(path.read_text(), "# my notes\nOTHER=keep\nZAI_TOKEN=new\n")

    def test_crlf_endings_and_mode_survive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, path = self.store(temporary)
            path.write_bytes(b"# notes\r\nOTHER=keep\r\nZAI_TOKEN=old\r\n")
            path.chmod(0o644)
            self.assertTrue(store.set("zai", "ZAI_TOKEN", "new"))
            self.assertEqual(path.read_bytes(), b"# notes\r\nOTHER=keep\r\nZAI_TOKEN=new\r\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertTrue(store.configured("zai"))

    def test_server_and_cli_write_identical_bytes_on_mixed_endings(self) -> None:
        import agent_quota
        original = b"# a\r\nOTHER=1\nZAI_TOKEN=old\r\n\nLAST=2\n"
        with tempfile.TemporaryDirectory() as temporary:
            store, path = self.store(temporary)
            path.write_bytes(original)
            store.set("zai", "ZAI_TOKEN", "new")
            by_server = path.read_bytes()
            path.write_bytes(original)
            agent_quota._save_secret_value(path, "ZAI_TOKEN", "new")
            self.assertEqual(path.read_bytes(), by_server)

    def test_missing_file_is_still_created(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "config"
            store = server.SecretStore(PROVIDERS, directory)
            self.assertTrue(store.set("zai", "ZAI_TOKEN", "new"))
            self.assertEqual(
                (directory / "zai.conf").read_text(),
                "# Managed by Agent Quota GNOME extension\nZAI_TOKEN=new\n",
            )

    def test_existing_file_is_updated_preserving_other_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            store, path = self.store(temporary)
            store.set("zai", "ZAI_TOKEN", "new")
            self.assertEqual(path.read_text(), "# my notes\nOTHER=keep\nZAI_TOKEN=new\n")


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
            # Only the real file and its sidecar lock; no stray temp files.
            self.assertEqual(sorted(item.name for item in real.parent.iterdir()), ["config.toml", "config.toml.lock"])

    def test_config_mode_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            path.chmod(0o644)
            server.write_gnome_section(path, {"a": 1})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            path.chmod(0o600)
            server.write_gnome_section(path, {"a": 2})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_existing_directory_mode_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary) / "cfg"
            directory.mkdir()
            directory.chmod(0o755)
            path = directory / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            server.write_gnome_section(path, {"a": 1})
            server.write_private_json(directory / "info.json", {"a": 1})
            server.SecretStore(PROVIDERS, directory).set("zai", "ZAI_TOKEN", "t")
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755)
            self.assertEqual(stat.S_IMODE((directory / "info.json").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(server.SecretStore(PROVIDERS, directory)._file("zai").stat().st_mode), 0o600)

    def test_symlinked_directory_is_not_chmodded(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            real = Path(temporary) / "dotfiles"
            real.mkdir()
            real.chmod(0o755)
            link = Path(temporary) / "cfg"
            link.symlink_to(real)
            path = link / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            with mock.patch.object(server.os, "chmod", side_effect=PermissionError) as chmod:
                server.write_gnome_section(path, {"a": 1})
                server.write_private_json(link / "info.json", {"a": 1})
                server.SecretStore(PROVIDERS, link).set("zai", "ZAI_TOKEN", "t")
            chmod.assert_not_called()
            self.assertEqual(stat.S_IMODE(real.stat().st_mode), 0o755)
            self.assertEqual(tomllib.loads(path.read_text())["gnome"], {"a": 1})

    def test_new_directory_is_private_and_chmod_failure_is_harmless(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            created = Path(temporary) / "a" / "cfg"
            old = os.umask(0)
            try:
                self.assertTrue(server.ensure_private_dir(created))
                self.assertFalse(server.ensure_private_dir(created))
            finally:
                os.umask(old)
            self.assertEqual(stat.S_IMODE(created.stat().st_mode), 0o700)
            (created / "config.toml").write_text('enabled = ["claude"]\n')
            server.write_gnome_section(created / "config.toml", {"a": 1})
            self.assertEqual(stat.S_IMODE(created.stat().st_mode), 0o700)
            other = Path(temporary) / "b"
            with mock.patch.object(server.os, "chmod", side_effect=PermissionError):
                server.write_private_json(other / "info.json", {"a": 1})
            self.assertEqual(json.loads((other / "info.json").read_text()), {"a": 1})

    def test_write_gnome_section_waits_for_the_cross_process_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            done = threading.Event()

            def work() -> None:
                server.write_gnome_section(path, {"meter-style": "bar"})
                done.set()

            with toml_edit.file_lock(path):
                thread = threading.Thread(target=work)
                thread.start()
                self.assertFalse(done.wait(0.3))
                self.assertNotIn("gnome", tomllib.loads(path.read_text()))
            thread.join(5)
            self.assertTrue(done.is_set())
            self.assertEqual(tomllib.loads(path.read_text())["gnome"], {"meter-style": "bar"})

    def test_missing_config_does_not_create_directory_or_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "absent" / "config.toml"
            self.assertFalse(server.write_gnome_section(path, {"a": 1}))
            self.assertFalse(path.parent.exists())

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
            self.assertEqual(
                sorted(item.name for item in Path(temporary).iterdir()), ["zai.conf", "zai.conf.lock"])


if __name__ == "__main__":
    unittest.main()


class ConfigErrorReportingTests(unittest.TestCase):
    """Failures mirroring to config.toml are reported, a missing file is not."""

    def app(self, path: Path) -> "server.App":
        app = object.__new__(server.App)
        app.backend = FakeBackend()
        app.cli_config_path = path
        app.provider_ids = {"claude"}
        app.providers = []
        app.browsers = [""]
        app.secrets = mock.Mock(configured=lambda _id: False)
        return app

    def test_missing_config_is_silent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            app = self.app(path)
            app._apply_cli_config()
            self.assertEqual(app.set_setting("layout-gap", 8), 8)
            self.assertIsNone(app.config_error)
            self.assertIsNone(app.state()["configError"])
            self.assertFalse(path.exists())

    def test_unparseable_file_at_startup_sets_config_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"\n')
            app = self.app(path)
            app._apply_cli_config()
            self.assertIn(str(path), app.config_error)
            self.assertIn("could not be parsed", app.state()["configError"])
            self.assertEqual(path.read_text(), 'enabled = ["claude"\n')

    def test_set_setting_on_unparseable_file_raises_but_keeps_dconf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("[gnome\n")
            app = self.app(path)
            with self.assertRaises(server.SettingsError) as raised:
                app.set_setting("layout-gap", 8)
            message = str(raised.exception)
            self.assertTrue(message.startswith("saved in dconf, but "), message)
            self.assertIn(str(path), message)
            self.assertEqual(app.backend.values["layout-gap"], 8)  # no rollback
            self.assertEqual(path.read_text(), "[gnome\n")
            self.assertEqual(app.state()["configError"], app.config_error)
            self.assertIn("could not be parsed", app.config_error)
            self.assertIn("could not be updated", app.last_write_error)

    def test_set_layout_write_failure_raises_after_applying(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            layout = {"columns": 3, "providers": [{"id": "claude", "gaugeColumns": 1, "order": []}]}
            with mock.patch.object(server, "atomic_write_text", side_effect=PermissionError("read-only")):
                with self.assertRaises(server.SettingsError) as raised:
                    app.set_layout({"layout": layout, "settings": {"layout-gap": 8}})
            self.assertIn("read-only", str(raised.exception))
            self.assertEqual(app.backend.values["layout-gap"], 8)
            self.assertIn("read-only", app.config_error)
            self.assertIn("read-only", app.state()["configError"])

    def test_config_error_clears_after_a_successful_write(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("[gnome\n")
            app = self.app(path)
            with self.assertRaises(server.SettingsError):
                app.set_setting("layout-gap", 8)
            self.assertIsNotNone(app.config_error)
            path.write_text('enabled = ["claude"]\n')  # the user fixed it
            app.set_setting("layout-gap", 9)
            self.assertIsNone(app.config_error)
            self.assertIsNone(app.state()["configError"])
            self.assertEqual(tomllib.loads(path.read_text())["gnome"]["layout-gap"], 9)

    def test_config_error_clears_when_startup_read_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n[gnome]\n')
            app = self.app(path)
            app.last_write_error = "stale"
            app._apply_cli_config()
            self.assertIsNone(app.config_error)
            self.assertIsNone(app.last_write_error)

    def test_fixing_the_file_after_startup_clears_the_banner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"\n')
            app = self.app(path)
            app._apply_cli_config()
            self.assertIn("could not be parsed", app.state()["configError"])
            path.write_text('enabled = ["claude"]\n')  # fixed, no write happened
            self.assertIsNone(app.state()["configError"])

    def test_corrupting_the_file_after_startup_raises_the_banner(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            app._apply_cli_config()
            self.assertIsNone(app.state()["configError"])
            path.write_text("[gnome\n")
            self.assertIn(str(path), app.state()["configError"])
            path.write_bytes(b"enabled = \xff\n")
            self.assertIn("could not be", app.state()["configError"])

    def test_parse_write_failure_clears_once_the_file_parses(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("[gnome\n")
            app = self.app(path)
            with self.assertRaises(server.SettingsError):
                app.set_setting("layout-gap", 8)
            path.write_text('enabled = ["claude"]\n')
            self.assertIsNone(app.state()["configError"])
            self.assertIsNone(app.last_write_error)

    def test_os_write_failure_persists_until_a_write_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            with mock.patch.object(server, "atomic_write_text", side_effect=PermissionError("read-only")):
                with self.assertRaises(server.SettingsError):
                    app.set_setting("layout-gap", 8)
            for _ in range(2):  # the file parses, yet the failure stays
                self.assertIn("read-only", app.state()["configError"])
            app.set_setting("layout-gap", 9)
            self.assertIsNone(app.state()["configError"])

    def test_file_removed_after_startup_is_silent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("[gnome\n")
            app = self.app(path)
            app._apply_cli_config()
            self.assertIsNotNone(app.state()["configError"])
            path.unlink()
            self.assertIsNone(app.state()["configError"])

    def test_startup_topup_write_failure_sets_config_error(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["claude"]\n')
            app = self.app(path)
            with mock.patch.object(server, "atomic_write_text", side_effect=OSError("disk full")):
                app._apply_cli_config()
            self.assertIn("disk full", app.config_error)


class WriteFailureAtomicityTests(unittest.TestCase):
    def app(self, path: Path) -> "server.App":
        app = object.__new__(server.App)
        app.backend = FakeBackend()
        app.cli_config_path = path
        return app

    def test_pair_is_one_value_replaced_together(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("[gnome\n")
            app = self.app(path)
            app._record_write_failure("boom")
            self.assertEqual(app._write_failure, ("boom", True))
            self.assertEqual((app.last_write_error, app.last_write_error_was_parse), ("boom", True))
            path.write_text('enabled = []\n')
            app._record_write_failure("later")
            self.assertEqual(app._write_failure, ("later", False))
            app.last_write_error = None
            self.assertIsNone(app._write_failure)
            self.assertFalse(app.last_write_error_was_parse)

    def test_get_cannot_clear_a_failure_recorded_while_it_runs(self) -> None:
        # Deterministic interleaving: a POST records a parse failure while a GET
        # is inside config_error, after the GET read the (parsing) file.  The
        # error lock makes the POST wait, so its fresh failure is not cleared.
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("enabled = []\n")
            app = self.app(path)
            app._write_failure = ("old parse failure", True)
            in_read = threading.Event()
            release = threading.Event()
            real = app._read_problem
            calls = []

            def slow_read() -> str | None:
                result = real()
                if threading.current_thread().name == "getter" and not calls:
                    calls.append(1)
                    in_read.set()
                    release.wait(5)
                return result

            app._read_problem = slow_read
            seen: list[object] = []
            getter = threading.Thread(target=lambda: seen.append(app.config_error), name="getter")
            getter.start()
            self.assertTrue(in_read.wait(5))
            path.write_text("[gnome\n")  # the file breaks, then the POST records it
            poster = threading.Thread(target=app._record_write_failure, args=("new failure",), name="poster")
            poster.start()
            poster.join(0.2)
            self.assertTrue(poster.is_alive())  # blocked on the error lock
            release.set()
            getter.join(5)
            poster.join(5)
            self.assertEqual(seen, [None])
            self.assertEqual(app._write_failure, ("new failure", True))

    def test_hammering_never_yields_a_mismatched_pair(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = []\n')
            app = self.app(path)
            stop = threading.Event()
            problems: list[object] = []

            def reader() -> None:
                while not stop.is_set():
                    failure = app._write_failure
                    if failure is not None and failure[0] not in ("a", "b"):
                        problems.append(failure)
                    app.config_error

            def writer(message: str) -> None:
                for _ in range(300):
                    app._record_write_failure(message)
                    app.last_write_error = None

            threads = [threading.Thread(target=reader) for _ in range(3)]
            writers = [threading.Thread(target=writer, args=(m,)) for m in "ab"]
            for thread in threads + writers:
                thread.start()
            for thread in writers:
                thread.join(30)
            stop.set()
            for thread in threads:
                thread.join(30)
            self.assertEqual(problems, [])
            self.assertFalse(any(t.is_alive() for t in threads + writers))


class SettingsErrorHttpTests(unittest.TestCase):
    def post(self, app: object, route: str, body: dict) -> tuple[int, dict]:
        import http.client
        app.token = "good-token"
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.daemon_threads = True
        httpd.app = app
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        connection = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)
        connection.request(
            "POST", route, body=json.dumps(body),
            headers={server.TOKEN_HEADER: "good-token", "Content-Type": "application/json"})
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        return response.status, payload

    def test_settings_error_is_a_500_with_a_persisted_marker(self) -> None:
        app = mock.Mock()
        app.set_setting.side_effect = server.SettingsError("saved in dconf, but /x/config.toml could not be updated: nope")
        app.config_error = "/x/config.toml could not be updated: nope"
        status, payload = self.post(app, "/api/settings", {"key": "layout-gap", "value": 8})
        self.assertEqual(status, 500)
        self.assertEqual(payload, {
            "error": "saved in dconf, but /x/config.toml could not be updated: nope",
            "code": "config_not_persisted",
            "persisted": False,
            "configError": "/x/config.toml could not be updated: nope",
        })

    def test_layout_settings_error_is_also_a_500(self) -> None:
        app = mock.Mock()
        app.set_layout.side_effect = server.SettingsError("saved in dconf, but nope")
        app.config_error = "nope"
        status, payload = self.post(app, "/api/layout", {})
        self.assertEqual(status, 500)
        self.assertIs(payload["persisted"], False)

    def test_credential_error_is_a_500_that_does_not_claim_dconf(self) -> None:
        app = mock.Mock()
        app.secrets.set.side_effect = server.CredentialFileError("/x/zai.conf could not be read: nope")
        app.config_error = "should not be reported"
        status, payload = self.post(
            app, "/api/secret", {"provider": "zai", "key": "ZAI_TOKEN", "value": "v"})
        self.assertEqual(status, 500)
        self.assertEqual(payload, {
            "error": "/x/zai.conf could not be read: nope",
            "code": "credential_unreadable",
        })

    def test_value_error_stays_a_400_without_the_marker(self) -> None:
        app = mock.Mock()
        app.set_setting.side_effect = ValueError("layout-gap is out of range")
        status, payload = self.post(app, "/api/settings", {"key": "layout-gap", "value": 99})
        self.assertEqual(status, 400)
        self.assertEqual(payload, {"error": "layout-gap is out of range"})


class SharedModuleRouteTests(unittest.TestCase):
    ROUTES = ("/layout-model.js", "/meter-layout.js", "/workspace-selection.js")

    def serve(self, extension_dir: Path):
        import http.client
        app = mock.Mock()
        app.web_dir = extension_dir / "web-settings"
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.daemon_threads = True
        httpd.app = app
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=5)

    def test_extension_modules_are_served_as_javascript_with_security_headers(self) -> None:
        for route in self.ROUTES:
            with self.subTest(route=route), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                (directory / "web-settings").mkdir()
                (directory / route.removeprefix("/")).write_text("export const x = 1;\n")
                connection = self.serve(directory)
                connection.request("GET", route)
                response = connection.getresponse()
                body = response.read()
                connection.close()
                self.assertEqual(response.status, 200)
                self.assertEqual(body, b"export const x = 1;\n")
                self.assertEqual(response.getheader("Content-Type"), "text/javascript; charset=utf-8")
                for name, value in server.SECURITY_HEADERS.items():
                    self.assertEqual(response.getheader(name), value)

    def test_unknown_or_missing_module_is_404(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "web-settings").mkdir()
            (directory / "secret.js").write_text("nope")
            connection = self.serve(directory)
            for route in ("/workspace-selection.js", "/../secret.js"):
                connection.request("GET", route)
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 404)

    def test_real_extension_ships_workspace_selection(self) -> None:
        source = (REPO / "gnome-shell-extension" / "workspace-selection.js").read_text()
        self.assertIn("export function selectionAfterWorkspaceToggle", source)


class AuthorizationTests(unittest.TestCase):
    def serve(self):
        import http.client
        app = mock.Mock()
        app.token = "good-token"
        app.state.return_value = {"ok": True}
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.daemon_threads = True
        httpd.app = app
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return httpd.server_address[1], http.client

    def test_non_ascii_token_is_forbidden_not_a_dead_connection(self) -> None:
        port, client = self.serve()
        for path, headers in [
            ("/api/state?token=%C3%A9", {}),
            ("/api/state?token=%FF%FE", {}),
            ("/api/state", {server.TOKEN_HEADER: "\u00e9".encode("latin-1")}),
            ("/api/state", {server.TOKEN_HEADER: b"\xff\xfe"}),
        ]:
            with self.subTest(path=path, headers=headers):
                connection = client.HTTPConnection("127.0.0.1", port, timeout=5)
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                connection.close()

    def test_good_token_is_accepted(self) -> None:
        port, client = self.serve()
        connection = client.HTTPConnection("127.0.0.1", port, timeout=5)
        connection.request("GET", "/api/state?token=good-token")
        self.assertEqual(connection.getresponse().status, 200)
        connection.close()


class LogRedactionTests(unittest.TestCase):
    def log_for(self, request: bytes) -> str:
        import socket
        app = mock.Mock()
        app.token = "good-token"
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        httpd.daemon_threads = True
        httpd.app = app
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        stderr = io.StringIO()
        with mock.patch.object(server.sys, "stderr", stderr):
            with socket.create_connection(httpd.server_address, timeout=5) as connection:
                connection.sendall(request)
                while connection.recv(4096):
                    pass
        return stderr.getvalue()

    def test_bad_request_line_never_logs_the_token(self) -> None:
        for request in (
            # Four words: send_error logs "Bad request syntax (<raw request line>)".
            b"GET /api/state?x=1&token=SECRET-VALUE extra HTTP/1.1\r\n\r\n",
            b"GET /api/state?token=SECRET-VALUE extra HTTP/1.1\r\n\r\n",
            b"GET /api/state?token=SECRET-VALUE HTTP/9.9\r\n\r\n",  # unsupported version
            b"BREW /api/state?token=SECRET-VALUE HTTP/1.1\r\n\r\n",  # unsupported method
        ):
            with self.subTest(request=request):
                log = self.log_for(request)
                self.assertIn("127.0.0.1", log, "the failed request should still be logged")
                self.assertNotIn("SECRET-VALUE", log)
                self.assertNotIn("Traceback", log)

    def test_log_message_redacts_every_token_in_the_formatted_text(self) -> None:
        handler = object.__new__(server.Handler)
        handler.client_address = ("127.0.0.1", 1)
        stderr = io.StringIO()
        with mock.patch.object(server.sys, "stderr", stderr):
            handler.log_message('code %d, message %s', 400, "Bad request syntax ('GET /?token=ONE&a=1 HTTP/1.1')")
            handler.log_message("%s", "token=TWO")
        self.assertNotIn("ONE", stderr.getvalue())
        self.assertNotIn("TWO", stderr.getvalue())
        self.assertIn("a=1", stderr.getvalue())
