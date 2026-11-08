"""toml_edit.py: the lexical scanner, atomic writes and the file lock.

The first half exercises the helpers directly.  The second half drives them
through the two real callers (agent_quota.save_config for the CLI-owned root
keys, settings_server.write_gnome_section for the [gnome] table) with the
awkward inputs a hand-edited config.toml can contain.
"""

from __future__ import annotations

import importlib.util
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


REPO = Path(__file__).resolve().parent.parent
SERVER_PATH = REPO / "gnome-shell-extension" / "settings_server.py"

spec = importlib.util.spec_from_file_location("agent_quota_settings_server_toml_edit", SERVER_PATH)
server = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(server)

# A table-header-looking line lives inside a multi-line basic string whose
# previous line has a backslash-escaped quote right before two more quotes.
ESCAPED_QUOTES_IN_STRING = (
    'enabled = ["a"]\n'
    'note = """\n'
    'he said \\""" still inside\n'
    "[fake]\n"
    '"""\n'
    "\n"
    "[gnome]\n"
    "x = 1\n"
)


class ScanLineTests(unittest.TestCase):
    def test_plain_line(self) -> None:
        self.assertEqual(toml_edit.scan_line("a = 1", None, 0), (None, 0))

    def test_array_depth_across_lines(self) -> None:
        delim, depth = toml_edit.scan_line("a = [", None, 0)
        self.assertEqual((delim, depth), (None, 1))
        delim, depth = toml_edit.scan_line("  [1, 2],", delim, depth)
        self.assertEqual((delim, depth), (None, 1))
        self.assertEqual(toml_edit.scan_line("]", delim, depth), (None, 0))

    def test_stray_closing_bracket_cannot_go_negative(self) -> None:
        self.assertEqual(toml_edit.scan_line("]]", None, 0), (None, 0))
        self.assertEqual(toml_edit.scan_line("a = 1 ]", None, 0), (None, 0))

    def test_brackets_in_strings_and_comments_are_ignored(self) -> None:
        for line in ('a = "["', "a = '['", "a = 1 # [", 'a = "x\\"["'):
            self.assertEqual(toml_edit.scan_line(line, None, 0), (None, 0), line)

    def test_single_line_basic_string_escapes(self) -> None:
        # The escaped quote does not end the string, so the `[` is still inside.
        self.assertEqual(toml_edit.scan_line('a = "q\\"[" ', None, 0), (None, 0))
        # An escaped backslash does end it, so the `[` after it is real.
        self.assertEqual(toml_edit.scan_line('a = "q\\\\" [', None, 0), (None, 1))

    def test_multiline_string_open_and_close(self) -> None:
        delim, depth = toml_edit.scan_line('a = """start', None, 0)
        self.assertEqual((delim, depth), ('"""', 0))
        self.assertEqual(toml_edit.scan_line("[still] inside", delim, depth), ('"""', 0))
        self.assertEqual(toml_edit.scan_line('end""" # done', delim, depth), (None, 0))

    def test_multiline_string_closing_and_reopening_on_one_line(self) -> None:
        self.assertEqual(toml_edit.scan_line('"""a""" b = ["""c', None, 0)[0], '"""')

    def test_escaped_quote_before_triple_is_not_a_terminator(self) -> None:
        # backslash, quote, quote, quote: an escaped quote plus two plain quotes.
        line = 'he said \\""" still inside'
        self.assertEqual(toml_edit.scan_line(line, '"""', 0), ('"""', 0))
        self.assertEqual(toml_edit.scan_line(line + '"""', '"""', 0), (None, 0))

    def test_escaped_backslash_before_triple_is_a_terminator(self) -> None:
        self.assertEqual(toml_edit.scan_line('x \\\\"""', '"""', 0), (None, 0))

    def test_extra_quotes_before_terminator_are_content(self) -> None:
        # `""""` ends a multi-line string whose last character is a quote.
        self.assertEqual(toml_edit.scan_line('x""""', '"""', 0), (None, 0))
        self.assertEqual(toml_edit.scan_line('x"""" ]', '"""', 0), (None, 0))
        self.assertEqual(toml_edit.scan_line('x"""""', '"""', 0), (None, 0))

    def test_literal_multiline_string_has_no_escapes(self) -> None:
        self.assertEqual(toml_edit.scan_line("a = '''x\\", None, 0), ("'''", 0))
        # The backslash does not protect the quotes: this closes the string.
        self.assertEqual(toml_edit.scan_line("x\\'''", "'''", 0), (None, 0))
        # A basic delimiter inside a literal string is plain text.
        self.assertEqual(toml_edit.scan_line('x """ y', "'''", 0), ("'''", 0))

    def test_basic_delimiter_does_not_close_literal_and_vice_versa(self) -> None:
        self.assertEqual(toml_edit.scan_line("x ''' y", '"""', 0), ('"""', 0))


class LogicalEntriesTests(unittest.TestCase):
    def test_simple_lines_are_one_entry_each(self) -> None:
        self.assertEqual(toml_edit.logical_entries(["a = 1", "", "[t]", "b = 2"]), [(0, 1), (1, 2), (2, 3), (3, 4)])

    def test_multiline_array_is_one_entry(self) -> None:
        lines = ["a = [", "  [1],", "]", "b = 1"]
        self.assertEqual(toml_edit.logical_entries(lines), [(0, 3), (3, 4)])

    def test_header_lookalike_inside_a_string_is_not_an_entry(self) -> None:
        lines = ESCAPED_QUOTES_IN_STRING.splitlines()
        entries = toml_edit.logical_entries(lines)
        starts = [lines[first] for first, _ in entries]
        self.assertNotIn("[fake]", starts)
        self.assertEqual(starts, ['enabled = ["a"]', 'note = """', "", "[gnome]", "x = 1"])

    def test_unterminated_value_runs_to_the_end(self) -> None:
        self.assertEqual(toml_edit.logical_entries(["a = [", "1,"]), [(0, 2)])


class AtomicWriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def names(self, directory: Path | None = None) -> list[str]:
        return sorted(p.name for p in (directory or self.dir).iterdir())

    def test_creates_with_the_given_mode(self) -> None:
        path = self.dir / "c.toml"
        toml_edit.atomic_write_text(path, "a = 1\n", 0o640)
        self.assertEqual(path.read_text(), "a = 1\n")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
        self.assertEqual(self.names(), ["c.toml"])

    def test_existing_mode_is_ignored_unless_preserved(self) -> None:
        path = self.dir / "c.toml"
        path.write_text("old\n")
        path.chmod(0o600)
        toml_edit.atomic_write_text(path, "new\n", 0o644)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)

    def test_preserve_mode_keeps_existing_and_uses_default_on_create(self) -> None:
        path = self.dir / "c.toml"
        toml_edit.atomic_write_text(path, "a\n", 0o644, preserve_mode=True)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
        path.chmod(0o600)
        toml_edit.atomic_write_text(path, "b\n", 0o644, preserve_mode=True)
        self.assertEqual(path.read_text(), "b\n")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_symlink_survives_and_real_file_is_replaced(self) -> None:
        real = self.dir / "dotfiles" / "config.toml"
        real.parent.mkdir()
        real.write_text("old\n")
        real.chmod(0o600)
        link = self.dir / "config.toml"
        link.symlink_to(real)
        toml_edit.atomic_write_text(link, "new\n", 0o644, preserve_mode=True)
        self.assertTrue(link.is_symlink())
        self.assertEqual(Path(os.path.realpath(link)), real.resolve())
        self.assertEqual(real.read_text(), "new\n")
        self.assertEqual(stat.S_IMODE(real.stat().st_mode), 0o600)
        self.assertEqual(self.names(real.parent), ["config.toml"])
        self.assertEqual(self.names(), ["config.toml", "dotfiles"])

    def test_non_ascii_text_is_written_as_utf8(self) -> None:
        path = self.dir / "c.toml"
        toml_edit.atomic_write_text(path, 'a = "😀 中文"\n', 0o644)
        self.assertEqual(path.read_bytes().decode("utf-8"), 'a = "😀 中文"\n')

    def test_failure_leaves_old_file_and_no_temp_files(self) -> None:
        path = self.dir / "c.toml"
        path.write_text("old\n")
        with mock.patch.object(toml_edit.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                toml_edit.atomic_write_text(path, "new\n", 0o644)
        self.assertEqual(path.read_text(), "old\n")
        self.assertEqual(self.names(), ["c.toml"])

    def test_concurrent_writers_never_share_a_temp_file(self) -> None:
        path = self.dir / "c.toml"
        errors: list[BaseException] = []
        payloads = [f"writer = {index}\n" + "x = 1\n" * 200 for index in range(8)]

        def work(index: int) -> None:
            try:
                for _ in range(25):
                    toml_edit.atomic_write_text(path, payloads[index], 0o644)
            except BaseException as error:  # pragma: no cover - failure path
                errors.append(error)

        threads = [threading.Thread(target=work, args=(index,)) for index in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        # Always one writer's complete payload, never a mix or a truncation.
        self.assertIn(path.read_text(), payloads)
        self.assertEqual(self.names(), ["c.toml"])


class FileLockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def lock_dir(self) -> Path:
        return Path(_HOME.name) / ".cache" / "agent-quota" / "locks"

    def test_aliased_paths_share_one_lock_under_the_cache_dir(self) -> None:
        real = self.dir / "dotfiles" / "config.toml"
        real.parent.mkdir()
        real.write_text("")
        link = self.dir / "config.toml"
        link.symlink_to(real)
        self.assertEqual(toml_edit.lock_path_for(link), toml_edit.lock_path_for(real))
        self.assertEqual(toml_edit.lock_path_for(link).parent, self.lock_dir())
        other = real.parent / "zai.conf"
        self.assertNotEqual(toml_edit.lock_path_for(other), toml_edit.lock_path_for(real))

    def test_lock_dir_ignores_xdg_cache_home(self) -> None:
        expected = Path(_HOME.name) / ".cache" / "agent-quota" / "locks"
        for xdg in (None, "", "relative/cache", os.path.join(self.tmp.name, "elsewhere")):
            with self.subTest(xdg=xdg):
                env = {k: v for k, v in os.environ.items() if k != "XDG_CACHE_HOME"}
                if xdg is not None:
                    env["XDG_CACHE_HOME"] = xdg
                with mock.patch.dict(os.environ, env, clear=True):
                    self.assertEqual(toml_edit.lock_dir(), expected)
                    self.assertEqual(toml_edit.lock_path_for(self.dir / "config.toml").parent, expected)

    def test_processes_with_different_environments_share_one_lock(self) -> None:
        path = self.dir / "config.toml"
        with mock.patch.dict(os.environ, {"XDG_CACHE_HOME": os.path.join(self.tmp.name, "a")}):
            first = toml_edit.lock_path_for(path)
        with mock.patch.dict(os.environ, {"XDG_CACHE_HOME": os.path.join(self.tmp.name, "b")}):
            second = toml_edit.lock_path_for(path)
        self.assertEqual(first, second)

    def test_aliased_paths_exclude_each_other(self) -> None:
        real = self.dir / "dotfiles" / "config.toml"
        real.parent.mkdir()
        real.write_text("")
        link = self.dir / "config.toml"
        link.symlink_to(real)
        done = threading.Event()

        def work() -> None:
            with toml_edit.file_lock(link):
                done.set()

        with toml_edit.file_lock(real):
            thread = threading.Thread(target=work)
            thread.start()
            self.assertFalse(done.wait(0.3))
        self.assertTrue(done.wait(5))
        thread.join()

    def test_lock_leaves_nothing_in_the_locked_files_directory(self) -> None:
        path = self.dir / "config.toml"
        path.write_text("")
        with toml_edit.file_lock(path):
            self.assertTrue(toml_edit.lock_path_for(path).exists())
        self.assertEqual(sorted(item.name for item in self.dir.iterdir()), ["config.toml"])
        self.assertEqual(stat.S_IMODE(self.lock_dir().stat().st_mode), 0o700)

    def test_does_not_create_the_locked_files_directory(self) -> None:
        path = self.dir / "new" / "dir" / "config.toml"
        with toml_edit.file_lock(path):
            pass
        self.assertFalse(path.parent.exists())

    def test_falls_back_to_a_sidecar_when_the_cache_dir_cannot_be_made(self) -> None:
        path = self.dir / "config.toml"
        blocker = self.dir / "cache-is-a-file"
        blocker.write_text("")
        with mock.patch.object(toml_edit, "lock_dir", return_value=blocker / "locks"):
            lock = toml_edit.lock_path_for(path)
            self.assertEqual(lock, Path(os.path.realpath(path)).with_name("config.toml.lock"))
            with toml_edit.file_lock(path):
                self.assertTrue(lock.exists())

    def test_falls_back_to_a_sidecar_when_the_cache_dir_is_not_writable(self) -> None:
        path = self.dir / "config.toml"
        real_open = os.open

        def refuse_cache(name, *args, **kwargs):
            if Path(name).parent == self.lock_dir():
                raise PermissionError(13, "Permission denied")
            return real_open(name, *args, **kwargs)

        with mock.patch.object(toml_edit.os, "open", side_effect=refuse_cache):
            with toml_edit.file_lock(path):
                self.assertTrue((self.dir / "config.toml.lock").exists())

    def test_lock_is_released_after_an_exception(self) -> None:
        path = self.dir / "config.toml"
        with self.assertRaises(RuntimeError):
            with toml_edit.file_lock(path):
                raise RuntimeError("boom")
        acquired = threading.Event()

        def work() -> None:
            with toml_edit.file_lock(path):
                acquired.set()

        thread = threading.Thread(target=work)
        thread.start()
        self.assertTrue(acquired.wait(5))
        thread.join()

    def test_second_holder_waits_for_the_first(self) -> None:
        path = self.dir / "config.toml"
        done = threading.Event()

        def work() -> None:
            with toml_edit.file_lock(path):
                done.set()

        with toml_edit.file_lock(path):
            thread = threading.Thread(target=work)
            thread.start()
            self.assertFalse(done.wait(0.3))
        self.assertTrue(done.wait(5))
        thread.join()

    def test_read_modify_write_does_not_lose_updates(self) -> None:
        path = self.dir / "counter.txt"
        path.write_text("0")
        errors: list[BaseException] = []

        def work() -> None:
            try:
                for _ in range(25):
                    with toml_edit.file_lock(path):
                        value = int(path.read_text())
                        toml_edit.atomic_write_text(path, str(value + 1), 0o644)
            except BaseException as error:  # pragma: no cover - failure path
                errors.append(error)

        threads = [threading.Thread(target=work) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(path.read_text(), str(6 * 25))


class SplitLinesTests(unittest.TestCase):
    EXOTIC = ("\u0085", "\u2028", "\u2029", "\x0b", "\x0c")

    def test_splits_on_lf_only_and_reports_the_style(self) -> None:
        self.assertEqual(toml_edit.split_lines(""), ([], "\n"))
        self.assertEqual(toml_edit.split_lines("a\nb\n"), (["a", "b"], "\n"))
        self.assertEqual(toml_edit.split_lines("a\nb"), (["a", "b"], "\n"))
        self.assertEqual(toml_edit.split_lines("a\n\nb\n"), (["a", "", "b"], "\n"))
        self.assertEqual(toml_edit.split_lines("a\r\nb\r\n"), (["a", "b"], "\r\n"))
        for char in self.EXOTIC:
            self.assertEqual(toml_edit.split_lines(f"a{char}b\n"), ([f"a{char}b"], "\n"), repr(char))

    def test_join_is_the_inverse(self) -> None:
        for text in ("a\nb\n", "a\r\nb\r\n", "a\n\nb\n", ""):
            lines, newline = toml_edit.split_lines(text)
            self.assertEqual(toml_edit.join_lines(lines, newline), text)
        # An unterminated last line gains its line break.
        self.assertEqual(toml_edit.join_lines(*toml_edit.split_lines("a\nb")), "a\nb\n")

    def test_save_config_keeps_exotic_line_separators_inside_comments_and_strings(self) -> None:
        for char in SplitLinesTests.EXOTIC[:3]:  # \v and \f are not valid TOML text
            with self.subTest(char=repr(char)), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / "config.toml"
                path.write_bytes(
                    (
                        f'# note{char}enabled = ["tail"]\n'
                        f'enabled = ["old"]\n'
                        f'label = "a{char}b"  # trailing{char}comment\n'
                        f"\n[gnome]\nx = 1\n"
                    ).encode("utf-8")
                )
                with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                    agent_quota.save_config(["zen"], show_user=True)
                text = path.read_bytes().decode("utf-8")
                data = tomllib.loads(text)
                self.assertEqual(data["enabled"], ["zen"])
                self.assertEqual(data["label"], f"a{char}b")
                self.assertEqual(data["gnome"], {"x": 1})
                self.assertIn(f'# note{char}enabled = ["tail"]\n', text)
                self.assertIn(f'label = "a{char}b"  # trailing{char}comment\n', text)

    def test_setup_succeeds_for_a_file_with_exotic_separators(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('# a\u2028b = 1\nenabled = ["x"]\n', encoding="utf-8")
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["claude"])
                agent_quota.save_config(["codex"])  # a second pass must not fail either
            self.assertEqual(tomllib.loads(path.read_text(encoding="utf-8"))["enabled"], ["codex"])

    def test_crlf_config_round_trips_as_crlf(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_bytes(
                b'# keep me\r\nenabled = ["old"]\r\nshow_user = true\r\n\r\n[gnome]\r\nx = 1\r\n'
            )
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(["zen"], show_user=False)
            raw = path.read_bytes()
            self.assertEqual(raw.count(b"\n"), raw.count(b"\r\n"))  # no bare LF
            self.assertEqual(
                raw,
                b'# keep me\r\nenabled = ["zen"]\r\nshow_user = false\r\n\r\n[gnome]\r\nx = 1\r\n',
            )


class SaveConfigThroughScannerTests(unittest.TestCase):
    """agent_quota.save_config on hand-written files."""

    def save(self, initial: str, enabled=("zen",), show_user=True) -> str:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(initial, encoding="utf-8")
            with mock.patch.object(agent_quota, "CONFIG_PATH", path):
                agent_quota.save_config(list(enabled), show_user=show_user)
            return path.read_text(encoding="utf-8")

    def test_quoted_key_is_replaced_not_duplicated(self) -> None:
        text = self.save('"enabled" = ["a"]\n"show_user" = false\n')
        data = tomllib.loads(text)
        self.assertEqual(data["enabled"], ["zen"])
        self.assertIs(data["show_user"], True)  # rewritten in place
        self.assertEqual(text.count("show_user"), 1)
        self.assertEqual(text.count("enabled"), 1)

    def test_single_quoted_key_is_replaced_not_duplicated(self) -> None:
        text = self.save("'enabled' = [\n  \"a\",\n]\n")
        self.assertEqual(tomllib.loads(text)["enabled"], ["zen"])
        self.assertEqual(text.count("enabled"), 1)

    def test_comments_unmanaged_keys_and_tables_are_kept(self) -> None:
        text = self.save(
            "# top\n"
            'enabled = ["a"]\n'
            "custom_root = 3  # why\n"
            "\n"
            "# about other\n"
            "[other]\n"
            'kept = "x"  # inline\n'
        )
        data = tomllib.loads(text)
        self.assertEqual(data, {"enabled": ["zen"], "custom_root": 3, "other": {"kept": "x"}})
        for kept in ("# top", "custom_root = 3  # why", "# about other", 'kept = "x"  # inline'):
            self.assertIn(kept, text)

    def test_table_header_with_trailing_comment_ends_the_root_region(self) -> None:
        text = self.save('enabled = ["a"]\n\n[gnome] # mirrored settings\nx = 1\n')
        self.assertEqual(tomllib.loads(text), {"enabled": ["zen"], "gnome": {"x": 1}})
        self.assertIn("[gnome] # mirrored settings", text)

    def test_array_of_tables_is_preserved_verbatim(self) -> None:
        tables = '[[x]]\nname = "one"\n\n[[x]]\nname = "two"  # keep\n'
        text = self.save(f'enabled = ["a"]\n\n{tables}')
        self.assertEqual(tomllib.loads(text)["x"], [{"name": "one"}, {"name": "two"}])
        self.assertTrue(text.endswith(tables))

    def test_array_of_tables_without_a_root_key_is_preserved(self) -> None:
        tables = '[[x]]\nname = "one"\n'
        text = self.save(tables)
        data = tomllib.loads(text)
        self.assertEqual(data["enabled"], ["zen"])
        self.assertEqual(data["x"], [{"name": "one"}])
        self.assertTrue(text.endswith(tables))

    def test_escaped_quotes_before_a_fake_header_inside_a_string(self) -> None:
        text = self.save(ESCAPED_QUOTES_IN_STRING)
        data = tomllib.loads(text)
        self.assertEqual(data["enabled"], ["zen"])
        self.assertEqual(data["note"], 'he said """ still inside\n[fake]\n')
        self.assertEqual(data["gnome"], {"x": 1})
        self.assertNotIn("fake", data)

    def test_non_ascii_comments_survive(self) -> None:
        text = self.save('# 設定 😀\nenabled = ["a"]\n')
        self.assertIn("# 設定 😀", text)
        self.assertEqual(tomllib.loads(text)["enabled"], ["zen"])


class WriteGnomeSectionThroughScannerTests(unittest.TestCase):
    """settings_server.write_gnome_section on hand-written files."""

    def write(self, initial: str, values: dict[str, object]) -> str:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text(initial, encoding="utf-8")
            server.write_gnome_section(path, values)
            return path.read_text(encoding="utf-8")

    def test_emoji_and_cjk_values_round_trip_as_utf8(self) -> None:
        values = {"label": "Team 😀 中文", "options": ["🚀 one", 'two "2"']}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text('enabled = ["a"]\n')
            server.write_gnome_section(path, values)
            server.write_gnome_section(path, {"other": 1})
            raw = path.read_bytes().decode("utf-8")
            self.assertIn("😀", raw)
            self.assertNotIn("\\ud83d", raw.lower())
            self.assertEqual(
                tomllib.loads(raw)["gnome"],
                {"label": "Team 😀 中文", "options": ["🚀 one", 'two "2"'], "other": 1},
            )

    def test_quoted_gnome_header_is_edited_in_place(self) -> None:
        text = self.write('["gnome"]\nmeter-style = "circle"\nkeep = 1\n', {"meter-style": "bar"})
        self.assertEqual(tomllib.loads(text), {"gnome": {"meter-style": "bar", "keep": 1}})
        self.assertEqual(text.count("gnome"), 1)

    def test_spaced_gnome_header_is_edited_in_place(self) -> None:
        text = self.write("[ gnome ] # mine\nmeter-style = 1\n", {"meter-style": 2})
        self.assertEqual(tomllib.loads(text), {"gnome": {"meter-style": 2}})
        self.assertEqual(text.count("gnome"), 1)

    def test_array_of_tables_before_and_after_are_untouched(self) -> None:
        before = '[[servers]]\nname = "a"  # keep\n\n'
        after = '\n[[servers]]\nname = "b"\n\n[[servers]]\nname = "c"\n'
        text = self.write(f'{before}[gnome]\nx = 1\n{after}', {"x": 2, "y": 3})
        data = tomllib.loads(text)
        self.assertEqual(data["gnome"], {"x": 2, "y": 3})
        self.assertEqual(data["servers"], [{"name": "a"}, {"name": "b"}, {"name": "c"}])
        self.assertTrue(text.startswith(before))
        self.assertTrue(text.endswith(after))

    def test_hand_comments_and_unknown_keys_inside_gnome_are_kept(self) -> None:
        text = self.write(
            "[gnome]\n"
            "# hand written note\n"
            'meter-style = "circle"  # trailing\n'
            "future-setting = [1, 2]\n"
            "\n"
            "# about other\n"
            "[other]\n"
            "b = 1\n",
            {"meter-style": "bar"},
        )
        data = tomllib.loads(text)
        self.assertEqual(data["gnome"], {"meter-style": "bar", "future-setting": [1, 2]})
        self.assertEqual(data["other"], {"b": 1})
        self.assertIn("# hand written note", text)
        self.assertIn("# about other", text)

    def test_escaped_quotes_before_a_fake_header_inside_a_string(self) -> None:
        text = self.write(ESCAPED_QUOTES_IN_STRING, {"y": 2})
        data = tomllib.loads(text)
        self.assertEqual(data["note"], 'he said """ still inside\n[fake]\n')
        self.assertEqual(data["enabled"], ["a"])
        self.assertEqual(data["gnome"], {"x": 1, "y": 2})
        self.assertNotIn("fake", data)

    def test_fake_gnome_header_inside_a_string_is_not_the_table(self) -> None:
        initial = 'note = """\nhe said \\""" and\n[gnome]\nx = 0\n"""\n'
        text = self.write(initial, {"y": 2})
        data = tomllib.loads(text)
        self.assertEqual(data["note"], 'he said """ and\n[gnome]\nx = 0\n')
        self.assertEqual(data["gnome"], {"y": 2})

    def test_file_permissions_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "config.toml"
            path.write_text("[gnome]\nx = 1\n")
            path.chmod(0o640)
            server.write_gnome_section(path, {"x": 2})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)


if __name__ == "__main__":
    unittest.main()
