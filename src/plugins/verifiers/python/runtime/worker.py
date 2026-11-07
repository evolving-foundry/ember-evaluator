"""JSON-lines transport for installed upstream Harbor verifiers; no Docker access."""
from __future__ import annotations

import asyncio
import base64
import importlib
import json
import os
import runpy
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace

# Isolated Python (-I) does not add the script directory to sys.path.
submission_failure = runpy.run_path(str(Path(__file__).with_name("workbuddy.py")))["submission_failure"]


def send(value: dict) -> None:
    sys.__stdout__.write(json.dumps(value, allow_nan=False) + "\n")
    sys.__stdout__.flush()


async def main() -> None:
    # /trial is allocated by the coordinator. Match its owner before creating
    # private evidence so a non-root Linux coordinator can read and redact it.
    # Reading IDs inside the container also respects Docker user namespaces.
    owner = Path("/trial").stat()
    if os.geteuid() == 0:
        if owner.st_gid != os.getegid() or owner.st_uid != os.geteuid():
            os.setgroups([])
            os.setgid(owner.st_gid)
            os.setuid(owner.st_uid)
    reader = asyncio.StreamReader(limit=32 * 1024 * 1024)
    await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    request = json.loads(await reader.readline())
    pending: dict[int, asyncio.Future] = {}
    sequence = 0

    async def rpc(operation: str, **arguments):
        nonlocal sequence
        sequence += 1
        identity = sequence
        future = asyncio.get_running_loop().create_future()
        pending[identity] = future
        send({"type": "call", "id": identity, "operation": operation, **arguments})
        return await future

    async def responses():
        while line := await reader.readline():
            response = json.loads(line)
            future = pending.pop(response["id"])
            if response.get("error"):
                future.set_exception(RuntimeError(response["error"]))
            else:
                future.set_result(response.get("result"))
        for future in pending.values():
            if not future.done():
                future.set_exception(RuntimeError("Verifier transport closed"))

    class Environment:
        def __init__(self):
            from harbor.models.task.config import TaskOS
            self.os = TaskOS.LINUX
            self.capabilities = SimpleNamespace(mounted=False)

        async def exec(self, command, cwd=None, env=None, timeout_sec=None, **_):
            return SimpleNamespace(**await rpc("exec", command=command, cwd=cwd, env=env or {}, timeout=timeout_sec))

        async def upload_dir(self, source_dir, target_dir):
            await rpc("upload_dir", source=str(source_dir), target=str(target_dir))

        async def upload_file(self, source_path, target_path):
            await rpc("upload_file", data=base64.b64encode(Path(source_path).read_bytes()).decode(), target=str(target_path))

        async def download_dir(self, source_dir, target_dir):
            await rpc("download_dir", source=str(source_dir), target=str(target_dir))

        async def download_file(self, source_path, target_path):
            await rpc("download_dir", source=str(source_path), target=str(target_path))

    pump = asyncio.create_task(responses())
    # Upstream diagnostics must never share the protocol stream.
    sys.stdout = sys.stderr
    details = {}
    try:
        from harbor.models.task.task import Task
        from harbor.models.trial.paths import TrialPaths
        module_name, class_name = request["importPath"].split(":", 1)
        verifier_type = getattr(importlib.import_module(module_name), class_name)
        verifier = verifier_type(task=Task(Path(request["taskDir"])), trial_paths=TrialPaths(Path("/trial")),
                                 environment=Environment(), verifier_env=request.get("env", {}))
        result = await verifier.verify()
        score_path = Path("/trial/verifier/score.json")
        details = json.loads(score_path.read_text()) if score_path.is_file() else {}
        if details.get("test_status") in ("judge_error", "build_error"):
            fallback = submission_failure(request["importPath"], Path(request["taskDir"]), score_path.parent, details)
            if fallback is None:
                raise RuntimeError("Upstream verifier reported " + details["test_status"])
            details = {"native": details, "evaluator": fallback}
        send({"type": "result", "rewards": result.rewards, "details": details})
    except Exception as error:
        send({"type": "error", "message": str(error), "details": {
            "score": details,
            "exceptionType": type(error).__name__,
            "traceback": traceback.format_exc()[-16384:],
        }})
        raise
    finally:
        pump.cancel()
        await asyncio.gather(pump, return_exceptions=True)


if __name__ == "__main__":
    asyncio.run(main())
