"""Uniform random policy baseline agent."""

from typing import Any, Dict, Optional, Tuple

import numpy as np

from backend.config import ACTIONS
from backend.rl.algorithms.base import BaseAgent

METADATA = {
    "id": "random",
    "name": "Random · Baseline",
    "description": "Uniform random actions for measuring how much the learned policy improves.",
    "defaults": {"seed": 17},
    "fields": [],
}


class RandomAgent(BaseAgent):
    """Selects actions with uniform random probability."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None):
        cfg = {**METADATA["defaults"], **(config or {})}
        self.id = METADATA["id"]
        self.rng = np.random.default_rng(int(cfg.get("seed", 17)))

    def act_batch(self, observations: np.ndarray, explore: bool = True, masks=None) -> Tuple[np.ndarray, Dict[str, Any]]:
        n = len(observations)
        if masks is None:
            return self.rng.integers(0, len(ACTIONS), size=n), {"prob": np.full(n, 1.0 / len(ACTIONS))}
        weights = np.asarray(masks, dtype=np.float64)
        weights /= weights.sum(axis=1, keepdims=True)
        actions = (weights.cumsum(axis=1) < self.rng.random(n)[:, None]).sum(axis=1)
        return np.minimum(actions, len(ACTIONS) - 1), {"prob": weights[np.arange(n), np.minimum(actions, len(ACTIONS) - 1)]}

    def observe_batch(self, obs, actions, extras, rewards, next_obs, terminated, truncated) -> None:
        pass

    def maybe_learn(self, current_obs):
        return None

    def serialize(self) -> Dict[str, Any]:
        return {}

    @property
    def action_count(self) -> int:
        return len(ACTIONS)


def create_agent(config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None) -> RandomAgent:
    """Factory creating a RandomAgent."""
    return RandomAgent(config, checkpoint)
