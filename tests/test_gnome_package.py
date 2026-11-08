"""Static checks on the installed GNOME extension bundle.

`gnome-extensions pack` only adds the standard extension assets; every other
file must be listed explicitly in install-gnome-extension.sh. These tests
follow the relative JavaScript imports from the packaged entry points and
assert each one is shipped, so a newly extracted helper cannot silently break
the installed extension while repository-level tests still pass.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXTENSION_DIR = REPO / "gnome-shell-extension"
INSTALLER = REPO / "install-gnome-extension.sh"

# Files `gnome-extensions pack` includes without --extra-source.
PACK_DEFAULTS = {"extension.js", "prefs.js", "metadata.json", "stylesheet.css"}
ENTRY_POINTS = ("extension.js", "prefs.js")
RELATIVE_IMPORT = re.compile(r"""^\s*import\s[^;]*?from\s+['"](\./[^'"]+)['"]""", re.M)


def _zip_additions() -> set[str]:
    """Return the paths the installer adds to the archive after packing."""
    script = INSTALLER.read_text()
    match = re.search(r"zip -q -ur (.*?)\n\)", script, re.S)
    assert match, "installer no longer adds files with `zip -q -ur`"
    tokens = shlex.split(match.group(1).replace("\\\n", " "))
    # The first token is the archive path itself.
    return set(tokens[1:])


def _relative_imports(name: str) -> set[str]:
    source = (EXTENSION_DIR / name).read_text()
    return {path.removeprefix("./") for path in RELATIVE_IMPORT.findall(source)}


class GnomePackageTests(unittest.TestCase):
    def test_every_relative_import_is_packaged(self) -> None:
        packaged = PACK_DEFAULTS | _zip_additions()
        pending = list(ENTRY_POINTS)
        seen: set[str] = set()
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            seen.add(name)
            self.assertIn(name, packaged, f"{name} is imported but not packaged")
            self.assertTrue((EXTENSION_DIR / name).is_file(), f"{name} does not exist")
            pending.extend(_relative_imports(name))
        # Sanity: the walk actually reached the extracted helpers.
        self.assertTrue({"reset-display.js", "layout-model.js", "meter-layout.js"} <= seen)

    def test_web_settings_and_server_are_packaged(self) -> None:
        packaged = PACK_DEFAULTS | _zip_additions()
        self.assertIn("settings_server.py", packaged)
        self.assertIn("web-settings", packaged)
        for name in ("index.html", "settings.js", "layout-editor.js", "settings.css", "providers.json", "gauge.svg"):
            self.assertTrue((EXTENSION_DIR / "web-settings" / name).is_file(), f"{name} is missing")
        # The server imports the shared TOML helper; it must ship next to it.
        self.assertIn("toml_edit.py", packaged)
        self.assertRegex(INSTALLER.read_text(), r'cp [^\n]*"\$\{repo_dir\}/toml_edit\.py"')
        self.assertIn("toml_edit", (EXTENSION_DIR / "settings_server.py").read_text())
        self.assertTrue((REPO / "toml_edit.py").is_file())
        self.assertIn('"toml_edit.py"', (REPO / "pyproject.toml").read_text())
        # The launcher points at the packaged server and web directory.
        prefs = (EXTENSION_DIR / "prefs.js").read_text()
        self.assertIn("settings_server.py", prefs)
        self.assertIn("web-settings", prefs)


class GnomeMetricLabelTests(unittest.TestCase):
    def test_extension_does_not_rewrite_backend_window_labels(self) -> None:
        # Window labels are payload-driven (e.g. "7d Sonnet" vs "7d Fable");
        # the extension must render metric.label verbatim.
        source = (EXTENSION_DIR / "extension.js").read_text()
        self.assertNotRegex(source, r"['\"`]7d [A-Z]")
        # The text cell shows metric.label on its own line, then the value.
        self.assertIn("addLine(metric.label,", source)
        self.assertIn("addLine(displayMetricValue(metric),", source)


class GnomeSubprocessResilienceTests(unittest.TestCase):
    def test_initial_menu_is_seeded_before_first_refresh(self) -> None:
        source = (EXTENSION_DIR / "extension.js").read_text()
        self.assertIn("Loading quotas…", source)
        self.assertLess(
            source.index("Loading quotas…"),
            source.rindex("this._scheduleRefresh();"),
        )

    def test_subprocess_has_timeout_and_force_exit(self) -> None:
        source = (EXTENSION_DIR / "extension.js").read_text()
        self.assertIn("SUBPROCESS_TIMEOUT_SECONDS", source)
        self.assertIn("process.force_exit()", source)
        self.assertIn("Timed out after ${SUBPROCESS_TIMEOUT_SECONDS}s", source)

    def test_per_provider_refresh_uses_all_settled_and_covers_provider_names(self) -> None:
        source = (EXTENSION_DIR / "extension.js").read_text()
        self.assertIn("Promise.allSettled(", source)
        self.assertNotIn("Promise.all(", source)
        keys_match = re.search(r"const PROVIDER_KEYS = \[([^\]]+)\]", source)
        names_match = re.search(r"const PROVIDER_NAMES = \{([\s\S]*?)\};", source)
        self.assertIsNotNone(keys_match)
        self.assertIsNotNone(names_match)
        assert keys_match is not None and names_match is not None
        keys = [k.strip().strip("'") for k in keys_match.group(1).split(",")]
        for key in keys:
            self.assertRegex(names_match.group(1), rf"\b{re.escape(key)}\s*:")


class InstallerStopsSettingsServerTests(unittest.TestCase):
    """stop_settings_server must find the info file under either cache location."""

    @staticmethod
    def _stop_function() -> str:
        script = INSTALLER.read_text()
        match = re.search(r"^stop_settings_server_at\(\) \{.*?^stop_settings_server \|\| true$", script, re.S | re.M)
        assert match, "installer no longer defines stop_settings_server"
        return match.group(0)

    def _spawn_fake_server(self) -> subprocess.Popen:
        # settings_server.py in argv is what the installer's cmdline check looks for.
        process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)", "settings_server.py"],
        )
        self.addCleanup(process.wait)
        self.addCleanup(process.kill)
        return process

    def _run(self, home: Path, xdg: str | None) -> None:
        env = {"PATH": os.environ["PATH"], "HOME": str(home)}
        if xdg is not None:
            env["XDG_CACHE_HOME"] = xdg
        subprocess.run(
            ["bash", "-c", "set -euo pipefail\n" + self._stop_function()],
            env=env, check=True, timeout=30,
        )

    def _info_file(self, cache_root: Path, pid: int) -> Path:
        info = cache_root / "agent-quota" / "settings-server.json"
        info.parent.mkdir(parents=True)
        info.write_text('{"pid": %d, "port": 1, "url": "http://127.0.0.1:1/"}' % pid)
        return info

    def _dead(self, process: subprocess.Popen) -> bool:
        for _ in range(50):
            if process.poll() is not None:
                return True
            time.sleep(0.1)
        return False

    def test_server_under_home_cache_is_stopped_when_xdg_cache_differs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            process = self._spawn_fake_server()
            info = self._info_file(home / ".cache", process.pid)
            self._run(home, str(Path(temporary) / "terminal-xdg"))
            self.assertTrue(self._dead(process))
            self.assertFalse(info.exists())

    def test_server_under_xdg_cache_is_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            xdg = Path(temporary) / "xdg"
            process = self._spawn_fake_server()
            info = self._info_file(xdg, process.pid)
            self._run(home, str(xdg))
            self.assertTrue(self._dead(process))
            self.assertFalse(info.exists())

    def test_servers_in_both_locations_are_stopped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            xdg = Path(temporary) / "xdg"
            first, second = self._spawn_fake_server(), self._spawn_fake_server()
            self._info_file(xdg, first.pid)
            self._info_file(home / ".cache", second.pid)
            self._run(home, str(xdg))
            self.assertTrue(self._dead(first))
            self.assertTrue(self._dead(second))

    def test_unset_xdg_uses_home_cache_and_foreign_pid_is_left_alone(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            bystander = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            self.addCleanup(bystander.wait)
            self.addCleanup(bystander.kill)
            info = self._info_file(home / ".cache", bystander.pid)
            self._run(home, None)
            time.sleep(0.2)
            self.assertIsNone(bystander.poll(), "a pid that is not settings_server.py was killed")
            # The stale info file is still cleaned up.
            self.assertFalse(info.exists())


if __name__ == "__main__":
    unittest.main()
