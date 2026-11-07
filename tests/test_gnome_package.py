"""Static checks on the installed GNOME extension bundle.

`gnome-extensions pack` only adds the standard extension assets; every other
file must be listed explicitly in install-gnome-extension.sh. These tests
follow the relative JavaScript imports from the packaged entry points and
assert each one is shipped, so a newly extracted helper cannot silently break
the installed extension while repository-level tests still pass.
"""

from __future__ import annotations

import re
import shlex
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
        self.assertIn("${metric.label}: ${displayMetricValue(metric)}", source)


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


if __name__ == "__main__":
    unittest.main()
