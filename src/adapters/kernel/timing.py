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

"""
NPU kernel benchmarking.

Use torch_npu.profiler to capture kernel_details.csv and read Duration(us).

Measure device execution time without CPU launch latency.
"""

import builtins
import json
import os
import shutil
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

import torch

# Explicit NPU execution: never probe CUDA or substitute CPU timing.
import torch_npu

# Explicit backend identity consumed by precision.py, including external timers.
IS_NPU = True


def _logical_npu_device_id() -> int:
    requested = os.environ.get("KERNEL_NPU_DEVICE") or os.environ.get("ASCEND_DEVICE_ID") or os.environ.get("DEVICE_ID")
    visible = os.environ.get("ASCEND_RT_VISIBLE_DEVICES") or os.environ.get("ASCEND_VISIBLE_DEVICES")
    if visible:
        visible_ids = [item.strip() for item in visible.split(",") if item.strip()]
        if requested and requested in visible_ids:
            return visible_ids.index(requested)
        return 0
    return int(requested or "0")


def device_synchronize():
    torch.npu.synchronize()


# ============ NPU profiler timing ============
def _bench_npu_profiler(fn, warmup=5, active=20, prof_dir=None, keep_res=False,
                        triton_only=False, audit=None):
    """
    Capture kernel_details.csv with torch_npu.profiler.
    Return the mean kernel execution time in milliseconds.

    triton_only=True: include only Triton kernels, excluding aclnn framework operators.
            Use this scope for orchestrator baseline and promotion decisions.
    triton_only=False: sum all operators inside the wrapper.
            Use this scope for eager/inductor baseline logging.
    """
    # warmup
    for _ in range(warmup):
        fn()
    device_synchronize()

    # Profiler configuration.
    experimental_config = torch_npu.profiler._ExperimentalConfig(
        aic_metrics=torch_npu.profiler.AiCMetrics.PipeUtilization,
        profiler_level=torch_npu.profiler.ProfilerLevel.Level1,
        l2_cache=False,
        data_simplification=False,
    )

    if prof_dir is None:
        timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
        prof_dir = f"/tmp/prof_bench_{timestamp}_{os.getpid()}"
    else:
        os.makedirs(prof_dir, exist_ok=True)

    print(f"[bench_kernel] warmup: {warmup} active: {active} prof_dir: {prof_dir}")
    prof_dir_rel = os.path.relpath(prof_dir)
    print(f"[bench_kernel] NPU Profiler: {prof_dir_rel}")

    total = warmup + active
    options = {}
    activities = [torch_npu.profiler.ProfilerActivity.NPU]
    if audit is not None:
        # Capture every step, then explicitly exclude our warmup steps during reduction.
        options['schedule'] = torch_npu.profiler.schedule(wait=0, warmup=0, active=total, repeat=1)
        # CPU records provide ProfilerStep ranges; only device kernel durations enter the mean.
        activities.append(torch_npu.profiler.ProfilerActivity.CPU)
    with torch_npu.profiler.profile(
            activities=activities,
            on_trace_ready=torch_npu.profiler.tensorboard_trace_handler(dir_name=prof_dir_rel),
            record_shapes=False,
            profile_memory=False,
            with_stack=False,
            with_flops=False,
            with_modules=False,
            experimental_config=experimental_config,
        **options,
    ) as prof:
        for _ in builtins.range(total):
            fn()
            device_synchronize()
            if audit is not None:
                prof.step()

    # Strict callers require explicit flow association; no equal-row-count fallback.
    if audit is not None:
        from timing_evidence import collect_flow_timing
        audit.update(collect_flow_timing(prof_dir, warmup, active))
        time_cost_ms = audit['meanMs']
    elif triton_only:
        time_cost_ms = _collect_npu_prof_triton_only(prof_dir, warmup, active)
    else:
        time_cost_ms = _collect_npu_prof_result(prof_dir, warmup, active)

    # Remove temporary profiler artifacts unless retention was requested.
    if not keep_res and os.path.exists(prof_dir):
        shutil.rmtree(prof_dir, ignore_errors=True)

    return time_cost_ms


def _collect_npu_prof_result(base_dir, num_warmup, num_active):
    """Sum all device operators per iteration, including reductions; reject missing or corrupt records."""
    import csv
    import math

    kernel_details_file = None
    for root, _, files in os.walk(base_dir):
        for file in files:
            if file == "kernel_details.csv":
                kernel_details_file = os.path.join(root, file)
                break

    if kernel_details_file is None or num_warmup < 0 or num_active <= 0:
        return float("inf")

    durations = []
    try:
        with open(kernel_details_file, newline="", encoding="utf-8-sig") as source:
            rows = csv.DictReader(source, strict=True)
            if "Duration(us)" not in (rows.fieldnames or []):
                return float("inf")
            for row in rows:
                duration = float(row["Duration(us)"])
                # Include reductions in all-device timing; nonfinite durations must not be silently ignored.
                if not math.isfinite(duration) or duration < 0:
                    return float("inf")
                durations.append(duration)
    except (csv.Error, TypeError, ValueError):
        return float("inf")

    total_iters = num_warmup + num_active
    if not durations or len(durations) % total_iters != 0:
        return float("inf")

    # Fixed-input graph iterations have equal record counts; skip captured warmup iterations.
    rows_per_iter = len(durations) // total_iters
    active_durations = durations[num_warmup * rows_per_iter:]
    avg_us = math.fsum(active_durations) / num_active
    return avg_us / 1e3 if math.isfinite(avg_us) and avg_us > 0 else float("inf")


def _collect_npu_prof_triton_only(base_dir, num_warmup, num_active):
    """Read Triton kernel Duration(us) values from kernel_details.csv and return milliseconds.

    Exclude aclnn framework operators such as MatMulV3, Transpose and BatchMatMulV3.
    Retain timings for Triton-generated kernels whose names do not start with aclnn.

    This is the timing scope used for orchestrator baseline and promotion decisions.
    """
    import pandas as pd

    kernel_details_file = None
    for root, _, files in os.walk(base_dir):
        for file in files:
            if file == "kernel_details.csv":
                kernel_details_file = os.path.join(root, file)
                break

    if kernel_details_file is None:
        return float("inf")

    df = pd.read_csv(kernel_details_file)

    # Exclude ReduceSum used for L2 cache clearing.
    if "Type" in df.columns:
        df = df[~df["Type"].str.contains(r"^ReduceSum$", case=False, na=False)]

    # Keep Triton kernels whose names do not start with aclnn.
    if "Name" in df.columns:
        df = df[~df["Name"].str.startswith("aclnn", na=False)]

    total_iters = num_warmup + num_active
    if total_iters <= 0 or len(df) % total_iters != 0:
        print(
            f"[bench_kernel] WARNING: kernel_details row count ({len(df)}) "
            f"is not a multiple of the model iteration count ({total_iters}); cannot split rows by iteration"
        )
        return float("inf")

    rows_per_iter = len(df) // total_iters

    warmup_rows = num_warmup * rows_per_iter
    active_rows = df.iloc[warmup_rows:warmup_rows + num_active * rows_per_iter]

    if len(active_rows) == 0:
        return float("inf")

    avg_us = active_rows["Duration(us)"].sum() / num_active
    return avg_us / 1e3  # us -> ms


def bench_kernel(fn, warmup=5, active=20, prof_dir=None, keep_res=False,
                 triton_only=False, audit=None):
    """NPU profiler duration in ms; triton_only excludes framework kernels."""
    if not torch.npu.is_available():
        raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
    torch.npu.set_device(_logical_npu_device_id())
    return _bench_npu_profiler(fn, warmup=warmup, active=active,
                               prof_dir=prof_dir, keep_res=keep_res,
                               triton_only=triton_only, audit=audit)


def bench_kernel_ms(fn, **kwargs):
    """Return the shared benchmark result in milliseconds."""
    return bench_kernel(fn, **kwargs)


def bench_kernel_us(fn, **kwargs):
    """Return the benchmark result in microseconds."""
    return bench_kernel(fn, **kwargs) * 1000


# ---------------- Benchmark worker entry point: timing --problem --kernel --out ----------------
# Measure warmup and active device executions; the precision worker owns correctness checks.
def _bench_atom_main():
    import argparse

    import torch
    import torch_npu  # noqa: F401

    parser = argparse.ArgumentParser(prog="timing")
    parser.add_argument("--problem", required=True)
    parser.add_argument("--kernel", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--warmup", type=int, default=25)
    parser.add_argument("--repeat", type=int, default=100)
    args = parser.parse_args()
    payload = {"problem": args.problem, "kernel": args.kernel, "time_ms": None, "error": ""}
    out_path = Path(args.out)
    try:
        if not torch.npu.is_available():
            raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
        torch.npu.set_device(_logical_npu_device_id())
        from precision import CandidateError, clone_tree, load_module, load_task_module

        problem = load_task_module(args.problem, str(Path(args.problem).resolve().parent), "problem")
        kernel_mod = load_module(args.kernel, "kernel_atom_kernel")
        candidate = kernel_mod.kernel_function
        if not callable(candidate):
            raise CandidateError("kernel_function must be callable")
        inputs = problem.get_inputs()
        if not isinstance(inputs, (list, tuple)):
            raise TypeError("get_inputs must return a positional argument list")
        inputs = tuple(clone_tree(inputs, torch))
        with torch.inference_mode():
            ms = bench_kernel_ms(
                lambda: candidate(*inputs), warmup=args.warmup, active=args.repeat,
                prof_dir=None, keep_res=False, triton_only=True,
            )
        if ms is None or ms != ms or ms == float("inf") or ms <= 0:
            payload["error"] = "bench did not produce a finite positive duration"
        else:
            payload["time_ms"] = float(ms)
    except CandidateError as exc:
        payload["error"] = str(exc)
    except Exception as exc:  # noqa: BLE001 - record evaluation failure evidence without a nonzero exit
        traceback.print_exc()
        payload["error"] = f"{type(exc).__name__}: {exc}"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    _bench_atom_main()
