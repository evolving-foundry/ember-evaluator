"""Audit full replay using the official export's original WEKA coordinates."""
from collections import Counter
import json
from pathlib import Path


def selected_requests(path, trace_count):
    expected = {}
    with Path(path).open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            trace = json.loads(line)
            trace_id = trace["id"]
            if trace_id in expected:
                raise ValueError("Duplicate trace id in replay selection")
            keys = set()
            for outer_index, item in enumerate(trace["requests"]):
                if item["type"] == "subagent":
                    for inner_index, _request in enumerate(item["requests"]):
                        keys.add((trace_id, outer_index, inner_index))
                else:
                    keys.add((trace_id, outer_index, None))
            if not keys:
                raise ValueError("Empty trace in replay selection")
            expected[trace_id] = keys
            if len(expected) == trace_count:
                break
    if len(expected) != trace_count:
        raise ValueError("Requested traceCount exceeds locked corpus size")
    return expected


def audit_replay(expected, export_paths):
    all_expected = set().union(*expected.values())
    seen = Counter()
    cancelled = set()
    failed = successful_count = cancelled_count = unexpected = 0
    for path in export_paths:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                record = json.loads(line)
                meta = record.get("metadata", {})
                if meta.get("benchmark_phase") != "profiling":
                    continue
                key = (meta.get("source_trace_id"), meta.get("source_outer_idx"), meta.get("source_inner_idx"))
                if key not in all_expected:
                    unexpected += 1
                    continue
                seen[key] += 1
                if meta.get("was_cancelled"):
                    cancelled.add(key)
                    cancelled_count += 1
                elif record.get("error") or meta.get("context_overflow_skip"):
                    failed += 1
                else:
                    successful_count += 1
    traces = [{"traceId": trace_id, "expectedRequests": len(keys),
               "observedRequests": sum(seen[key] for key in keys),
               "missingRequests": sum(seen[key] == 0 for key in keys),
               "duplicateRequests": sum(max(0, seen[key] - 1) for key in keys),
               "complete": all(seen[key] == 1 and key not in cancelled for key in keys)}
              for trace_id, keys in expected.items()]
    summary = {"schemaVersion": 1, "selectedTraces": len(expected),
               "completedTraces": sum(trace["complete"] for trace in traces),
               "expectedRequests": len(all_expected), "observedRequests": sum(seen.values()),
               "successfulRequests": successful_count, "failedRequests": failed,
               "cancelledRequests": cancelled_count, "missingRequests": sum(seen[key] == 0 for key in all_expected),
               "duplicateRequests": sum(max(0, count - 1) for count in seen.values()),
               "unexpectedRequests": unexpected,
               "complete": all(trace["complete"] for trace in traces) and unexpected == 0}
    return summary, traces
