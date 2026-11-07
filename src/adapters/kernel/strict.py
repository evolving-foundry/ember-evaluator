"""Strict kernel checks. No accelerator import is performed at module load."""
import importlib.metadata
import os
import platform
import random
import sys
from pathlib import Path

CHECKS = ('entry', 'shape', 'dtype', 'device', 'layout', 'independent-output', 'input-unmodified', 'numerical')


def error_owner(exc):
    # Arbitrary runtime/device/resource exceptions have no safe candidate attribution.
    if isinstance(exc, (SyntaxError, NameError, AttributeError, TypeError)): return 'candidate'
    try:
        from triton.compiler.errors import CompilationError
    except ImportError:
        return 'evaluation'
    if isinstance(exc, CompilationError): return 'candidate'
    try:
        # Triton-Ascend raises this sibling type for candidate MLIR pass failures.
        from triton.compiler.errors import MLIRCompilationError
    except ImportError:
        return 'evaluation'
    return 'candidate' if isinstance(exc, MLIRCompilationError) else 'evaluation'


def new_assessment(request):
    return {'schemaVersion': 1, 'contractSha256': request['contractSha256'],
            'checks': [{'id': name, 'seed': seed, 'call': call, 'status': 'not-run', 'message': ''}
                       for seed in request['seeds'] for call in range(2) for name in CHECKS],
            'effectiveProtocol': {**{key: request[key] for key in ('seeds', 'rtol', 'atol', 'warmup', 'repeat')},
                                  'timingScope': 'all-device-kernels', 'aggregation': 'iteration-mean',
                                  'timingSeed': request['seeds'][-1]},
            'environment': {key: None for key in ('python', 'torch', 'torchNpu', 'triton', 'cann', 'driver', 'device', 'visibleDevices')},
            'errorOwnership': None}


def output_checks(actual, inputs, contract, torch):
    failed = {}
    if not isinstance(actual, torch.Tensor):
        return {key: 'Expected a tensor output' for key in ('shape', 'dtype', 'device', 'layout', 'independent-output')}
    if list(actual.shape) != contract['shape']: failed['shape'] = 'Output shape differs from contract'
    if str(actual.dtype) != 'torch.' + contract['dtype']: failed['dtype'] = 'Output dtype differs from contract'
    if any(str(actual.device) != str(value.device) for value in inputs): failed['device'] = 'Output device differs from input'
    if contract['contiguous'] and not actual.is_contiguous(): failed['layout'] = 'Output is not contiguous'
    if contract['independent'] and any(actual.untyped_storage().data_ptr() == value.untyped_storage().data_ptr() for value in inputs):
        failed['independent-output'] = 'Output shares input storage'
    return failed


def input_identity(value):
    return (tuple(value.shape), tuple(value.stride()), str(value.dtype), str(value.device), value.untyped_storage().data_ptr())


def _version(package):
    try: return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError: return None


def observe_environment(torch, torch_npu, device):
    def read(path):
        try: return Path(path).read_text().strip() or None
        except OSError: return None
    cann_home = os.environ.get('ASCEND_HOME_PATH', '/usr/local/Ascend/ascend-toolkit/latest')
    # Retain actual installed release descriptors; a configured version is not observation.
    return {'python': f'{sys.executable} {platform.python_version()}', 'torch': str(torch.__version__),
            'torchNpu': str(torch_npu.__version__), 'triton': _version('triton-ascend') or _version('triton'),
            'cann': read(f'{cann_home}/version.cfg') or read(f'{cann_home}/aarch64-linux/ascend_toolkit_install.info') or read(f'{cann_home}/x86_64-linux/ascend_toolkit_install.info'),
            'driver': read('/usr/local/Ascend/driver/version.info'),
            'device': f'host={platform.node()} device={torch.npu.get_device_name(device)} logical={device}',
            'visibleDevices': os.environ.get('ASCEND_RT_VISIBLE_DEVICES')}


def evaluate(request, profile_root, api):
    assessment = request['_assessment']
    api['verify_hashes'](request['hashes'])
    import torch
    import torch_npu
    if not torch.npu.is_available(): raise RuntimeError('NPU is required; CPU/GPU fallback is disabled')
    device = api['npu_device_id']()
    torch.npu.set_device(device)
    assessment['environment'] = observe_environment(torch, torch_npu, device)
    timer = api['load_module'](Path('runtime/timing.py'), 'kernel_strict_timer')
    if not timer.IS_NPU: raise RuntimeError('kernel benchmark did not select NPU')
    problem = api['load_task_module'](request['problem'], request['dataRoot'], 'problem')
    seed, call = request['seeds'][0], 0

    def mark(name, message=''):
        check = next(c for c in assessment['checks'] if c['seed'] == seed and c['call'] == call and c['id'] == name)
        check.update(status='failed' if message else 'passed', message=message)

    def invoke(function, inputs, synchronize=True):
        try:
            value = function(*inputs)
            if synchronize: torch.npu.synchronize()
            return value
        except Exception as exc:
            if error_owner(exc) == 'candidate':
                mark('entry', f'{type(exc).__name__}: {exc}')
                assessment['errorOwnership'] = 'candidate'
                raise api['CandidateError'](str(exc)) from exc
            raise

    try:
        candidate = api['load_task_module'](request['candidate'], request['dataRoot'], 'kernel').kernel_function
        if not callable(candidate): raise TypeError('kernel_function must be callable')
    except Exception as exc:
        if error_owner(exc) == 'candidate':
            mark('entry', f'{type(exc).__name__}: {exc}')
            assessment['errorOwnership'] = 'candidate'
            raise api['CandidateError'](str(exc)) from exc
        raise
    with torch.inference_mode():
        for seed in request['seeds']:
            random.seed(seed); torch.manual_seed(seed); torch.npu.manual_seed_all(seed)
            init = problem.get_init_inputs() if hasattr(problem, 'get_init_inputs') else []
            reference = problem.Model(*init).to(f'npu:{device}').eval()
            inputs = problem.get_inputs()
            contract = request['contract']
            if not isinstance(inputs, (list, tuple)) or len(inputs) != len(contract['inputs']): raise ValueError('Input contract differs from reference')
            for value, expected in zip(inputs, contract['inputs']):
                if not isinstance(value, torch.Tensor) or list(value.shape) != expected['shape'] or str(value.dtype) != 'torch.' + expected['dtype'] or str(value.device) != f'npu:{device}' or (expected['contiguous'] and not value.is_contiguous()):
                    raise ValueError('Reference input metadata differs from contract')
            ref_inputs = api['clone_tree'](inputs, torch)
            expected = api['clone_tree'](reference(*ref_inputs), torch)
            torch.npu.synchronize()
            api['validate_reference'](expected, torch)
            output_contract = contract['output']
            if not isinstance(expected, torch.Tensor) or list(expected.shape) != output_contract['shape'] or str(expected.dtype) != 'torch.' + output_contract['dtype'] or str(expected.device) != f'npu:{device}':
                raise ValueError('Reference output metadata differs from contract')
            api['compare_tree'](inputs, ref_inputs, torch, 0, 0)
            for call in range(2):
                trial = api['clone_tree'](inputs, torch)
                original_metadata = [input_identity(value) for value in trial]
                actual = invoke(candidate, trial)
                mark('entry')
                failed = output_checks(actual, trial, contract['output'], torch)
                for name in ('shape', 'dtype', 'device', 'layout', 'independent-output'): mark(name, failed.get(name, ''))
                try:
                    if contract['inputUnmodified']:
                        api['compare_tree'](inputs, trial, torch, 0, 0)
                        if original_metadata != [input_identity(value) for value in trial]:
                            raise AssertionError('Input storage or metadata changed')
                    mark('input-unmodified')
                except (AssertionError, ValueError) as exc: mark('input-unmodified', str(exc))
                try:
                    api['compare_tree'](expected, actual, torch, request['rtol'], request['atol'])
                    mark('numerical')
                except (AssertionError, ValueError) as exc: mark('numerical', str(exc))
                if any(c['status'] == 'failed' for c in assessment['checks']):
                    assessment['errorOwnership'] = 'candidate'
                    api['verify_hashes'](request['hashes'])
                    return {'status': 'incorrect', 'error': 'Strict kernel check failed'}
        reference_audit, candidate_audit = {}, {}
        reference_ms = api['positive_measurement'](timer.bench_kernel_ms(lambda: reference(*inputs), warmup=request['warmup'], active=request['repeat'], prof_dir=str(profile_root / 'profile-reference'), keep_res=True, triton_only=False, audit=reference_audit))
        candidate_ms = api['positive_measurement'](timer.bench_kernel_ms(lambda: invoke(candidate, inputs, synchronize=False), warmup=request['warmup'], active=request['repeat'], prof_dir=str(profile_root / 'profile-candidate'), keep_res=True, triton_only=False, audit=candidate_audit))
    api['verify_hashes'](request['hashes'])
    return {'status': 'passed', 'error': '', 'referenceMs': reference_ms, 'candidateMs': candidate_ms, 'speedup': reference_ms / candidate_ms,
            'timingEvidence': {'schemaVersion': 2, 'method': 'profiler-flow/v1', 'reference': reference_audit, 'candidate': candidate_audit}}
