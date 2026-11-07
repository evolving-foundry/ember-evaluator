import hashlib
import json
import os
from pathlib import Path

from aiperf.dataset.loader.semianalysis_cc_traces_weka import SemiAnalysisCCTracesWekaLoader


class LockedWekaLoader(SemiAnalysisCCTracesWekaLoader):
    """Replace HF transport with verified bytes; inherit all official replay logic."""

    def _load_hf_dataset(self):
        source = json.loads(os.environ["EVALUATOR_AGENTX_SOURCE"])
        if source["dataset"] != self.hf_dataset_name:
            raise ValueError("AgentX source differs from the selected corpus")
        path = Path(source["path"])
        if path.is_symlink() or not path.is_file():
            raise ValueError("AgentX source must be a regular file")
        with path.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != source["sha256"]:
            raise ValueError("AgentX source SHA-256 mismatch")
        with path.open(encoding="utf-8") as stream:
            return [json.loads(line) for line in stream if line.strip()]
