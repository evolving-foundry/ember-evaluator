import importlib.util
from pathlib import Path
import unittest
from contextlib import contextmanager
from types import ModuleType
from unittest.mock import patch


@contextmanager
def triton_errors(mlir=True):
    # Triton is optional in CPU-only checks; reproduce the installed sibling exception hierarchy.
    root, compiler, errors = (ModuleType(name) for name in (
        "triton", "triton.compiler", "triton.compiler.errors"))
    class TritonError(Exception): pass
    class CompilationError(TritonError): pass
    class MLIRCompilationError(TritonError): pass
    errors.CompilationError = CompilationError
    if mlir: errors.MLIRCompilationError = MLIRCompilationError
    compiler.errors = errors
    root.compiler = compiler
    with patch.dict("sys.modules", {"triton": root, "triton.compiler": compiler,
                                    "triton.compiler.errors": errors}):
        yield errors

path = Path(__file__).resolve().parents[2] / 'src/plugins/benchmarks/operator/kernel/runtime/strict.py'
spec = importlib.util.spec_from_file_location('kernel_strict', path)
strict = importlib.util.module_from_spec(spec)
spec.loader.exec_module(strict)

class Storage:
    def __init__(self, pointer): self.pointer = pointer
    def data_ptr(self): return self.pointer

class Tensor:
    def __init__(self, shape, pointer, contiguous=True, dtype='torch.float16', device='npu:0'):
        self.shape, self.pointer, self.contiguous, self.dtype, self.device = shape, pointer, contiguous, dtype, device
    def is_contiguous(self): return self.contiguous
    def untyped_storage(self): return Storage(self.pointer)
    def stride(self):
        stride, result = 1, []
        for dimension in reversed(self.shape):
            result.insert(0, stride); stride *= dimension
        return tuple(result)

class Torch:
    Tensor = Tensor

class StrictTests(unittest.TestCase):
    def test_output_contract_uses_original_storage_and_layout(self):
        contract = {'shape': [2, 2, 2], 'dtype': 'float16', 'contiguous': True, 'independent': True}
        inp = Tensor([2, 4], 1)
        for output, expected in [(Tensor([2, 2, 2], 2), None), (Tensor([2, 2, 2], 2, False), 'layout'),
                                 (Tensor([2, 2, 2], 1), 'independent-output'), (Tensor([8], 2), 'shape'),
                                 (Tensor([2, 2, 2], 2, dtype='torch.float32'), 'dtype'),
                                 (Tensor([2, 2, 2], 2, device='cpu'), 'device')]:
            failed = strict.output_checks(output, [inp], contract, Torch)
            self.assertEqual(next(iter(failed), None), expected)

    def test_triton_mlir_compilation_errors_are_candidate_owned_without_message_matching(self):
        with triton_errors() as errors:
            self.assertEqual(strict.error_owner(errors.CompilationError('compile failed')), 'candidate')
            self.assertEqual(strict.error_owner(errors.MLIRCompilationError('Failed to run pass plan-memory')), 'candidate')
            # The same compiler-looking text cannot hide an arbitrary driver/resource failure.
            self.assertEqual(strict.error_owner(RuntimeError('MLIRCompilationError: Failed to run pass plan-memory')), 'evaluation')
            self.assertEqual(strict.error_owner(errors.MLIRCompilationError.__bases__[0]('unknown Triton error')), 'evaluation')
            unrelated = type('MLIRCompilationError', (Exception,), {'__module__': 'unrelated.compiler'})
            self.assertEqual(strict.error_owner(unrelated('plan-memory')), 'evaluation')

    def test_optional_mlir_type_does_not_disable_existing_compilation_error_attribution(self):
        with triton_errors(mlir=False) as errors:
            self.assertEqual(strict.error_owner(errors.CompilationError('compile failed')), 'candidate')
            self.assertEqual(strict.error_owner(RuntimeError('device failed')), 'evaluation')

    def test_resource_and_unknown_errors_are_not_candidate_failures(self):
        self.assertEqual(strict.error_owner(SyntaxError('bad')), 'candidate')
        self.assertEqual(strict.error_owner(NameError('bad')), 'candidate')
        for exc in [RuntimeError('device failed'), MemoryError('OOM'), Exception('unknown')]:
            self.assertEqual(strict.error_owner(exc), 'evaluation')


class WorkerCoreTests(unittest.TestCase):
    def run_candidate(self, defect=None, candidate_error=None):
        import copy, contextlib, types, sys
        # Device APIs are test doubles; this exercises the fixed checker, not NPU execution.
        sync_calls = []
        torch = types.SimpleNamespace(Tensor=Tensor, __version__='test-fixture', manual_seed=lambda _: None,
            inference_mode=contextlib.nullcontext, npu=types.SimpleNamespace(is_available=lambda: True,
            set_device=lambda _: None, manual_seed_all=lambda _: None, synchronize=lambda: sync_calls.append(None),
            get_device_name=lambda _: 'test-fixture'))
        inp = Tensor([2, 4], 1); inp.values = [1, 2]
        def output():
            value = Tensor([2, 2, 2], 2); value.values = [1, 2]; return value
        class Model:
            def to(self, _): return self
            def eval(self): return self
            def __call__(self, _):
                value = output()
                if defect == 'reference-shape': value.shape = [8]
                return value
        def candidate(value):
            if candidate_error is not None: raise candidate_error
            actual = output()
            if defect == 'layout': actual.contiguous = False
            if defect == 'alias': actual.pointer = value.pointer
            if defect == 'mutation': value.values[0] = 99
            if defect == 'input-storage': value.pointer = 99
            if defect == 'numerical': actual.values[0] = 99
            if defect == 'runtime': raise RuntimeError('NPU resource failure')
            return actual
        def compare(left, right, *_):
            if isinstance(left, (list, tuple)):
                for a, b in zip(left, right): compare(a, b)
            else:
                if left.values != right.values: raise AssertionError('Tensor values changed')
        request = {'hashes': {}, 'candidate': 'candidate.py', 'problem': 'problem.py', 'dataRoot': '.',
            'contractSha256': 'test-fixture', 'seeds': [42], 'rtol': 0, 'atol': 0, 'warmup': 5, 'repeat': 20,
            'contract': {'inputs': [{'shape': [2,4], 'dtype': 'float16', 'contiguous': True}],
                'output': {'shape': [2,2,2], 'dtype': 'float16', 'contiguous': True, 'independent': True}, 'inputUnmodified': True}}
        request['_assessment'] = strict.new_assessment(request)
        problem = types.SimpleNamespace(Model=Model, get_inputs=lambda: [copy.deepcopy(inp)])
        timings = []
        def bench(function, **kwargs):
            before = len(sync_calls)
            function(); timings.append({**kwargs, 'synchronizations': len(sync_calls) - before}); return 2 if len(timings) == 1 else 1
        class CandidateError(Exception): pass
        api = {'verify_hashes': lambda _: None, 'npu_device_id': lambda: 0,
            'load_module': lambda *_: types.SimpleNamespace(IS_NPU=True, bench_kernel_ms=bench),
            'load_task_module': lambda path, *_: problem if path == 'problem.py' else types.SimpleNamespace(kernel_function=candidate),
            'clone_tree': lambda v, _: copy.deepcopy(v), 'validate_reference': lambda *_: None,
            'compare_tree': compare, 'positive_measurement': float, 'CandidateError': CandidateError}
        self.last_assessment = request['_assessment']
        self.last_timings = timings
        with patch.dict(sys.modules, {'torch': torch, 'torch_npu': types.SimpleNamespace(__version__='test-fixture')}):
            result = strict.evaluate(request, Path('.'), api)
        return result, request['_assessment'], timings

    def test_both_calls_and_effective_timing_are_observed(self):
        result, assessment, timings = self.run_candidate()
        self.assertEqual(result['status'], 'passed')
        import platform
        self.assertIn(platform.node(), assessment['environment']['device'])
        self.assertTrue(all(c['status'] == 'passed' for c in assessment['checks']))
        self.assertEqual(len(assessment['checks']), 16)
        self.assertEqual([t['active'] for t in timings], [20, 20])
        self.assertEqual([t['synchronizations'] for t in timings], [0, 0], 'The timer owns synchronization symmetrically')
        self.assertTrue(all(t['triton_only'] is False for t in timings))

    def test_side_effects_and_numerical_failures_do_not_reach_timing(self):
        for defect, check in [('mutation', 'input-unmodified'), ('input-storage', 'input-unmodified'), ('numerical', 'numerical'), ('alias', 'independent-output'), ('layout', 'layout')]:
            with self.subTest(defect=defect):
                result, assessment, timings = self.run_candidate(defect)
                self.assertEqual(result['status'], 'incorrect')
                self.assertEqual(assessment['errorOwnership'], 'candidate')
                self.assertTrue(any(c['id'] == check and c['status'] == 'failed' for c in assessment['checks']))
                self.assertTrue(any(c['status'] == 'not-run' for c in assessment['checks']))
                self.assertEqual(timings, [])

    def test_mlir_compilation_failure_marks_candidate_entry_and_never_reaches_timing(self):
        with triton_errors() as errors:
            failure = errors.MLIRCompilationError('Failed to run pass plan-memory')
            with self.assertRaises(Exception) as raised:
                self.run_candidate(candidate_error=failure)
        self.assertEqual(type(raised.exception).__name__, 'CandidateError')
        self.assertIs(raised.exception.__cause__, failure)
        self.assertEqual(self.last_assessment['errorOwnership'], 'candidate')
        self.assertEqual([(c['id'], c['seed'], c['call']) for c in self.last_assessment['checks'] if c['status'] == 'failed'], [('entry', 42, 0)])
        self.assertTrue(all(c['status'] == 'not-run' for c in self.last_assessment['checks'] if c['id'] != 'entry'))
        self.assertEqual(self.last_timings, [])

    def test_reference_metadata_fault_is_an_evaluation_failure(self):
        with self.assertRaisesRegex(ValueError, 'Reference output'):
            self.run_candidate('reference-shape')

    def test_runtime_resource_failure_propagates_to_the_environment_boundary(self):
        with self.assertRaisesRegex(RuntimeError, 'NPU resource'):
            self.run_candidate('runtime')

if __name__ == '__main__': unittest.main()
