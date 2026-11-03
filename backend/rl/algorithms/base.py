"""Abstract base class defining the reinforcement learning agent interface."""

from abc import ABC, abstractmethod
from typing import Any, Dict, List


class BaseAgent(ABC):
    """Common interface that all The-ReaL-Exit RL agents implement."""

    id: str

    @abstractmethod
    def act(self, observation: List[float], state_key: str, explore: bool = True) -> Dict[str, Any]:
        """Select an action given the current observation and state key.

        Returns a dictionary with 'action' (int) and 'probability' (float).
        """
        pass

    @abstractmethod
    def observe(self, transition: Dict[str, Any]) -> None:
        """Record an environment transition (state, action, reward, next_state, done)."""
        pass

    @abstractmethod
    def end_episode(self) -> None:
        """Hook called at the end of an episode."""
        pass

    @abstractmethod
    def serialize(self) -> Dict[str, Any]:
        """Serialize agent weights and learned state to a JSON-compatible dictionary."""
        pass

    @property
    @abstractmethod
    def action_count(self) -> int:
        """Number of discrete actions available."""
        pass

