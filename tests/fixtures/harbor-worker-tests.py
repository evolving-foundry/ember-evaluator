"""No Docker/model calls: native CSV parsing and the evaluator's failure boundary."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(sys.argv.pop(1))
submission_failure = runpy.run_path(str(ROOT / "src/plugins/verifiers/python/runtime/workbuddy.py"))["submission_failure"]
FIXTURES = ROOT / "tests/fixtures/workbuddy-failures"
IMPORT_PATH = "workbuddy_bench.judge:CompositeVerifier"


class WorkBuddyFailures(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.task = self.root / "task"
        self.output = self.root / "verifier"
        (self.task / "tests").mkdir(parents=True)
        self.output.mkdir()
        self.manifest("script_verifier")

    def manifest(self, family):
        (self.task / "tests/verifier.toml").write_text(
            'schema_version = "workbuddy.code_lite.verifier.v1"\nfamily = "' + family + '"\n', encoding="utf-8")

    def classify(self, text, status="build_error", import_path=IMPORT_PATH):
        (self.output / "test_output.txt").write_text(text, encoding="utf-8")
        return submission_failure(import_path, self.task, self.output, {"test_status": status})

    def test_native_bom_failures_and_unchanged_successful_grading(self):
        for name, total in [("invoice", 12), ("customer-health", 13)]:
            with self.subTest(name=name):
                payload = (FIXTURES / (name + ".csv")).read_bytes()
                self.assertTrue(payload.startswith(b"\xef\xbb\xbf"))
                for bom in (True, False):
                    workspace = self.root / (name + str(bom))
                    workspace.mkdir()
                    (workspace / "export.csv").write_bytes(payload if bom else payload[3:])
                    logs = workspace / "logs"
                    with patch.dict(os.environ, WORKSPACE=str(workspace), LOG_DIR=str(logs)), \
                         patch("subprocess.run", return_value=SimpleNamespace(returncode=0)), \
                         patch.object(sys, "path", list(sys.path)), contextlib.redirect_stdout(io.StringIO()):
                        if bom:
                            with self.assertRaises(KeyError):
                                runpy.run_path(str(FIXTURES / (name + "-verifier.py")))
                            self.assertFalse((logs / "reward.json").exists())
                        else:
                            runpy.run_path(str(FIXTURES / (name + "-verifier.py")))
                            result = json.loads((logs / "reward.json").read_text())
                            self.assertEqual((result["overall"], result["tests_total"]), (1.0, total))
                native = (FIXTURES / (name + "-error.txt")).read_text()
                result = self.classify(native)
                self.assertEqual(result["kind"], "submission-validation-failure")
                self.assertEqual(result["exceptionType"], "KeyError")

    def test_missing_submission_and_empty_csv_are_submission_failures(self):
        for error in ["IndexError: list index out of range", "_csv.Error: field larger than field limit (131072)",
                      "FileNotFoundError: [Errno 2] No such file: '/workspace/export.csv'"]:
            self.assertIsNotNone(self.classify('Traceback (most recent call last):\n  File "/tests/verifier.py", line 36\n' + error))

    def test_dependency_and_judge_errors_are_not_model_zeroes(self):
        for error in ["ModuleNotFoundError: No module named 'csv'", "DeprecationWarning: BlockingPortal deprecated", "RuntimeError: judge unavailable"]:
            self.assertIsNone(self.classify('  File "/tests/verifier.py", line 1\n' + error))
        self.assertIsNone(self.classify((FIXTURES / "invoice-error.txt").read_text(), status="judge_error"))

    def test_other_verifier_families_and_custom_plugins_are_not_reclassified(self):
        native = (FIXTURES / "invoice-error.txt").read_text()
        self.assertIsNone(self.classify(native, import_path="custom:Verifier"))
        self.manifest("pytest_injected")
        self.assertIsNone(self.classify(native))

    def test_failures_outside_task_grader_or_missing_test_materials_stay_invalid(self):
        self.assertIsNone(self.classify('  File "/runtime/library.py", line 1\nKeyError: item'))
        self.assertIsNone(self.classify('  File "/tests/verifier.py", line 1\nFileNotFoundError: /tests/gold.json'))
        self.assertIsNone(self.classify(""))


if __name__ == "__main__":
    unittest.main()
