"""Algorithm registry mapping algorithm IDs to modules and metadata."""

from typing import Any, Dict, List

from backend.rl.algorithms import dqn, ppo, random_agent

ALGORITHM_REGISTRY = [ppo, dqn, random_agent]
DEFAULT_ALGORITHM = "ppo"


def get_algorithm(algorithm_id: str):
    """Retrieve algorithm module by ID, defaulting to PPO if not found."""
    for entry in ALGORITHM_REGISTRY:
        if entry.METADATA["id"] == algorithm_id:
            return entry
    return ALGORITHM_REGISTRY[0]


def get_registry_metadata() -> List[Dict[str, Any]]:
    """Return JSON-serializable list of algorithm metadata for frontend UI."""
    return [entry.METADATA for entry in ALGORITHM_REGISTRY]

