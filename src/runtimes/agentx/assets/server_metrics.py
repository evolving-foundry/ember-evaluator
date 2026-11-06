"""Extract evidence from pinned AgentX exports without estimating metric statistics."""
import asyncio
import json
import math


def install_server_metrics_adapter():
    """Preserve collector failures omitted by pinned 1.0.7 exports."""
    from aiperf.server_metrics.data_collector import ServerMetricsDataCollector
    from aiperf.server_metrics.json_exporter import ServerMetricsJsonExporter

    original_export = ServerMetricsJsonExporter._generate_content
    if getattr(original_export, "_evaluator_collection_errors", False):
        return

    fetch = ServerMetricsDataCollector._fetch_parse_send

    async def serial_fetch(self):
        # A phase-boundary scrape can overlap the periodic scrape. Serialize the
        # whole fetch/send cycle so each endpoint's JSONL retains capture order.
        if not hasattr(self, "_evaluator_scrape_lock"):
            self._evaluator_scrape_lock = asyncio.Lock()
        async with self._evaluator_scrape_lock:
            await fetch(self)

    ServerMetricsDataCollector._fetch_parse_send = serial_fetch

    def generate_content(self):
        raw = json.loads(original_export(self))
        # Upstream tracks these failures but omits them from the JSON artifact.
        # No endpoint attribution is available: keep one aggregate count without
        # assigning a failure to every endpoint that has usable statistics.
        results = self._server_metrics_results
        raw["evaluator_collection_error_count"] = sum(item.count for item in results.error_summary) if results else 0
        return json.dumps(raw, indent=2)

    generate_content._evaluator_collection_errors = True
    ServerMetricsJsonExporter._generate_content = generate_content


class CounterWindow:
    """Accumulate sequential scrapes without sorting by an adjustable wall clock."""

    def __init__(self, window):
        self.window = window
        self.previous = None
        self.start = self.end = None
        self.total = 0.0

    def add(self, timestamp, value):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid server counter sample")
        if self.window["start_ns"] <= timestamp <= self.window["end_ns"]:
            if self.start is None:
                self.start = self.previous[0] if self.previous else timestamp
            self.end = timestamp
            if self.previous:
                previous = self.previous[1]
                self.total += value - previous if value >= previous else value
                if not math.isfinite(self.total):
                    raise ValueError("Invalid server counter total")
        self.previous = (timestamp, value)

    def stats(self):
        if self.start is None:
            return None
        seconds = (self.end - self.start) / 1_000_000_000
        rate = self.total / seconds if seconds > 0 else None
        if rate is not None and not math.isfinite(rate):
            raise ValueError("Invalid server counter rate")
        return {"total": self.total, "rate": rate}


def counter_windows(raw, endpoints):
    targets = {}
    ranges = raw["summary"]["phase_time_ranges"]
    for phase, field in (("profiling", "metrics"), ("warmup", "warmup_metrics")):
        window = ranges.get(phase)
        if not window:
            continue
        for name, metric in raw.get(field, {}).items():
            if metric.get("type") != "counter":
                continue
            for series in metric["series"]:
                endpoint = series["endpoint_url"]
                if endpoint in endpoints:
                    key = (endpoint, name, tuple(sorted((series.get("labels") or {}).items())))
                    targets.setdefault(key, []).append((series, CounterWindow(window)))
    return targets


def bridge_metrics(metrics):
    """Send aggregate statistics only; full time series remain in the artifact."""
    if not isinstance(metrics, dict):
        return metrics
    result = {}
    for name, metric in metrics.items():
        if not isinstance(metric, dict) or not isinstance(metric.get("series"), list):
            result[name] = metric
            continue
        series = []
        for item in metric["series"]:
            if not isinstance(item, dict):
                series.append(item)
                continue
            selected = {key: item[key] for key in ("endpoint_url", "labels", "stats") if key in item}
            stats = selected.get("stats")
            if isinstance(stats, dict):
                selected["stats"] = {key: stats[key] for key in ("avg", "min", "max", "total", "rate") if key in stats}
            series.append(selected)
        result[name] = {"type": metric.get("type"), "series": series}
    return result


def read_server_metrics(artifacts, telemetry):
    counts = {source["endpoint"]: {"profiling": 0, "warmup": 0}
              for source in telemetry.values()}
    try:
        files = list(artifacts.rglob("server_metrics_export.json"))
        if len(files) != 1:
            raise ValueError("Expected one server metrics export")
        raw = json.loads(files[0].read_text(encoding="utf-8"))
        ranges = raw["summary"]["phase_time_ranges"]
        counters = counter_windows(raw, counts)
        streams = list(artifacts.rglob("server_metrics_export.jsonl"))
        if len(streams) > 1:
            raise ValueError("Ambiguous server metrics capture order")
        for path in streams:
            with path.open(encoding="utf-8") as stream:
                for line in stream:
                    record = json.loads(line)
                    selected = counts.get(record["endpoint_url"])
                    if selected is None:
                        continue
                    # The pinned collector sends each endpoint's scrapes in capture
                    # order. Wall-clock corrections must not reorder counter values.
                    for name, samples in record.get("metrics", {}).items():
                        for sample in samples:
                            key = (record["endpoint_url"], name, tuple(sorted((sample.get("labels") or {}).items())))
                            for _series, counter in counters.get(key, []):
                                counter.add(record["timestamp_ns"], sample["value"])
                    for phase in selected:
                        window = ranges.get(phase)
                        if window and window["start_ns"] <= record["timestamp_ns"] <= window["end_ns"]:
                            selected[phase] += 1
        for windows in counters.values():
            for series, counter in windows:
                series["stats"] = counter.stats()
        # Preserve nanosecond boundaries exactly across the JSON/JavaScript boundary.
        for window in ranges.values():
            window["start_ns"] = str(window["start_ns"])
            window["end_ns"] = str(window["end_ns"])
        # Never send the duration-dependent timeslices/histograms over stdout.
        # Keep the original JSON and JSONL untouched for offline inspection.
        export = {key: raw[key] for key in
                  ("schema_version", "metrics_phase", "summary", "evaluator_collection_error_count") if key in raw}
        for phase in ("metrics", "warmup_metrics"):
            if phase in raw:
                export[phase] = bridge_metrics(raw[phase])
        return {"export": export, "samples": counts, "error": None}
    except (ValueError, KeyError, OSError, TypeError, OverflowError):
        return {"export": None, "samples": counts,
                "error": "Missing or invalid server metrics export; inspect Harness artifacts"}
