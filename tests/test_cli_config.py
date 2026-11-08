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


_HOME = tempfile.TemporaryDirectory()
# The lock directory comes from the home directory (XDG_CACHE_HOME is ignored),
# so redirect HOME; XDG_CACHE_HOME points elsewhere to prove it plays no part.
_CACHE_PATCH = mock.patch.dict(
    os.environ,
    {"HOME": _HOME.name, "XDG_CACHE_HOME": os.path.join(_HOME.name, "xdg-cache-ignored")},
)


def setUpModule() -> None:
    # Lock files live under ~/.cache; keep tests out of the real one.
    _CACHE_PATCH.start()


def tearDownModule() -> None:
    _CACHE_PATCH.stop()
    _HOME.cleanup()


class SaveConfigTests(unittest.TestCase):
    def test_writes_enabled_and_show_user(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["claude", "codex"], show_user=False)
            data = tomllib.loads(path.read_text())
            self.assertEqual(data["enabled"], ["claude", "codex"])
            self.assertFalse(data["show_user"])

    def test_enabled_only_keeps_show_user_false(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('# note\nenabled = ["old"]\nshow_user = false  # hide it\n\n[gnome]\npopup-width = 480\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["claude"])
            self.assertEqual(
                path.read_text(),
                '# note\nenabled = ["claude"]\nshow_user = false  # hide it\n\n[gnome]\npopup-width = 480\n',
            )
            self.assertIs(tomllib.loads(path.read_text())["show_user"], False)

    def test_enabled_only_does_not_add_show_user(self) -> None:
        for existing in ("", 'enabled = ["old"]\n', 'enabled = ["old"]\nshow_user = true\n'):
            with self.subTest(existing=existing), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "config.toml"
                if existing:
                    path.write_text(existing)
                with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                    agent_quota.save_config(["claude"])
                data = tomllib.loads(path.read_text())
                self.assertEqual(data["enabled"], ["claude"])
                self.assertEqual("show_user" in data, "show_user" in existing)

    def test_explicit_show_user_still_overrides_the_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["old"]\nshow_user = false\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["claude"], show_user=True)
            self.assertIs(tomllib.loads(path.read_text())["show_user"], True)

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
            self.assertIs(data["show_user"], True)  # rewritten in place, not dropped
            self.assertEqual(data["gnome"], {"refresh-seconds": 60})


class AtomicSaveTests(unittest.TestCase):
    def test_create_uses_0644_and_leaves_no_temp_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sub" / "config.toml"
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["zen"])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["config.toml"])

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
            self.assertEqual(sorted(p.name for p in real.parent.iterdir()), ["config.toml"])
            self.assertEqual(sorted(p.name for p in Path(temporary).iterdir()), ["config.toml", "dotfiles"])

    def test_crash_during_write_keeps_the_old_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["a"]\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(toml_edit.os, "replace", side_effect=OSError("boom")):
                with self.assertRaises(OSError):
                    agent_quota.save_config(["zen"])
            self.assertEqual(path.read_text(), 'enabled = ["a"]\n')
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["config.toml"])

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
            lock = toml_edit.lock_path_for(path)
            self.assertEqual(lock.parent, Path(_HOME.name) / ".cache" / "agent-quota" / "locks")
            self.assertNotEqual(lock.parent, path.parent)


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
        self.assertIs(data["show_user"], True)
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

    def test_show_user_true_and_its_comment_survive_answering_yes(self) -> None:
        text = self.save('enabled = ["a"]\n# note\nshow_user = true\nother = 1\n', show_user=True)
        self.assertEqual(text, 'enabled = ["zen"]\n# note\nshow_user = true\nother = 1\n')

    def test_answering_no_rewrites_show_user_in_place(self) -> None:
        text = self.save('# note\nshow_user = true\nenabled = ["a"]\nother = 1\n', show_user=False)
        self.assertEqual(text, '# note\nshow_user = false\nenabled = ["zen"]\nother = 1\n')

    def test_multiline_show_user_value_is_replaced_whole(self) -> None:
        text = self.save('# note\nshow_user = """\nx\n"""\nenabled = ["a"]\n', show_user=False)
        self.assertEqual(text, '# note\nshow_user = false\nenabled = ["zen"]\n')

    def test_comments_above_enabled_stay_above_it(self) -> None:
        text = self.save('other = 1\n# which providers\n# to poll\nenabled = ["a"]\nz = 2\n', show_user=False)
        self.assertEqual(
            text,
            'other = 1\n# which providers\n# to poll\nenabled = ["zen"]\nshow_user = false\nz = 2\n',
        )

    def test_absent_show_user_stays_absent_when_true(self) -> None:
        text = self.save('# note\nenabled = ["a"]\n', show_user=True)
        self.assertEqual(text, '# note\nenabled = ["zen"]\n')

    def test_show_user_without_enabled_is_not_duplicated(self) -> None:
        text = self.save('# note\nshow_user = false\n', show_user=False)
        self.assertEqual(text.count("show_user"), 1)
        self.assertEqual(tomllib.loads(text), {"enabled": ["zen"], "show_user": False})
        self.assertIn("# note\nshow_user = false", text)

    def test_resaving_is_idempotent(self) -> None:
        first = self.save('# note\nshow_user = true\n# c\nenabled = ["a"]\n', show_user=False)
        self.assertEqual(self.save(first, show_user=False), first)

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


class ShowUserAndSnapshotTests(unittest.TestCase):
    """show_user accepts only booleans; config.toml is parsed once per run."""

    PROVIDERS = {"claude": object(), "codex": object()}

    def with_config(self, text: str | None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        path = Path(temporary.name) / "config.toml"
        if text is not None:
            path.write_text(text)
        return path

    def test_only_real_booleans_are_accepted(self) -> None:
        for text, expected in (
            ("show_user = false\n", False),
            ("show_user = true\n", True),
            ('enabled = ["claude"]\n', True),
        ):
            path = self.with_config(text)
            stderr = io.StringIO()
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(agent_quota.sys, "stderr", stderr):
                self.assertIs(agent_quota._read_config_snapshot().show_user(), expected, text)
            self.assertEqual(stderr.getvalue(), "", text)

    def test_non_boolean_warns_once_and_uses_true(self) -> None:
        for text, shown in (('show_user = "false"\n', '"false"'), ("show_user = 0\n", "0")):
            path = self.with_config(text)
            stderr = io.StringIO()
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(agent_quota.sys, "stderr", stderr):
                snapshot = agent_quota._read_config_snapshot()
                self.assertIs(snapshot.show_user(), True)
                self.assertIs(snapshot.show_user(), True)
            self.assertEqual(
                stderr.getvalue(),
                f"agent-quota: {path}: show_user must be true or false, got {shown}; using true.\n",
            )

    def test_main_warns_once_and_parses_the_file_once(self) -> None:
        path = self.with_config('enabled = ["claude"]\nshow_user = "false"\n')
        stderr, out = io.StringIO(), io.StringIO()
        seen: dict = {}
        real_load = agent_quota.tomllib.load
        with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                mock.patch.object(agent_quota, "_build_providers", lambda: {
                    key: agent_quota._Provider(
                        name=key, mode="usage", fetch=lambda b, key=key: seen.setdefault(key, 1), adapt=lambda raw: [])
                    for key in self.PROVIDERS}), \
                mock.patch.object(agent_quota, "render_tables", side_effect=lambda s, show_user: str(show_user)), \
                mock.patch.object(agent_quota.tomllib, "load", side_effect=real_load) as load, \
                mock.patch.object(agent_quota.sys, "argv", ["agent-quota"]), \
                mock.patch.object(agent_quota.sys, "stderr", stderr), \
                mock.patch.object(agent_quota.Console, "print", side_effect=lambda *a, **k: out.write(str(a[0]))):
            agent_quota.main()
        self.assertEqual(load.call_count, 1)
        self.assertEqual(stderr.getvalue().count("show_user must be true or false"), 1)
        self.assertEqual(list(seen), ["claude"])  # enabled came from the same snapshot
        self.assertEqual(out.getvalue(), "True")

    def test_invalid_toml_is_reported_once_per_run(self) -> None:
        path = self.with_config('enabled = ["claude"\nshow_user = =\n')
        for only in (None, "codex"):
            stderr = io.StringIO()
            real_load = agent_quota.tomllib.load
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(agent_quota.sys, "stderr", stderr), \
                    mock.patch.object(agent_quota.sys.stdin, "isatty", return_value=False), \
                    mock.patch.object(agent_quota.tomllib, "load", side_effect=real_load) as load:
                with agent_quota._config_scope():
                    agent_quota._resolve_keys(mock.Mock(only=only), self.PROVIDERS)
                    agent_quota._current_config().show_user()
            self.assertEqual(stderr.getvalue().count("not valid TOML"), 1, only)
            self.assertEqual(load.call_count, 1, only)

    def test_run_setup_reads_fresh_and_warns_about_show_user(self) -> None:
        path = self.with_config('enabled = ["claude"]\nshow_user = "false"\n')
        stderr = io.StringIO()
        with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                mock.patch.object(agent_quota.sys, "stderr", stderr), \
                mock.patch.object(agent_quota, "Console", return_value=mock.Mock()), \
                mock.patch.object(agent_quota, "_maybe_prompt_for_provider_secret"), \
                mock.patch.object(agent_quota.Confirm, "ask", return_value=True) as ask:
            # A stale snapshot from before the edit must not feed the prompts.
            stale = agent_quota._ConfigSnapshot(path, {"enabled": ["codex"]}, None)
            with agent_quota._config_scope(stale):
                self.assertEqual(agent_quota.run_setup(), 0)
                # save_config refreshed the run's snapshot.
                self.assertEqual(agent_quota.load_config()["enabled"], list(agent_quota.PROVIDER_META))
        self.assertEqual(stderr.getvalue().count("show_user must be true or false"), 1)
        self.assertIs(ask.call_args_list[-1].kwargs["default"], True)
        self.assertEqual(tomllib.loads(path.read_text())["enabled"], list(agent_quota.PROVIDER_META))

    def test_first_run_setup_answer_hides_the_user_column_in_the_same_run(self) -> None:
        # main() scope -> _resolve_keys' nested scope -> setup prompt -> save_config.
        # The nested scope must not put the pre-setup snapshot back on exit.
        path = self.with_config(None)
        rendered: list[bool] = []

        def ask(prompt, *args, **kwargs):
            return "Show user column" not in prompt

        console = mock.Mock()
        with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                mock.patch.object(agent_quota, "_build_providers", lambda: {
                    key: agent_quota._Provider(name=key, mode="usage", fetch=lambda b: None, adapt=lambda raw: [])
                    for key in agent_quota.PROVIDER_META}), \
                mock.patch.object(agent_quota, "fetch_all", return_value=[]), \
                mock.patch.object(agent_quota, "render_tables",
                                  side_effect=lambda s, show_user: rendered.append(show_user)), \
                mock.patch.object(agent_quota, "_maybe_prompt_for_provider_secret"), \
                mock.patch.object(agent_quota, "Console", return_value=console), \
                mock.patch.object(agent_quota.Confirm, "ask", side_effect=ask), \
                mock.patch.object(agent_quota.sys.stdin, "isatty", return_value=True), \
                mock.patch.object(agent_quota.sys.stdout, "isatty", return_value=True), \
                mock.patch.object(agent_quota.sys, "argv", ["agent-quota"]):
            agent_quota.main()
        self.assertIs(tomllib.loads(path.read_text())["show_user"], False)
        self.assertEqual(rendered, [False])
        self.assertIsNone(agent_quota._ACTIVE_CONFIG)

    def test_nested_scope_keeps_a_refresh_and_outer_scope_clears(self) -> None:
        path = self.with_config('enabled = ["claude"]\n')
        with mock.patch.object(agent_quota, "CONFIG_PATH", path):
            with agent_quota._config_scope():
                with agent_quota._config_scope():
                    agent_quota.save_config(["codex"], show_user=False)
                self.assertEqual(agent_quota.load_config()["enabled"], ["codex"])
                self.assertIs(agent_quota._current_config().show_user(), False)
            self.assertIsNone(agent_quota._ACTIVE_CONFIG)

    def test_nested_scope_with_own_snapshot_restores_the_outer_one(self) -> None:
        path = self.with_config('enabled = ["claude"]\n')
        with mock.patch.object(agent_quota, "CONFIG_PATH", path):
            with agent_quota._config_scope() as outer:
                inner = agent_quota._ConfigSnapshot(path, {"enabled": ["x"]}, None)
                with agent_quota._config_scope(inner):
                    self.assertIs(agent_quota._current_config(), inner)
                self.assertIs(agent_quota._current_config(), outer)

    def test_save_config_refreshes_the_active_snapshot(self) -> None:
        path = self.with_config('enabled = ["claude"]\n')
        with mock.patch.object(agent_quota, "CONFIG_PATH", path):
            with agent_quota._config_scope():
                self.assertEqual(agent_quota.load_config()["enabled"], ["claude"])
                agent_quota.save_config(["codex"], show_user=False)
                self.assertEqual(agent_quota.load_config()["enabled"], ["codex"])
                self.assertIs(agent_quota._current_config().show_user(), False)
            self.assertIsNone(agent_quota._ACTIVE_CONFIG)


class SaveSecretValueTests(unittest.TestCase):
    def test_creates_a_private_file_with_the_header(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "sub" / "zai.conf"
            agent_quota._save_secret_value(path, "ZAI_TOKEN", "abc")
            self.assertEqual(path.read_text(), "# agent-quota provider credentials\nZAI_TOKEN=abc\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_other_assignments_and_comments_survive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "copilot.conf"
            path.write_text("# mine\nGITHUB_TOKEN=old\n\n# plan size\nCOPILOT_QUOTA=500\n")
            agent_quota._save_secret_value(path, "GITHUB_TOKEN", "new")
            self.assertEqual(path.read_text(), "# mine\nGITHUB_TOKEN=new\n\n# plan size\nCOPILOT_QUOTA=500\n")
            self.assertEqual(agent_quota._load_secret_value(path, "COPILOT_QUOTA"), "500")

    def test_absent_key_is_appended_and_duplicates_collapse(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "copilot.conf"
            path.write_text("COPILOT_QUOTA=500\n\n\n")
            agent_quota._save_secret_value(path, "GITHUB_TOKEN", "t")
            self.assertEqual(path.read_text(), "COPILOT_QUOTA=500\nGITHUB_TOKEN=t\n")
            path.write_text("GITHUB_TOKEN=a\nCOPILOT_QUOTA=500\n  GITHUB_TOKEN = b\n")
            agent_quota._save_secret_value(path, "GITHUB_TOKEN", "c")
            self.assertEqual(path.read_text(), "COPILOT_QUOTA=500\nGITHUB_TOKEN=c\n")

    def test_mode_is_forced_to_0600_and_crlf_is_kept(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "copilot.conf"
            path.write_bytes(b"GITHUB_TOKEN=old\r\nCOPILOT_QUOTA=500\r\n")
            path.chmod(0o644)
            agent_quota._save_secret_value(path, "GITHUB_TOKEN", "new")
            self.assertEqual(path.read_bytes(), b"GITHUB_TOKEN=new\r\nCOPILOT_QUOTA=500\r\n")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_exotic_separator_in_a_comment_does_not_split_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "zai.conf"
            path.write_text("# note\u2028ZAI_TOKEN=decoy\nZAI_TOKEN=old\n", encoding="utf-8")
            self.assertEqual(agent_quota._load_secret_value(path, "ZAI_TOKEN"), "old")
            agent_quota._save_secret_value(path, "ZAI_TOKEN", "new")
            self.assertEqual(path.read_text(encoding="utf-8"), "# note\u2028ZAI_TOKEN=decoy\nZAI_TOKEN=new\n")

    def test_unreadable_file_is_left_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "copilot.conf"
            path.write_bytes(b"GITHUB_TOKEN=\xff\xfe\nCOPILOT_QUOTA=500\n")
            before = path.read_bytes()
            with self.assertRaises(agent_quota.ConfigError) as caught:
                agent_quota._save_secret_value(path, "GITHUB_TOKEN", "new")
            self.assertIn("leaving it unchanged", str(caught.exception))
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(sorted(p.name for p in path.parent.iterdir()), ["copilot.conf"])

    def test_oserror_on_read_is_left_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "copilot.conf"
            path.mkdir()  # reading a directory raises IsADirectoryError, not FileNotFoundError
            with self.assertRaises(agent_quota.ConfigError):
                agent_quota._save_secret_value(path, "GITHUB_TOKEN", "new")
            self.assertTrue(path.is_dir())

    def test_multiline_value_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "zai.conf"
            with self.assertRaises(agent_quota.ConfigError):
                agent_quota._save_secret_value(path, "ZAI_TOKEN", "a\nb=c")
            self.assertFalse(path.exists())

    def test_symlink_is_written_through_and_leaves_no_lock_beside_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            real_dir = Path(temporary) / "dotfiles"
            real_dir.mkdir()
            real = real_dir / "copilot.conf"
            real.write_text("COPILOT_QUOTA=500\n")
            link_dir = Path(temporary) / "config"
            link_dir.mkdir()
            link = link_dir / "copilot.conf"
            link.symlink_to(real)
            agent_quota._save_secret_value(link, "GITHUB_TOKEN", "t")
            self.assertTrue(link.is_symlink())
            self.assertEqual(real.read_text(), "COPILOT_QUOTA=500\nGITHUB_TOKEN=t\n")
            self.assertEqual(stat.S_IMODE(real.stat().st_mode), 0o600)
            self.assertEqual(sorted(p.name for p in real_dir.iterdir()), ["copilot.conf"])
            self.assertEqual(sorted(p.name for p in link_dir.iterdir()), ["copilot.conf"])

    def test_save_waits_for_the_shared_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "copilot.conf"
            path.write_text("COPILOT_QUOTA=500\n")
            done = threading.Event()

            def work() -> None:
                agent_quota._save_secret_value(path, "GITHUB_TOKEN", "t")
                done.set()

            with toml_edit.file_lock(path):
                thread = threading.Thread(target=work)
                thread.start()
                self.assertFalse(done.wait(0.3))
                self.assertEqual(path.read_text(), "COPILOT_QUOTA=500\n")
            thread.join(5)
            self.assertTrue(done.is_set())
            self.assertEqual(path.read_text(), "COPILOT_QUOTA=500\nGITHUB_TOKEN=t\n")

    def test_setup_prompt_reports_a_refused_save_and_continues(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "copilot.conf"
            path.write_bytes(b"\xff")
            meta = agent_quota.ProviderMeta(
                name="Copilot", desc="", mode="usage",
                secret_key="GITHUB_TOKEN", secret_path=path, secret_label="token",
            )
            output = io.StringIO()
            console = agent_quota.Console(file=output, width=200)
            with mock.patch.object(agent_quota.Confirm, "ask", return_value=True), \
                    mock.patch.object(agent_quota.Prompt, "ask", return_value="tok"):
                agent_quota._maybe_prompt_for_provider_secret(console, meta)
            self.assertIn("leaving it unchanged", output.getvalue())
            self.assertNotIn("saved", output.getvalue())
            self.assertEqual(path.read_bytes(), b"\xff")


class ConfigProblemWordingTests(unittest.TestCase):
    """An unreadable config.toml is not reported as invalid TOML, and vice versa."""

    def check(self, path: Path) -> str:
        with mock.patch.object(agent_quota, "CONFIG_PATH", path):
            with self.assertRaises(agent_quota.ConfigError) as caught:
                agent_quota._check_config_writable()
        return str(caught.exception)

    def test_permission_error_says_unreadable_without_suggesting_removal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["a"]\n')
            with mock.patch("builtins.open", side_effect=PermissionError(13, "Permission denied")):
                message = self.check(path)
        self.assertIn(str(path), message)
        self.assertIn("could not be read", message)
        self.assertIn("Permission denied", message)
        self.assertNotIn("valid TOML", message)
        self.assertNotIn("remove", message)

    def test_invalid_toml_keeps_its_message(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("[gnome\n")
            message = self.check(path)
        self.assertIn("is not valid TOML", message)
        self.assertIn("fix or remove it", message)

    def test_invalid_utf8_is_reported_as_such(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_bytes(b"enabled = \xff\n")
            message = self.check(path)
        self.assertIn("is not valid UTF-8", message)

    def test_save_config_does_not_write_when_unreadable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["a"]\n')
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch("builtins.open", side_effect=PermissionError(13, "Permission denied")):
                with self.assertRaises(agent_quota.ConfigError) as caught:
                    agent_quota.save_config(["zen"])
            self.assertEqual(path.read_text(), 'enabled = ["a"]\n')
            self.assertNotIn("valid TOML", str(caught.exception))

    def test_setup_reports_an_unwritable_config_without_a_traceback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            output = io.StringIO()
            console = agent_quota.Console(file=output, width=300)
            with mock.patch.object(agent_quota, "CONFIG_PATH", path), \
                    mock.patch.object(agent_quota, "Console", return_value=console), \
                    mock.patch.object(agent_quota.Confirm, "ask", return_value=True), \
                    mock.patch.object(agent_quota.Prompt, "ask", return_value=""), \
                    mock.patch.object(agent_quota, "save_config", side_effect=PermissionError(30, "Read-only file system")):
                self.assertEqual(agent_quota.run_setup(), 1)
        self.assertIn("could not be written", output.getvalue())
        self.assertIn("Read-only file system", output.getvalue())
        self.assertNotIn("valid TOML", output.getvalue())


class SaveConfigCommentTests(unittest.TestCase):
    """Comments around the managed `enabled` key and above the first table survive."""

    def save(self, initial: str, enabled=("claude",), show_user=None) -> str:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(initial)
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(list(enabled), show_user=show_user)
            return path.read_text()

    def test_multiline_enabled_with_comments_is_untouched_when_values_are_unchanged(self) -> None:
        initial = "enabled = [\n  'claude',  # keep\n  \"codex\",\n  # the other one\n]\n[gnome]\npopup-width = 480\n"
        text = self.save(initial, enabled=("claude", "codex"))
        self.assertIn("  'claude',  # keep\n", text)
        self.assertIn("  # the other one\n]", text)
        self.assertEqual(tomllib.loads(text)["enabled"], ["claude", "codex"])
        self.assertEqual(text.split("[gnome]")[1], "\npopup-width = 480\n")

    def test_multiline_enabled_comments_move_above_the_rewritten_line(self) -> None:
        initial = "# note\nenabled = [\n  'claude', # keep\n  # about codex\n  'codex',\n]  # trailing\n"
        text = self.save(initial, enabled=("claude", "zen"))
        self.assertEqual(
            text,
            "# note\n# keep\n# about codex\n# trailing\n"
            'enabled = ["claude", "zen"]\n',
        )

    def test_hash_inside_a_string_is_not_a_comment(self) -> None:
        text = self.save("enabled = [\n  'a#b',\n]\n", enabled=("zen",))
        self.assertEqual(text, 'enabled = ["zen"]\n')

    def test_trailing_comment_on_a_single_line_enabled_is_kept(self) -> None:
        text = self.save('enabled = ["claude"]  # mine\n', enabled=("claude",))
        self.assertEqual(text, 'enabled = ["claude"]  # mine\n')
        text = self.save('enabled = ["claude"]  # mine\n', enabled=("zen",))
        self.assertEqual(text, '# mine\nenabled = ["zen"]\n')

    def test_comment_heading_the_first_table_stays_attached_when_enabled_is_inserted(self) -> None:
        text = self.save("# my comment\n[gnome]\npopup-width = 480\n")
        self.assertEqual(
            text,
            "# agent-quota configuration\n"
            "# Edit this file or run `agent-quota setup` to change.\n"
            'enabled = ["claude"]\n'
            "\n# my comment\n[gnome]\npopup-width = 480\n",
        )

    def test_comment_block_heading_the_first_table_stays_attached_after_existing_enabled(self) -> None:
        text = self.save('enabled = ["claude"]\n# about gnome\n# more\n[gnome]\npopup-width = 480\n')
        self.assertEqual(
            text, 'enabled = ["claude"]\n\n# about gnome\n# more\n[gnome]\npopup-width = 480\n')
        # A second pass is stable.
        self.assertEqual(self.save(text), text)

    def test_blank_line_before_the_table_comment_is_not_doubled(self) -> None:
        initial = 'enabled = ["claude"]\n\n# about gnome\n[gnome]\npopup-width = 480\n'
        self.assertEqual(self.save(initial), initial)

    def test_header_comments_already_present_are_not_duplicated_before_a_table(self) -> None:
        initial = (
            "# agent-quota configuration\n"
            "# Edit this file or run `agent-quota setup` to change.\n"
            "[gnome]\npopup-width = 480\n"
        )
        text = self.save(initial)
        self.assertEqual(text.count("# agent-quota configuration"), 1)
        self.assertEqual(tomllib.loads(text)["enabled"], ["claude"])


if __name__ == "__main__":
    unittest.main()
