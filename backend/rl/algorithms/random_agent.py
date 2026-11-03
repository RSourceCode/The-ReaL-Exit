"""Uniform random policy baseline agent."""

import math
from typing import Any, Dict, List, Optional

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
        raw_state = checkpoint.get("state") if checkpoint else cfg.get("seed", 17)
        self.state = int(raw_state) & 0xFFFFFFFF

    def _random(self) -> float:
        self.state = (1664525 * self.state + 1013904223) & 0xFFFFFFFF
        return self.state / 0x100000000

    def act(self, observation: List[float], state_key: str, explore: bool = True) -> Dict[str, Any]:
        action = math.floor(self._random() * len(ACTIONS))
        return {"action": action, "probability": 1.0 / len(ACTIONS)}

    def observe(self, transition: Dict[str, Any]) -> None:
        pass

    def end_episode(self) -> None:
        pass

    def serialize(self) -> Dict[str, Any]:
        return {"state": self.state}

    @property
    def action_count(self) -> int:
        return len(ACTIONS)


def create_agent(config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None) -> RandomAgent:
    """Factory creating a RandomAgent."""
    return RandomAgent(config, checkpoint)

