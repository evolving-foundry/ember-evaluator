"""Deterministic selection of already deployed execution nodes; no cluster mutations."""
import math


class RayNodeSelectionError(ValueError):
    def __init__(self, requested, available):
        self.requested = requested
        self.available = available
        super().__init__(f"Requested {requested} Ray execution nodes; only {available} eligible")


def node_capacity(node):
    resources = node.get("Resources", {})
    return max(0, math.floor(min(resources.get("CPU", 0), resources.get("evaluator_slot", 0))))


def select_nodes(nodes, count=None):
    eligible = [node for node in nodes if node.get("Alive") and node_capacity(node) > 0]
    eligible.sort(key=lambda node: (-node_capacity(node), node["NodeID"]))
    if count is not None:
        if isinstance(count, bool) or not isinstance(count, int) or count < 1:
            raise ValueError("Ray nodes must be a positive integer")
        if count > len(eligible):
            raise RayNodeSelectionError(count, len(eligible))
        eligible = eligible[:count]
    if not eligible:
        raise RayNodeSelectionError(count or 1, 0)
    return eligible
