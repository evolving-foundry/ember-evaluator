# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Load and replay the candidate operator under msprof.

The Evaluator TypeScript layer owns capture orchestration, CSV parsing, caching
and hardware analysis (src/plugins/benchmarks/operator/kernel/). This worker
only executes the operator, which requires the torch/triton runtime.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import random
import sys

from precision import load_module, load_task_module, verify_hashes
from strict import observe_environment


def replay(request):
    """Replay on the logical NPU selected by KERNEL_NPU_DEVICE (default 0); preserve dtypes and model arguments."""
    seeds = request["seeds"]
    if not isinstance(seeds, list) or len(seeds) != 1 or isinstance(seeds[0], bool) or not isinstance(seeds[0], int) or not 0 <= seeds[0] <= 0xffffffff:
        raise ValueError("Diagnostic replay requires one unsigned 32-bit seed")
    if isinstance(request["warmup"], bool) or not isinstance(request["warmup"], int) or request["warmup"] < 1:
        raise ValueError("Diagnostic replay warmup must be a positive integer")
    verify_hashes(request["hashes"])
    try:
        import mstx
    except ImportError as error:
        raise RuntimeError("MSTX runtime is required for diagnostic capture") from error
    if not callable(getattr(mstx, "get_tool_id", None)):
        raise RuntimeError("MSTX runtime must expose its active tool ID")
    tool_id = mstx.get_tool_id()
    if tool_id != 0x1001:
        raise RuntimeError("MSTX operator profiler injection is not active")
    import torch
    import torch_npu  # noqa: F401  (registers the npu backend, required on Ascend)

    if not torch.npu.is_available():
        raise RuntimeError("NPU is required for detailed profiling")
    raw = os.environ.get("KERNEL_NPU_DEVICE", "")
    device = int(raw) if raw.isdigit() else 0
    torch.npu.set_device(device)
    problem = load_task_module(request["problem"], request["dataRoot"], "problem")
    try:
        candidate = load_task_module(request["candidate"], request["dataRoot"], "kernel").kernel_function
    except ValueError:
        # Protocol-locked candidates must be under dataRoot. Standalone workers may use
        # separate problem and kernel trees, so fall back to importing the candidate by file location.
        candidate = load_module(request["candidate"], "kernel_msprof_kernel").kernel_function
    if not callable(candidate):
        raise TypeError("kernel_function must be callable")
    seed = seeds[0]
    with torch.inference_mode():
        random.seed(seed)
        torch.manual_seed(seed)
        torch.npu.manual_seed_all(seed)
        init = problem.get_init_inputs() if hasattr(problem, "get_init_inputs") else []
        # Reference construction may consume RNG state; match precision.evaluate before get_inputs.
        reference = problem.Model(*init).to(f"npu:{device}").eval()
        inputs = problem.get_inputs()
        if not isinstance(inputs, (tuple, list)):
            raise TypeError("get_inputs must return a positional argument list")
        warmup_completed = 0
        for _ in range(request["warmup"]):
            candidate(*inputs)
            warmup_completed += 1
        torch.npu.synchronize()
        range_id = mstx.range_start("rsi_operator_profile", None)
        if isinstance(range_id, bool) or not isinstance(range_id, int) or range_id < 0:
            raise RuntimeError("MSTX range start did not return a valid range ID")
        calls_in_range = 0
        try:
            candidate(*inputs)
            calls_in_range += 1
            torch.npu.synchronize()
        finally:
            mstx.range_end(range_id)
        del reference
    verify_hashes(request["hashes"])
    observed_device = torch.npu.current_device()
    device_count = torch.npu.device_count()
    return {"seed": seed, "requestedLogicalDevice": device, "logicalDevice": observed_device,
            "deviceCount": device_count, "deviceName": torch.npu.get_device_name(observed_device),
            "warmup": request["warmup"], "inputContract": "unchanged problem.get_inputs",
            "capture": {"method": "mstx", "range": "rsi_operator_profile", "toolId": tool_id,
                        "rangeId": range_id, "warmupCompleted": warmup_completed, "callsInRange": calls_in_range},
            "environment": observe_environment(torch, torch_npu, observed_device)}


def main():
    parser = argparse.ArgumentParser(prog="msprof_replay")
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = replay(json.loads(Path(args.request).read_text(encoding="utf-8")))
    Path(args.output).write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
