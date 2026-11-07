import contextlib
import importlib.util
import os
from pathlib import Path
import random
import sys
import types
import unittest
from unittest.mock import patch

runtime = Path(__file__).resolve().parents[2] / 'src/plugins/benchmarks/operator/kernel/runtime'
sys.path.insert(0, str(runtime))
spec = importlib.util.spec_from_file_location('kernel_profile_replay', runtime / 'msprof_replay.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReplayFixture:
    def __init__(self, warmup=3, tool_id=0x1001, range_id=0, failure=None,
                 observed_device=0, device_count=1, missing_mstx=False):
        self.events, self.calls, self.seeds = [], [], []
        self.warmup = warmup
        self.syncs = 0
        self.failure = failure
        self.mstx = None if missing_mstx else types.SimpleNamespace(
            get_tool_id=lambda: tool_id,
            range_start=lambda message, stream: self.start(message, stream, range_id),
            range_end=lambda value: self.events.append(('end', value)))
        npu = types.SimpleNamespace(is_available=lambda: True, set_device=lambda _: None,
            manual_seed_all=lambda seed: self.seeds.append(('npu', seed)), synchronize=self.synchronize,
            get_device_name=lambda _: 'fixture950', current_device=lambda: observed_device,
            device_count=lambda: device_count)
        self.torch = types.SimpleNamespace(npu=npu,
            manual_seed=lambda seed: self.seeds.append(('torch', seed)), inference_mode=contextlib.nullcontext)
        class Model:
            def __init__(self, init): random.random()
            def to(self, _): return self
            def eval(self): return self
        self.problem = types.SimpleNamespace(Model=Model, get_init_inputs=lambda: [random.random()],
            get_inputs=lambda: [random.random()])
        self.candidate = types.SimpleNamespace(kernel_function=self.call)
        self.request = {'hashes': {}, 'problem': 'p', 'candidate': 'c', 'dataRoot': '.',
            'seeds': [42], 'warmup': warmup}

    def start(self, message, stream, range_id):
        self.events.append(('start', message, stream))
        return range_id

    def call(self, value):
        self.events.append('candidate')
        self.calls.append(value)
        if self.failure == 'candidate' and len(self.calls) == self.warmup + 1:
            raise RuntimeError('fixture formal candidate failure')

    def synchronize(self):
        self.events.append('sync')
        self.syncs += 1
        if self.failure == 'sync' and self.syncs == 2:
            raise RuntimeError('fixture formal sync failure')

    def run(self):
        def load(path, *_): return self.problem if path == 'p' else self.candidate
        with patch.dict(os.environ, {'KERNEL_NPU_DEVICE': '0'}), \
                patch.dict(sys.modules, {'torch': self.torch, 'torch_npu': types.SimpleNamespace(), 'mstx': self.mstx}), \
                patch.object(module, 'verify_hashes'), patch.object(module, 'load_task_module', side_effect=load), \
                patch.object(module, 'observe_environment', side_effect=lambda _t, _n, device: {'device': f'fixture950 logical={device}'}):
            return module.replay(self.request)


class ReplayTests(unittest.TestCase):
    def test_frozen_seed_warmup_and_reference_rng_order_reach_candidate(self):
        fixture = ReplayFixture()
        result = fixture.run()
        expected = random.Random(42)
        expected.random(); expected.random()
        self.assertEqual(fixture.calls, [expected.random()] * 4)
        self.assertEqual(fixture.seeds, [('torch', 42), ('npu', 42)])
        self.assertEqual(result['seed'], 42)
        self.assertEqual(result['warmup'], 3)
        self.assertEqual(result['environment'], {'device': 'fixture950 logical=0'})

    def test_only_formal_call_after_completed_warmup_is_inside_mstx(self):
        fixture = ReplayFixture(warmup=25)
        result = fixture.run()
        self.assertEqual(fixture.events, ['candidate'] * 25 + [
            'sync', ('start', 'rsi_operator_profile', None), 'candidate', 'sync', ('end', 0)])
        self.assertEqual(result['capture'], {'method': 'mstx', 'range': 'rsi_operator_profile',
            'toolId': 0x1001, 'rangeId': 0, 'warmupCompleted': 25, 'callsInRange': 1})

    def test_capture_closes_when_formal_candidate_or_sync_fails(self):
        for failure in ('candidate', 'sync'):
            with self.subTest(failure=failure):
                fixture = ReplayFixture(failure=failure)
                with self.assertRaisesRegex(RuntimeError, f'fixture formal {failure} failure'):
                    fixture.run()
                self.assertEqual(fixture.events[-1], ('end', 0))
                self.assertEqual(fixture.events.count(('start', 'rsi_operator_profile', None)), 1)

    def test_missing_or_inactive_mstx_fails_before_candidate_execution(self):
        for fixture in (ReplayFixture(tool_id=0), ReplayFixture(missing_mstx=True)):
            with self.subTest(mstx=fixture.mstx):
                with self.assertRaisesRegex(RuntimeError, 'MSTX'):
                    fixture.run()
                self.assertEqual(fixture.calls, [])
                self.assertEqual(fixture.events, [])

    def test_invalid_range_id_is_rejected_without_formal_candidate(self):
        fixture = ReplayFixture(range_id=-1)
        with self.assertRaisesRegex(RuntimeError, 'MSTX range'):
            fixture.run()
        self.assertEqual(len(fixture.calls), 3)
        self.assertNotIn(('end', -1), fixture.events)

    def test_observed_device_fields_come_from_runtime_queries(self):
        result = ReplayFixture(observed_device=2, device_count=4).run()
        self.assertEqual(result['requestedLogicalDevice'], 0)
        self.assertEqual(result['logicalDevice'], 2)
        self.assertEqual(result['deviceCount'], 4)
        self.assertEqual(result['environment'], {'device': 'fixture950 logical=2'})

    def test_multiple_seeds_and_invalid_warmup_rejected_before_device_import(self):
        for seeds, warmup in [([0, 42], 25), ([], 25), ([42], 0), ([True], 25)]:
            with self.assertRaises(ValueError): module.replay({'seeds': seeds, 'warmup': warmup})


if __name__ == '__main__': unittest.main()
