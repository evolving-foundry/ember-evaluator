"""Audit device kernels against CPU-to-NPU flow records without accelerator imports."""
import csv
import hashlib
import io
import json
import math
import re
from decimal import Decimal
from pathlib import Path


def _time(value):
    text = str(value).strip()
    if not re.fullmatch(r'\d+(?:\.\d{1,9})?', text):
        raise ValueError('Invalid trace timestamp or duration')
    return Decimal(text)


def _one(items, name):
    if len(items) != 1:
        raise ValueError(f'Missing or ambiguous {name}')
    return items[0]


def _identity(value, large=False):
    if isinstance(value, str) and value.strip(): return value
    if type(value) is int and value >= 0 and (large or value <= 9007199254740991): return str(value)
    raise ValueError('Missing or invalid trace identity')


def associate_steps(records, trace, total):
    events = json.loads(trace, parse_float=Decimal)
    if isinstance(events, dict): events = events.get('traceEvents')
    if not isinstance(events, list) or any(not isinstance(e, dict) for e in events):
        raise ValueError('Invalid trace events')
    steps = [e for e in events if e.get('ph') == 'X' and re.fullmatch(r'ProfilerStep#\d+', e.get('name', ''))]
    for e in steps:
        _identity(e.get('pid')); _identity(e.get('tid'))
    ids = [int(e['name'].split('#')[1]) for e in steps]
    if len(ids) != total or set(ids) != set(range(total)):
        raise ValueError('Incomplete or duplicate framework steps')

    def contains(container, event, pid=True):
        return (_identity(container.get('tid')) == _identity(event.get('tid'))
                and (not pid or _identity(container.get('pid')) == _identity(event.get('pid')))
                and _time(container['ts']) <= _time(event['ts']) < _time(container['ts']) + _time(container['dur']))

    def flow_source(end):
        identity = _identity(end.get('id'), large=True)
        _identity(end.get('pid')); _identity(end.get('tid'))
        pair = [e for e in events if e.get('ph') in ('s', 'f') and e.get('name') == end.get('name')
                and e.get('cat') == end.get('cat') and _identity(e.get('id'), large=True) == identity]
        _one([e for e in pair if e.get('ph') == 'f'], 'flow end')
        return _one([e for e in pair if e.get('ph') == 's'], 'flow start')

    rows, seen, kernels_seen, devices, trace_devices = [], set(), set(), set(), set()
    for record in records:
        name, device, stream = (record[k].strip() for k in ('Name', 'Device_id', 'Stream ID'))
        start, duration = _time(record['Start Time(us)']), _time(record['Duration(us)'])
        key = (device, stream, name, start, duration)
        if not name or not device or not stream or key in seen:
            raise ValueError('Invalid or duplicate kernel row')
        seen.add(key); devices.add(device)
        matches = [(i, e) for i, e in enumerate(events) if e.get('ph') == 'X' and e.get('name') == name
                   and str(e.get('tid')) == stream and _time(e['ts']) == start and _time(e['dur']) == duration
                   and ('Task ID' not in record or str(e.get('args', {}).get('Task Id')) == record['Task ID'].strip())]
        index, kernel = _one(matches, 'CSV kernel in trace')
        kernels_seen.add(index)
        trace_devices.add(_identity(kernel.get('pid'))); _identity(kernel.get('tid'))
        ends = [e for e in events if e.get('ph') == 'f' and
                (e.get('name') == 'torch_to_npu' or e.get('cat') == 'HostToDevice') and
                e.get('pid') == kernel.get('pid') and e.get('tid') == kernel.get('tid') and _time(e['ts']) == start]
        assigned = set()
        for end in ends:
            source = flow_source(end)
            direct = [s for s in steps if contains(s, source, pid=end.get('name') == 'torch_to_npu')]
            if not direct and end.get('cat') == 'HostToDevice':
                dequeue = _one([e for e in events if e.get('ph') == 'X' and e.get('cat') == 'dequeue'
                                and contains(e, source, pid=False)], 'host dequeue')
                queued = _one([e for e in events if e.get('ph') == 'f' and e.get('name') == 'enqueue_to_dequeue'
                               and e.get('cat') == 'async_task_queue' and e.get('pid') == dequeue.get('pid')
                               and e.get('tid') == dequeue.get('tid') and _time(e['ts']) == _time(dequeue['ts'])], 'queue flow')
                source = flow_source(queued)
                direct = [s for s in steps if contains(s, source)]
            step = _one(direct, 'CPU framework step')
            assigned.add(int(step['name'].split('#')[1]))
        step = _one(list(assigned), 'kernel flow attribution')
        rows.append(dict(step=step, device=device, stream=stream, name=name, startUs=float(start), durationUs=float(duration)))
    compute_types = ('AI_CORE', 'AI_VECTOR_CORE', 'AI_CUBE_CORE', 'AI_CPU', 'MIX_AIC', 'MIX_AIV')
    non_kernel_types = ('MEMCPY_ASYNC', 'MEMCPY_SYNC', 'MEMSET_ASYNC', 'MEMSET_SYNC', 'PLACE_HOLDER_SQE')
    flow_targets = [e for e in events if e.get('ph') == 'f'
                    and (e.get('name') == 'torch_to_npu' or e.get('cat') == 'HostToDevice')]
    required_kernels = {i for i, e in enumerate(events) if e.get('ph') == 'X' and
                        (e.get('args', {}).get('Task Type') in compute_types or
                         (e.get('args', {}).get('Task Type') not in non_kernel_types and
                          any(f.get('pid') == e.get('pid') and f.get('tid') == e.get('tid') and
                              _time(f['ts']) == _time(e['ts']) for f in flow_targets)))}
    if not required_kernels.issubset(kernels_seen):
        raise ValueError('Trace kernel missing from CSV')
    if {r['step'] for r in rows} != set(range(total)) or len(devices) != 1 or len(trace_devices) != 1:
        raise ValueError('Incomplete iterations or mixed devices')
    chronological = sorted(rows, key=lambda r: r['startUs'])
    if any(a['step'] > b['step'] for a, b in zip(chronological, chronological[1:])):
        raise ValueError('Kernel time order disagrees with flow steps')
    return rows


def collect_flow_timing(directory, warmup, repeat):
    directory = Path(directory)
    csv_file = _one(list(directory.rglob('kernel_details.csv')), 'kernel_details.csv')
    trace_file = _one(list(directory.rglob('trace_view.json')), 'trace_view.json')
    data, trace = csv_file.read_bytes(), trace_file.read_bytes()
    table = csv.DictReader(io.StringIO(data.decode('utf-8-sig')), strict=True)
    headers = table.fieldnames or []
    required = ('Device_id', 'Stream ID', 'Name', 'Start Time(us)', 'Duration(us)')
    if len(set(headers)) != len(headers) or any(k not in headers for k in required):
        raise ValueError('Invalid kernel identity/timing columns')
    records = list(table)
    if any(None in r or any(r.get(k) is None for k in headers) for r in records):
        raise ValueError('Incomplete CSV record')
    if warmup < 1 or repeat < 1: raise ValueError('Invalid timing protocol')
    rows = associate_steps(records, trace, warmup + repeat)
    mean = math.fsum(r['durationUs'] for r in rows if r['step'] >= warmup) / repeat / 1000
    if not math.isfinite(mean) or mean <= 0: raise ValueError('Invalid mean duration')
    return dict(csvPath=csv_file.relative_to(directory.parent).as_posix(), csvSha256=hashlib.sha256(data).hexdigest(),
                tracePath=trace_file.relative_to(directory.parent).as_posix(), traceSha256=hashlib.sha256(trace).hexdigest(),
                warmup=warmup, repeat=repeat, meanMs=mean, rows=rows)
