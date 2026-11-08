"""CLI config.toml persistence: save_config must not touch tables it does not own.

The GNOME extension settings server mirrors its GSettings into the [gnome]
table of ~/.config/agent-quota/config.toml.  `agent-quota setup` rewrites the
CLI's own keys (enabled, show_user) and has to keep that table verbatim.
"""

from __future__ import annotations

import io
import os
import stat
import tempfile
import threading
import tomllib
import unittest
from pathlib import Path
from unittest import mock

import agent_quota
import toml_edit


class SaveConfigTests(unittest.TestCase):
    def test_writes_enabled_and_show_user(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["claude", "codex"], show_user=False)
            data = tomllib.loads(path.read_text())
            self.assertEqual(data["enabled"], ["claude", "codex"])
            self.assertFalse(data["show_user"])

    def test_preserves_gnome_table(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(
                'enabled = ["old"]\n'
                "\n"
                "[gnome]\n"
                'meter-style = "bar"\n'
                "popup-width = 480\n"
            )
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["zen"], show_user=True)
            data = tomllib.loads(path.read_text())
            self.assertEqual(data["enabled"], ["zen"])
            self.assertNotIn("show_user", data)
            self.assertEqual(data["gnome"], {"meter-style": "bar", "popup-width": 480})

    def test_replaces_stale_managed_keys_without_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["old"]\nshow_user = false\n\n[gnome]\n"refresh-seconds" = 60\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["kimi"], show_user=True)
            data = tomllib.loads(path.read_text())
            self.assertEqual(data["enabled"], ["kimi"])
            self.assertNotIn("show_user", data)
            self.assertEqual(data["gnome"], {"refresh-seconds": 60})


class AtomicSaveTests(unittest.TestCase):
    def test_create_uses_0644_and_leaves_no_temp_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sub" / "config.toml"
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["zen"])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["config.toml", "config.toml.lock"])

    def test_existing_mode_is_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["a"]\n')
            path.chmod(0o600)
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["zen"])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_symlinked_config_is_written_through(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            real = Path(temporary) / "dotfiles" / "config.toml"
            real.parent.mkdir()
            real.write_text('enabled = ["a"]\n')
            link = Path(temporary) / "config.toml"
            link.symlink_to(real)
            with mock.patch.object(agent_quota, "CONFIG_PATH", link):
                agent_quota.save_config(["zen"])
            self.assertTrue(link.is_symlink())
            self.assertEqual(tomllib.loads(real.read_text())["enabled"], ["zen"])
            self.assertTrue((real.parent / "config.toml.lock").exists())
            self.assertFalse((Path(temporary) / "config.toml.lock").exists())

    def test_crash_during_write_keeps_the_old_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["a"]\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(toml_edit.os, "replace", side_effect=OSError("boom")):
                with self.assertRaises(OSError):
                    agent_quota.save_config(["zen"])
            self.assertEqual(path.read_text(), 'enabled = ["a"]\n')
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["config.toml", "config.toml.lock"])

    def test_save_waits_for_the_shared_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["a"]\n')
            done = threading.Event()

            def work() -> None:
                with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                    agent_quota.save_config(["zen"])
                done.set()

            with toml_edit.file_lock(path):
                thread = threading.Thread(target=work)
                thread.start()
                self.assertFalse(done.wait(0.3))
                self.assertEqual(tomllib.loads(path.read_text())["enabled"], ["a"])
            thread.join(5)
            self.assertTrue(done.is_set())
            self.assertEqual(tomllib.loads(path.read_text())["enabled"], ["zen"])

    def test_lock_file_is_the_one_the_settings_server_uses(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            self.assertEqual(toml_edit.lock_path_for(path), Path(os.path.realpath(path)).with_name("config.toml.lock"))


class ConfigRobustnessTests(unittest.TestCase):
    def save(self, initial: str | None, enabled=("zen",), show_user=True) -> str:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            if initial is not None:
                path.write_text(initial)
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(list(enabled), show_user=show_user)
            return path.read_text()

    def test_multiline_enabled_array_is_replaced_whole(self) -> None:
        text = self.save(
            '# my note\nenabled = [\n  "claude", # first\n  "codex",\n]\n'
            'show_user = false\n\n[gnome]\nmeter-style = "bar"\n'
        )
        data = tomllib.loads(text)
        self.assertEqual(data["enabled"], ["zen"])
        self.assertNotIn("show_user", data)
        self.assertEqual(data["gnome"], {"meter-style": "bar"})
        self.assertNotIn("claude", text)

    def test_multiline_array_of_arrays_does_not_look_like_a_table(self) -> None:
        text = self.save('other = [\n  [1, 2],\n  [3]\n]\nenabled = ["a"]\n\n[gnome]\nx = 1\n')
        data = tomllib.loads(text)
        self.assertEqual(data["other"], [[1, 2], [3]])
        self.assertEqual(data["enabled"], ["zen"])
        self.assertEqual(data["gnome"], {"x": 1})

    def test_multiline_string_keeps_bracket_lines(self) -> None:
        text = self.save('note = """\n[not a table]\n"""\nenabled = ["a"]\n')
        data = tomllib.loads(text)
        self.assertEqual(data["note"], "[not a table]\n")
        self.assertEqual(data["enabled"], ["zen"])

    def test_header_comments_stay_above_enabled_and_saves_are_stable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('[gnome]\nmeter-style = "bar"\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["claude"], show_user=False)
                first = path.read_text()
                agent_quota.save_config(["claude"], show_user=False)
                second = path.read_text()
        self.assertEqual(first, second)
        lines = first.splitlines()
        self.assertEqual(lines[0], "# agent-quota configuration")
        self.assertEqual(lines[2], 'enabled = ["claude"]')
        self.assertEqual(first.count("# agent-quota configuration"), 1)
        self.assertEqual(tomllib.loads(first)["gnome"], {"meter-style": "bar"})

    def test_user_comment_above_enabled_stays_above(self) -> None:
        text = self.save('# keep me\nenabled = ["a"]\n')
        lines = text.splitlines()
        self.assertLess(lines.index("# keep me"), lines.index('enabled = ["zen"]'))

    def test_invalid_toml_is_never_overwritten(self) -> None:
        broken = 'enabled = ["a"\nshow_user = =\n[gnome]\nvalue = 1\n'
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(broken)
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                with self.assertRaises(agent_quota.ConfigError):
                    agent_quota.save_config(["zen"])
            self.assertEqual(path.read_text(), broken)

    def test_gnome_only_file_is_not_configured(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('[gnome]\nmeter-style = "bar"\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                self.assertIsNone(agent_quota.load_config())
                self.assertEqual(agent_quota.load_config_raw(), {"gnome": {"meter-style": "bar"}})

    def test_resolve_keys_falls_back_without_missing_file_message(self) -> None:
        providers = {"claude": object(), "codex": object()}
        args = mock.Mock(only=None)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('[gnome]\nmeter-style = "bar"\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                # Non-interactive: runs everything, no prompt.
                with mock.patch.object(agent_quota.sys.stdin, "isatty", return_value=False):
                    self.assertEqual(agent_quota._resolve_keys(args, providers), ["claude", "codex"])
                # Interactive: the notice must not claim the file is missing.
                printed: list[str] = []
                console = mock.Mock()
                console.print.side_effect = lambda *a, **k: printed.append(str(a[0]))
                with mock.patch.object(agent_quota.sys.stdin, "isatty", return_value=True), \
                        mock.patch.object(agent_quota.sys.stdout, "isatty", return_value=True), \
                        mock.patch.object(agent_quota, "Console", return_value=console), \
                        mock.patch.object(agent_quota.Confirm, "ask", return_value=False):
                    agent_quota._resolve_keys(args, providers)
        self.assertTrue(printed)
        self.assertNotIn("No agent-quota config at", printed[0])

    def test_setup_refuses_invalid_toml(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("enabled = [\n")
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(agent_quota, "Console", return_value=mock.Mock()):
                self.assertEqual(agent_quota.run_setup(), 1)
            self.assertEqual(path.read_text(), "enabled = [\n")


class UnreadableConfigTests(unittest.TestCase):
    """A config.toml that fails to parse is reported, never silently ignored."""

    BROKEN = 'enabled = ["claude"\nshow_user = =\n'
    PROVIDERS = {"claude": object(), "codex": object()}

    def resolve(self, only: str | None, *, interactive: bool) -> tuple[list[str] | None, str, list[str], str]:
        printed: list[str] = []
        console = mock.Mock()
        console.print.side_effect = lambda *a, **k: printed.append(str(a[0]))
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(self.BROKEN)
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(agent_quota.sys, "stderr", stderr), \
                    mock.patch.object(agent_quota.sys.stdin, "isatty", return_value=interactive), \
                    mock.patch.object(agent_quota.sys.stdout, "isatty", return_value=interactive), \
                    mock.patch.object(agent_quota, "Console", return_value=console), \
                    mock.patch.object(agent_quota.Confirm, "ask", return_value=False):
                keys = agent_quota._resolve_keys(mock.Mock(only=only), self.PROVIDERS)
            self.assertEqual(path.read_text(), self.BROKEN)
            return keys, stderr.getvalue(), printed, str(path)

    def check_reported(self, stderr: str, path: str) -> None:
        self.assertIn(path, stderr)
        self.assertIn("not valid TOML", stderr)
        self.assertIn("line", stderr)  # the tomllib error carries a position
        self.assertTrue(stderr.endswith("\n"))

    def test_non_interactive_falls_back_but_says_why_on_stderr(self) -> None:
        keys, stderr, printed, path = self.resolve(None, interactive=False)
        self.assertEqual(keys, ["claude", "codex"])
        self.check_reported(stderr, path)
        self.assertEqual(printed, [])

    def test_interactive_names_the_file_and_the_error(self) -> None:
        keys, stderr, printed, path = self.resolve(None, interactive=True)
        self.assertEqual(keys, ["claude", "codex"])
        self.check_reported(stderr, path)
        self.assertIn("Could not read config", printed[0])
        self.assertIn(path, printed[0])

    def test_only_flag_still_reports_the_unreadable_file(self) -> None:
        keys, stderr, _, path = self.resolve("codex", interactive=False)
        self.assertEqual(keys, ["codex"])
        self.check_reported(stderr, path)

    def test_valid_and_missing_configs_are_silent(self) -> None:
        for initial in (None, 'enabled = ["claude"]\n', '[gnome]\nx = 1\n'):
            stderr = io.StringIO()
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "config.toml"
                if initial is not None:
                    path.write_text(initial)
                with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                        mock.patch.object(agent_quota.sys, "stderr", stderr), \
                        mock.patch.object(agent_quota.sys.stdin, "isatty", return_value=False):
                    agent_quota._resolve_keys(mock.Mock(only=None), self.PROVIDERS)
            self.assertEqual(stderr.getvalue(), "", initial)

    def test_load_helpers_stay_silent_and_return_none(self) -> None:
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(self.BROKEN)
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(agent_quota.sys, "stderr", stderr):
                self.assertIsNone(agent_quota.load_config_raw())
                self.assertIsNone(agent_quota.load_config())
        self.assertEqual(stderr.getvalue(), "")

    def test_non_utf8_file_is_reported_as_unreadable(self) -> None:
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_bytes(b'enabled = ["\xff"]\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(agent_quota.sys, "stderr", stderr), \
                    mock.patch.object(agent_quota.sys.stdin, "isatty", return_value=False):
                keys = agent_quota._resolve_keys(mock.Mock(only=None), self.PROVIDERS)
        self.assertEqual(keys, ["claude", "codex"])
        self.assertIn(str(path), stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
