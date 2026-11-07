"""providers.codex must not depend on the agent_quota entrypoint."""

from __future__ import annotations

import io
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class CodexLayeringTests(unittest.TestCase):
    def test_provider_modules_do_not_import_agent_quota(self) -> None:
        for path in (ROOT / "providers").glob("*.py"):
            source = path.read_text()
            self.assertNotIn("import agent_quota", source, path.name)
            self.assertNotIn("from agent_quota", source, path.name)

    def test_codex_imports_without_agent_quota(self) -> None:
        code = (
            "import sys, providers.codex; "
            "sys.exit(1 if 'agent_quota' in sys.modules else 0)"
        )
        result = subprocess.run(
            [sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_print_cli_renders_plan_and_metrics(self) -> None:
        from providers import codex

        usage = {
            "identity": {"plan": "plus", "user_name": "Ada"},
            "rate_limit": {
                "primary_window": {
                    "used_percent": 25,
                    "limit_window_seconds": 18000,
                    "reset_after_seconds": 3600,
                }
            },
        }
        out = io.StringIO()
        with redirect_stdout(out):
            codex.print_cli(usage)
        text = out.getvalue()
        self.assertIn("Plan              : Plus", text)
        self.assertIn("Ada", text)
        self.assertIn("75%", text)


if __name__ == "__main__":
    unittest.main()
