"""Recognize submission-validation failures in the pinned WorkBuddy script protocol."""
from __future__ import annotations

import re
import tomllib
from pathlib import Path


def submission_failure(import_path: str, task_dir: Path, verifier_dir: Path, details: dict) -> dict | None:
    # A generic build_error can mean broken dependencies or a failed judge.
    # Only the code_lite script contract plus its native traceback permits this
    # fallback; task names, column names and submission files are never changed.
    if import_path != "workbuddy_bench.judge:CompositeVerifier" or details.get("test_status") != "build_error":
        return None
    manifest_path = task_dir / "tests/verifier.toml"
    output_path = verifier_dir / "test_output.txt"
    for path in (manifest_path, output_path):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
            return None
    try:
        manifest = tomllib.loads(manifest_path.read_text(encoding="utf-8"))
        output = output_path.read_text(encoding="utf-8")
    except (OSError, UnicodeError, tomllib.TOMLDecodeError):
        return None
    if manifest.get("schema_version") != "workbuddy.code_lite.verifier.v1" or manifest.get("family") != "script_verifier":
        return None
    # Imports and dependency setup failures must remain invalid. The last
    # traceback frame must be the task grader reading/validating the submission.
    frames = re.findall(r'^\s*File "([^"]+)", line \d+', output, re.MULTILINE)
    if not frames or frames[-1] != "/tests/verifier.py":
        return None
    match = re.search(r"^(KeyError|IndexError|UnicodeDecodeError|_?csv\.Error|FileNotFoundError): (.+)$", output.rstrip().splitlines()[-1])
    if match is None:
        return None
    if match.group(1) == "FileNotFoundError" and "/workspace/" not in match.group(2):
        return None
    return {
        "kind": "submission-validation-failure",
        "scoreOrigin": "evaluator-failure-fallback",
        "nativeStatus": details["test_status"],
        "exceptionType": match.group(1),
        "reason": match.group(0),
        "diagnosticFile": "verifier/test_output.txt",
    }
