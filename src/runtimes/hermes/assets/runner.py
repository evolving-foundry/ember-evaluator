"""Run pinned Hermes while retaining typed terminal output-length evidence."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import quote


def install_output_capture() -> None:
    # These hooks belong to the pinned Hermes runtime. Keep its recovery,
    # cleanup and exit-code decisions; only enrich the existing usage report.
    from agent import turn_response_check, turn_truncation
    from hermes_cli import oneshot
    from hermes_constants import PARTIAL_STREAM_STUB_ID

    recover = turn_response_check.recover_from_truncation
    write_usage = oneshot._write_usage_file

    def capture(agent, response, finish_reason, *args, **kwargs):
        verdict = recover(agent, response, finish_reason, *args, **kwargs)
        result = verdict.result
        if (
            verdict.action != "return" or not isinstance(result, dict)
            or result.get("failure_reason") != "truncated"
            or result.get("interrupted") or result.get("compression_exhausted")
            or getattr(response, "id", None) == PARTIAL_STREAM_STUB_ID
            or getattr(response, "_runaway_repetition", False)
            or getattr(response, "_content_filter_terminated", False)
        ):
            return verdict
        message = turn_truncation.normalize_response_for_agent(agent, response)
        # Hermes also routes broken streams through its truncation recovery.
        # Require the provider's own length reason before permitting scoring.
        if getattr(message, "finish_reason", None) not in ("length", "max_tokens"):
            return verdict
        actual = getattr(message, "content", None) or ""
        # Native continuation recovery may already have stitched several replies.
        for item in reversed(result.get("messages") or []):
            if item.get("role") == "assistant" and item.get("finish_reason") == "length":
                actual = item.get("content") or ""
                break
        result["evaluator_output"] = {
            "finishReason": "length", "finalText": agent._strip_think_blocks(actual),
        }
        return verdict

    def report(path, result, failure=None):
        write_usage(path, result, failure)
        if (
            not path or failure is not None or "evaluator_output" not in result
            or result.get("failure_reason") != "truncated" or result.get("interrupted")
        ):
            return
        target = Path(path).expanduser()
        data = json.loads(target.read_text(encoding="utf-8"))
        captured = dict(result["evaluator_output"])
        secret = os.environ.get("EMBER_EVALUATOR_API_KEY", "")
        if secret:
            for sensitive in {secret, quote(secret, safe="~()*!.'-_")}:
                captured["finalText"] = captured["finalText"].replace(sensitive, "[redacted]")
        data["evaluator_output"] = captured
        target.write_text(json.dumps(data) + "\n", encoding="utf-8")

    turn_response_check.recover_from_truncation = capture
    oneshot._write_usage_file = report


def main() -> None:
    root = Path(sys.argv.pop(1)).resolve()
    sys.path.insert(0, str(root))
    install_output_capture()
    from hermes_cli.main import main as hermes_main

    hermes_main()


if __name__ == "__main__":
    main()
