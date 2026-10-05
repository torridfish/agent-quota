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
        self.assertTrue({"reset-display.js", "secret-config.js"} <= seen)


if __name__ == "__main__":
    unittest.main()
