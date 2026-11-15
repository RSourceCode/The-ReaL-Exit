"""Abstract base class defining the reinforcement learning agent interface.

Agents are *batched*: the trainer steps many environments at once and hands the agent a
``(N, OBSERVATION_SIZE)`` float32 array, so one neural-network forward pass serves all
environments.  ``act`` (single observation) is a thin wrapper kept for evaluation and
in-game playback.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, Tuple

import numpy as np


class BaseAgent(ABC):
    """Common interface that all The-ReaL-Exit RL agents implement."""

    id: str

    @abstractmethod
    def act_batch(self, observations: np.ndarray, explore: bool = True, masks: np.ndarray | None = None) -> Tuple[np.ndarray, Dict[str, Any]]:
        """Pick one action per row of ``observations`` (``masks`` = bool valid-action mask per row)."""

    def act(self, observation, state_key: str = "", explore: bool = True, mask=None) -> Dict[str, Any]:
        """Single-observation convenience wrapper (evaluation / playback)."""
        obs = np.asarray(observation, dtype=np.float32).reshape(1, -1)
        masks = None if mask is None else np.asarray(mask, dtype=bool).reshape(1, -1)
        actions, extras = self.act_batch(obs, explore, masks)
        return {"action": int(actions[0]), "probability": float(extras.get("prob", [1.0])[0])}

    @abstractmethod
    def observe_batch(self, obs, actions, extras, rewards, next_obs, terminated, truncated) -> None:
        """Record one vectorised transition (all arrays have a leading N dimension)."""

    @abstractmethod
    def maybe_learn(self, current_obs: np.ndarray) -> Dict[str, float] | None:
        """Run a learning update if enough data has been collected."""

    def set_progress(self, fraction: float) -> None:
        """Training progress in [0, 1] (used for learning-rate / entropy annealing)."""

    def end_episode(self) -> None:
        """Hook called at the end of an episode."""

    @abstractmethod
    def serialize(self) -> Dict[str, Any]:
        """Serialize agent weights and learned state to a JSON-compatible dictionary."""

    @property
    @abstractmethod
    def action_count(self) -> int:
        """Number of discrete actions available."""
