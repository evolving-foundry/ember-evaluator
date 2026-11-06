"""Evaluate a fixed kernel from stdin and write finite JSON results to stdout and the requested file."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import sys
import traceback
from types import ModuleType


class CandidateError(Exception):
    """Candidate loading or execution failure, distinct from reference and environment failures."""


def npu_device_id() -> int:
    """Logical NPU index selected by KERNEL_NPU_DEVICE, defaulting to 0."""
    raw = os.environ.get("KERNEL_NPU_DEVICE", "")
    return int(raw) if raw.isdigit() else 0


def load_module(path, name):
    """Load a module from its file without reusing a previous task module with the same name."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def verify_hashes(hashes):
    """Reject file changes between source locking and environment copying."""
    for path, expected in hashes.items():
        if hashlib.sha256(Path(path).read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Locked source changed: {path}")


def load_task_module(path, root, name):
    """Preserve task package structure and sibling imports without renaming declared dependencies."""
    path, root = Path(path).resolve(), Path(root).resolve()
    relative = path.relative_to(root)
    namespace = "_kernel_task"
    if namespace not in sys.modules:
        package = ModuleType(namespace)
        package.__path__ = [str(root)]
        sys.modules[namespace] = package
    # Resolve both sibling helpers and packages rooted at the manifest directory.
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(path.parent))
    parent = ".".join([namespace, *relative.parts[:-1]])
    importlib.import_module(parent)
    return load_module(path, f"{parent}.{name}")


def select_outputs(value, indices):
    """Exclude metadata only at explicitly declared task indices; otherwise preserve the full output."""
    if indices is None:
        return value
    if not isinstance(value, (list, tuple)):
        raise ValueError("outputIndices requires a tuple/list output")
    return tuple(value[i] for i in indices)


def clone_tree(value, torch):
    """Preserve input strides so cloning noncontiguous inputs does not change the task."""
    if isinstance(value, torch.Tensor):
        return torch.empty_strided(value.shape, value.stride(), device=value.device, dtype=value.dtype).copy_(value)
    if isinstance(value, tuple):
        return tuple(clone_tree(v, torch) for v in value)
    if isinstance(value, list):
        return [clone_tree(v, torch) for v in value]
    if isinstance(value, dict):
        return {k: clone_tree(v, torch) for k, v in value.items()}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    raise TypeError(f"Unsupported value type: {type(value).__name__}")


def compare_tree(expected, actual, torch, rtol, atol):
    """Compare all outputs and their structure; reject nonfinite floating-point values."""
    if isinstance(expected, torch.Tensor):
        if not isinstance(actual, torch.Tensor):
            raise AssertionError("Expected tensor output")
        if not bool(torch.isfinite(expected).all()) or not bool(torch.isfinite(actual).all()):
            raise AssertionError("Non-finite tensor output")
        floating = expected.is_floating_point() or expected.is_complex()
        torch.testing.assert_close(actual, expected, rtol=rtol if floating else 0, atol=atol if floating else 0, equal_nan=False)
        return
    if type(expected) is not type(actual):
        raise AssertionError("Output structure/type mismatch")
    if isinstance(expected, float) and (not math.isfinite(expected) or not math.isfinite(actual)):
        raise AssertionError("Non-finite scalar output")
    if isinstance(expected, (list, tuple)):
        if len(expected) != len(actual):
            raise AssertionError("Output length mismatch")
        for left, right in zip(expected, actual):
            compare_tree(left, right, torch, rtol, atol)
    elif isinstance(expected, dict):
        if expected.keys() != actual.keys():
            raise AssertionError("Output keys mismatch")
        for key in expected:
            compare_tree(expected[key], actual[key], torch, rtol, atol)
    elif expected != actual:
        raise AssertionError("Scalar output mismatch")


def validate_reference(value, torch):
    """Validate reference outputs first so reference NaN/Inf values are not blamed on the candidate."""
    if isinstance(value, torch.Tensor):
        if not bool(torch.isfinite(value).all()):
            raise ValueError("Non-finite reference tensor output")
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite reference scalar output")
    elif isinstance(value, (list, tuple)):
        for item in value:
            validate_reference(item, torch)
    elif isinstance(value, dict):
        for item in value.values():
            validate_reference(item, torch)


def candidate_call(function, inputs):
    """Convert candidate execution exceptions into explicit evaluation failures."""
    try:
        return function(*inputs)
    except Exception as exc:
        raise CandidateError(f"{type(exc).__name__}: {exc}") from exc


def positive_measurement(value):
    """Reject inf/NaN timing values produced by missing profiler data."""
    if not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
        raise RuntimeError("Profiler did not produce a finite positive duration")
    return float(value)


def evaluate(request, profile_root=Path(".")):
    """Return correctness and device timings with matching scopes, without calling a model service."""
    if "contract" in request:
        strict = load_module(Path(__file__).with_name("strict.py"), "kernel_strict")
        return strict.evaluate(request, profile_root, globals())
    verify_hashes(request["hashes"])
    import torch
    import torch_npu  # noqa: F401

    if not torch.npu.is_available():
        raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
    # The environment binds visible devices; --device / KERNEL_NPU_DEVICE selects a logical device within that set.
    device = npu_device_id()
    torch.npu.set_device(device)
    locked_timer = Path("runtime/timing.py")
    timer = load_module(locked_timer if locked_timer.exists() else Path(__file__).resolve().parent / "timing.py",
                        "kernel_locked_bench_kernel_util")
    if not timer.IS_NPU:
        raise RuntimeError("kernel benchmark did not select NPU")
    problem = load_task_module(request["problem"], request["dataRoot"], "problem")
    try:
        candidate = load_task_module(request["candidate"], request["dataRoot"], "kernel").kernel_function
        if not callable(candidate):
            raise TypeError("kernel_function must be callable")
    except Exception as exc:
        raise CandidateError(f"{type(exc).__name__}: {exc}") from exc

    reference = None
    timing_inputs = None
    with torch.inference_mode():
        for seed in request["seeds"]:
            random.seed(seed)
            torch.manual_seed(seed)
            torch.npu.manual_seed_all(seed)
            init = problem.get_init_inputs() if hasattr(problem, "get_init_inputs") else []
            reference = problem.Model(*init).to(f"npu:{device}").eval()
            inputs = problem.get_inputs()
            if not isinstance(inputs, (list, tuple)):
                raise TypeError("get_inputs must return a positional argument list")
            ref_inputs = clone_tree(inputs, torch)
            expected = clone_tree(select_outputs(reference(*ref_inputs), request["outputIndices"]), torch)
            torch.npu.synchronize()
            validate_reference(expected, torch)
            compare_tree(inputs, ref_inputs, torch, 0, 0)
            # Repeat in the same process to catch autotune succeeding once but leaving later outputs incomplete.
            for _ in range(2):
                trial = clone_tree(inputs, torch)
                actual = candidate_call(candidate, trial)
                try:
                    torch.npu.synchronize()
                except Exception as exc:
                    raise CandidateError(str(exc)) from exc
                try:
                    compare_tree(expected, select_outputs(actual, request["outputIndices"]), torch, request["rtol"], request["atol"])
                    compare_tree(inputs, trial, torch, 0, 0)
                except (AssertionError, ValueError, IndexError) as exc:
                    return {"status": "incorrect", "error": str(exc)[:4000]}
            timing_inputs = inputs

        if reference is None or timing_inputs is None:
            raise RuntimeError("No correctness cases executed")
        reference_ms = positive_measurement(timer.bench_kernel_ms(
            lambda: reference(*timing_inputs), warmup=request["warmup"], active=request["repeat"],
            prof_dir=str(profile_root / "profile-reference"), keep_res=True, triton_only=False,
        ))
        candidate_ms = positive_measurement(timer.bench_kernel_ms(
            lambda: candidate_call(candidate, timing_inputs), warmup=request["warmup"], active=request["repeat"],
            prof_dir=str(profile_root / "profile-candidate"), keep_res=True, triton_only=False,
        ))
        result = {"status": "passed", "error": "", "referenceMs": reference_ms,
                  "candidateMs": candidate_ms, "speedup": positive_measurement(reference_ms / candidate_ms)}
        # TypeScript owns detailed profiling (adapters/kernel/profile.ts / evaluator kernel profile).
        # This acceptance path records profiling.enabled only as requested; the TypeScript
        # kernelVerdict supplies an explicit failed fallback rather than invoking a missing profiling worker.
        verify_hashes(request["hashes"])
        return result


@contextlib.contextmanager
def native_output(log):
    """Capture CANN/C++ writes to file descriptors as well, keeping logs out of the JSON channel."""
    sys.stdout.flush()
    sys.stderr.flush()
    saved = [os.dup(1), os.dup(2)]
    try:
        os.dup2(log.fileno(), 1)
        os.dup2(log.fileno(), 2)
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            yield
    finally:
        log.flush()
        for fd, backup in zip((1, 2), saved):
            os.dup2(backup, fd)
            os.close(backup)



# ---------------- Precision worker entry point: precision --problem --kernel --out ----------------
# Kernel tolerances match rsi/validator.py: fixed ATOL and dtype-specific rtol.
ATOL = 1e-5
RTOL_BY_DTYPE = {"torch.float32": 1.3e-6, "torch.float16": 1e-3, "torch.bfloat16": 1.6e-2}
RTOL_DEFAULT = 1.3e-6


def _rtol_for(dtype, override):
    """Kernel rtol values match rsi/validator.py; explicit CLI overrides take precedence."""
    return override if override is not None else RTOL_BY_DTYPE.get(str(dtype), RTOL_DEFAULT)


def _dtype_of(value):
    """Use a tensor dtype, the first tensor dtype in a container, or the default tolerance key."""
    import torch

    if torch.is_tensor(value):
        return str(value.dtype)
    if isinstance(value, (list, tuple)):
        for item in value:
            if torch.is_tensor(item):
                return str(item.dtype)
    return "default"


def run_precision_atom(problem_path, kernel_path, seeds, rtol, atol):
    """Check two runs per seed against the reference and detect input mutation."""
    import random

    import torch
    import torch_npu  # noqa: F401

    payload = {"problem": problem_path, "kernel": kernel_path, "passed": False,
               "error": "", "seeds": seeds, "tolerance": {"atol": atol}}
    try:
        if not torch.npu.is_available():
            raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
        device = npu_device_id()
        torch.npu.set_device(device)
        problem, candidate = None, None
        problem = load_task_module(problem_path, str(Path(problem_path).resolve().parent), "problem")
        kernel_mod = load_module(kernel_path, "kernel_atom_kernel")
        candidate = kernel_mod.kernel_function
        if not callable(candidate):
            raise CandidateError("kernel_function must be callable")
        with torch.inference_mode():
            for seed in seeds:
                random.seed(seed)
                torch.manual_seed(seed)
                torch.npu.manual_seed_all(seed)
                init = problem.get_init_inputs() if hasattr(problem, "get_init_inputs") else []
                reference = problem.Model(*init).to(f"npu:{device}").eval()
                inputs = problem.get_inputs()
                if not isinstance(inputs, (list, tuple)):
                    raise TypeError("get_inputs must return a positional argument list")
                ref_inputs = clone_tree(inputs, torch)
                expected = clone_tree(select_outputs(reference(*ref_inputs), None), torch)
                torch.npu.synchronize()
                validate_reference(expected, torch)
                compare_tree(inputs, ref_inputs, torch, 0, 0)
                rtol_used = _rtol_for(_dtype_of(expected), rtol)
                payload["tolerance"]["rtol"] = rtol_used
                # Repeat each seed to catch autotune filling outputs once but leaving subsequent runs incomplete.
                for _ in range(2):
                    trial = clone_tree(inputs, torch)
                    actual = candidate(*trial)
                    torch.npu.synchronize()
                    try:
                        compare_tree(expected, select_outputs(actual, None), torch, rtol_used, atol)
                        compare_tree(inputs, trial, torch, 0, 0)
                    except (AssertionError, ValueError, IndexError) as exc:
                        payload["error"] = f"numeric check failed (seed={seed}): {exc}"[:4000]
                        return payload
                del reference
        payload["passed"] = True
    except CandidateError as exc:
        payload["error"] = str(exc)[:4000]
    except Exception as exc:  # noqa: BLE001 - record evaluation failure evidence without a nonzero exit
        payload["error"] = f"{type(exc).__name__}: {exc}"[:4000]
    return payload


def _emit(out_path, payload):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")



def main():
    """Run the precision worker for precision arguments, otherwise evaluate the protocol request from stdin."""
    if len(sys.argv) > 1 and sys.argv[1] == "precision":
        parser = argparse.ArgumentParser(prog="precision", add_help=False)
        parser.add_argument("--problem", required=True)
        parser.add_argument("--kernel", required=True)
        parser.add_argument("--out", required=True)
        parser.add_argument("--seeds", type=int, nargs="*", default=[0, 1])
        parser.add_argument("--rtol", type=float, default=None)
        parser.add_argument("--atol", type=float, default=ATOL)
        atom_args = parser.parse_args(sys.argv[2:])
        try:
            payload = run_precision_atom(atom_args.problem, atom_args.kernel,
                                         atom_args.seeds, atom_args.rtol, atom_args.atol)
        except Exception as exc:  # noqa: BLE001 - environment failures exit 2 for TypeScript infrastructure handling
            traceback.print_exc()
            payload = {"problem": atom_args.problem, "kernel": atom_args.kernel,
                       "passed": False, "error": f"{type(exc).__name__}: {exc}"[:4000]}
            _emit(Path(atom_args.out), payload)
            return 2
        _emit(Path(atom_args.out), payload)
        return 0
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    request = json.load(sys.stdin)
    result = {"schemaVersion": 1, "candidateSha256": request["candidateSha256"],
              "referenceKind": request["referenceKind"], "timingScope": "all-device-kernels",
              "referenceMs": None, "candidateMs": None, "speedup": None}
    if "contract" in request:
        strict = load_module(Path(__file__).with_name("strict.py"), "kernel_strict")
        result["assessment"] = strict.new_assessment(request)
        request["_assessment"] = result["assessment"]
    # Route external profiler output to diagnostics rather than the result channel.
    with output.with_suffix(".log").open("w") as log, native_output(log):
        try:
            result.update(evaluate(request, output.parent))
        except CandidateError as exc:
            traceback.print_exc()
            result.update(status="candidate_error", error=str(exc)[:4000])
        except Exception as exc:
            traceback.print_exc()
            result.update(status="infrastructure_error", error=f"{type(exc).__name__}: {exc}"[:4000])
            if "assessment" in result:
                result["assessment"]["errorOwnership"] = "evaluation"
    try:
        verify_hashes(request["hashes"])
    except Exception as exc:
        result.update(status="infrastructure_error", error=f"Locked source validation failed: {exc}"[:4000],
                      referenceMs=None, candidateMs=None, speedup=None)
        if "assessment" in result:
            result["assessment"]["errorOwnership"] = "evaluation"
    encoded = json.dumps(result, allow_nan=False)
    temp = output.with_suffix(".tmp")
    temp.write_text(encoded + "\n")
    os.replace(temp, output)
    sys.stdout.write(encoded + "\n")


if __name__ == "__main__":
    sys.exit(main())
