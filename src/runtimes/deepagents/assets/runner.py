#!/usr/bin/env python3
"""ember-evaluator deepagents runner: run one bundle task headlessly.

Launched by the evaluator as ``<venv>/bin/python runner.py --bundle-dir <bundle>``
with the task prompt on stdin and cwd set to the task workspace. Emits the
evaluator harness event stream (same wire shape as the DSH 0.1.6-alpha.2
``--json`` protocol) on stdout, so the evaluator consumes both harnesses with
one stream consumer:

    session -> [system_prompt]* -> status turn_start
            -> (status step_start -> [text|tool_call|tool_result]*
                -> status step_end [usage])* per model round
            -> status turn_end -> final

Stdout fd 1 is redirected to stderr before the bundle import: anything the
composition, plugins or tools print goes to stderr evidence, never into the
protocol stream. The composition entry (``agent.py``) resolves the model from
AGENT_MODEL_* environment variables at import time.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path


def _serialize_content(content) -> str:
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False, default=str)


def _usage_record(usage_metadata) -> dict | None:
    if not isinstance(usage_metadata, dict):
        return None
    record: dict = {}
    input_tokens = usage_metadata.get("input_tokens")
    output_tokens = usage_metadata.get("output_tokens")
    if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
        return None
    record["inputTokens"] = input_tokens
    record["outputTokens"] = output_tokens
    total_tokens = usage_metadata.get("total_tokens")
    if isinstance(total_tokens, int):
        record["totalTokens"] = total_tokens
    details = usage_metadata.get("input_token_details")
    if isinstance(details, dict):
        cache_read = details.get("cache_read")
        if isinstance(cache_read, int):
            record["cacheReadTokens"] = cache_read
        cache_write = details.get("cache_write")
        if isinstance(cache_write, int):
            record["cacheWriteTokens"] = cache_write
    return record


class Emitter:
    """Line-buffered protocol writer holding the original stdout fd."""

    def __init__(self) -> None:
        self._stream = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
        os.dup2(2, 1)

    def emit(self, record: dict) -> None:
        self._stream.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")

    def flush(self) -> None:
        self._stream.flush()


def _message_role(msg) -> str:
    return str(getattr(msg, "type", type(msg).__name__.lower()))


def _run(bundle_dir: Path, emitter: Emitter) -> int:
    task = sys.stdin.read()
    if task.strip() == "":
        raise RuntimeError("the task prompt on stdin is empty")

    session_id = str(uuid.uuid4())
    cwd = os.getcwd()
    provider = os.environ.get("AGENT_MODEL_PROVIDER", "") or "deepagents-default"
    model_name = os.environ.get("AGENT_MODEL_NAME", "")
    emitter.emit({
        "type": "session",
        "sessionId": session_id,
        "cwd": cwd,
        "model": {"provider": provider, "name": model_name},
    })

    if str(bundle_dir) not in sys.path:
        sys.path.insert(0, str(bundle_dir))
    import agent as composition  # noqa: E402  (bundle dir must be on sys.path first)

    try:
        from langchain.agents.middleware import AgentMiddleware
    except ModuleNotFoundError:  # dependency-free fixture bundles
        class AgentMiddleware:  # type: no-redef
            pass

    class RecorderMiddleware(AgentMiddleware):
        """Records each fully assembled system prompt, as seen by the model."""

        def __init__(self) -> None:
            super().__init__()
            self.system_prompts: list = []

        def wrap_model_call(self, request, handler):
            system_message = getattr(request, "system_message", None)
            if system_message is not None:
                self.system_prompts.append(system_message.content)
            return handler(request)

    recorder = RecorderMiddleware()
    graph = composition.build_agent((recorder,))
    result = graph.invoke({"messages": [("user", task)]})

    for system_prompt in recorder.system_prompts:
        emitter.emit({"type": "system_prompt", "text": _serialize_content(system_prompt)})

    messages = list(result.get("messages", []))
    final_msg = None
    for msg in messages:
        if _message_role(msg) == "ai":
            final_msg = msg

    emitter.emit({"type": "status", "phase": "turn_start", "turn": 1})
    step = 0
    step_open = False
    pending_calls: set[str] = set()
    usage: dict | None = None

    def close_step() -> None:
        nonlocal step_open
        if pending_calls:
            raise RuntimeError(f"model round ended with {len(pending_calls)} unresolved tool calls")
        record: dict = {"type": "status", "phase": "step_end", "turn": 1, "step": step}
        if usage is not None:
            record["usage"] = usage
        emitter.emit(record)
        step_open = False

    for msg in messages:
        role = _message_role(msg)
        if role == "tool":
            if not step_open:
                raise RuntimeError("tool result arrived outside an active model round")
            call_id = getattr(msg, "tool_call_id", None)
            if not call_id or call_id not in pending_calls:
                raise RuntimeError(f"tool result {call_id!r} has no pending tool call")
            pending_calls.discard(call_id)
            status = "error" if getattr(msg, "status", "success") == "error" else "completed"
            emitter.emit({
                "type": "tool_result",
                "callId": call_id,
                "status": status,
                "result": _serialize_content(getattr(msg, "content", "")),
            })
            continue
        if role != "ai":
            continue
        if step_open:
            close_step()
        step += 1
        usage = _usage_record(getattr(msg, "usage_metadata", None))
        emitter.emit({"type": "status", "phase": "step_start", "turn": 1, "step": step})
        step_open = True
        content = _serialize_content(getattr(msg, "content", ""))
        if content.strip() and msg is not final_msg:
            emitter.emit({"type": "text", "text": content})
        for tool_call in getattr(msg, "tool_calls", None) or []:
            call_id = tool_call.get("id")
            if not call_id:
                raise RuntimeError("model produced a tool call without an id")
            if call_id in pending_calls:
                raise RuntimeError(f"duplicate tool call {call_id}")
            pending_calls.add(call_id)
            emitter.emit({
                "type": "tool_call",
                "callId": call_id,
                "tool": str(tool_call.get("name", "")),
                "input": tool_call.get("args", {}),
            })
    if step_open:
        close_step()
    if final_msg is None:
        raise RuntimeError("the run produced no final model message")

    metadata = getattr(final_msg, "response_metadata", None) or {}
    finish_reason = metadata.get("finish_reason") or metadata.get("stop_reason")
    reason = "max-tokens" if finish_reason in ("length", "max_tokens") else "completed"
    if reason == "completed" and not _serialize_content(final_msg.content).strip():
        raise RuntimeError("the run produced no final model text")
    emitter.emit({"type": "status", "phase": "turn_end", "turn": 1, "reason": {"kind": reason}})
    emitter.emit({"type": "final", "text": _serialize_content(final_msg.content)})
    emitter.flush()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle-dir", required=True, help="installed bundle directory containing the composition entry")
    parser.add_argument("--json", action="store_true", help="accepted for CLI symmetry; output is always the event stream")
    args = parser.parse_args()

    emitter = Emitter()
    try:
        return _run(Path(args.bundle_dir).resolve(), emitter)
    except BaseException as error:  # noqa: BLE001 - the protocol owns failure reporting
        emitter.emit({"type": "error", "message": f"{type(error).__name__}: {error}"})
        emitter.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
