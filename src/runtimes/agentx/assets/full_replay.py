"""Adapt 1.0.7 completion and fixed-window checks for finite source replay."""


def install_full_replay_completion():
    from aiperf.common.enums import CreditPhase
    from aiperf.timing.phase.credit_counter import CreditCounter

    original = CreditCounter.increment_sent
    if getattr(original, "_evaluator_full_replay", False):
        return

    def increment_sent(self, turn):
        index, is_final = original(self, turn)
        if self._config.phase != CreditPhase.PROFILING:
            return index, is_final
        cap = self._config.total_expected_requests
        if cap is None:
            raise ValueError("Full replay requires a source-derived wire request cap")
        # The session cap still gates new roots through StopConditionChecker.
        # 1.0.7 also signals final on the last ROOT credit, which cancels delayed
        # background children in PhaseRunner. Preserve upstream accounting and
        # let only the all-source-request cap close this profiling phase.
        return index, self.requests_sent >= cap

    setattr(increment_sent, "_evaluator_full_replay", True)
    CreditCounter.increment_sent = increment_sent


def install_full_replay_metric_coverage():
    from aiperf.common.enums import CreditPhase
    from aiperf.records.records_manager import RecordsManager

    original = RecordsManager._validate_profile_metric_duration_coverage
    if getattr(original, "_evaluator_full_replay", False):
        return

    def validate(self, phase, cancelled):
        if phase != CreditPhase.PROFILING or cancelled:
            return original(self, phase, cancelled)
        # In finite replay duration is a safety cap. Requiring latency signals
        # throughout that cap rejects an otherwise complete request-count run.
        # Keep measured windows and statistics intact; the bridge separately
        # requires every locked source coordinate exactly once, with no cancel.
        # The caller installs this only for non-comparable full replay.
        self.info("Finite source replay uses request-coordinate coverage; configured duration is a safety cap, not a fixed measurement window")
        return [], []

    setattr(validate, "_evaluator_full_replay", True)
    RecordsManager._validate_profile_metric_duration_coverage = validate
