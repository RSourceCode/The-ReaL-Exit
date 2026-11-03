"""Proximal Policy Optimization (PPO) with clipped surrogate objective and GAE."""

import math
from typing import Any, Dict, List, Optional, Tuple

from backend.config import ACTIONS, OBSERVATION_SIZE
from backend.rl.algorithms.base import BaseAgent

METADATA = {
    "id": "ppo",
    "name": "PPO · Clipped Policy",
    "description": "Stable on-policy learning for the mixed movement and interaction action set.",
    "defaults": {
        "learningRate": 0.08,
        "discount": 0.99,
        "gaeLambda": 0.95,
        "rolloutSteps": 256,
        "epochs": 3,
        "clipRange": 0.2,
        "entropy": 0.015,
    },
    "fields": [
        {"key": "learningRate", "label": "Policy learning rate", "min": 0.005, "max": 0.3, "step": 0.005},
        {"key": "discount", "label": "Discount γ", "min": 0.8, "max": 0.999, "step": 0.001},
        {"key": "gaeLambda", "label": "GAE λ", "min": 0.5, "max": 1, "step": 0.01},
        {"key": "rolloutSteps", "label": "Rollout steps", "min": 32, "max": 1024, "step": 32, "integer": True},
        {"key": "epochs", "label": "Update epochs", "min": 1, "max": 8, "step": 1, "integer": True},
        {"key": "clipRange", "label": "PPO clip range", "min": 0.05, "max": 0.4, "step": 0.01},
        {"key": "entropy", "label": "Entropy bonus", "min": 0, "max": 0.1, "step": 0.001},
    ],
}


def softmax(logits: List[float]) -> List[float]:
    """Compute softmax probabilities from raw logits with numerical stability."""
    max_logit = max(logits)
    exps = [math.exp(v - max_logit) for v in logits]
    total = sum(exps) or 1.0
    return [v / total for v in exps]


def sample_categorical(probabilities: List[float], random_fn) -> int:
    """Sample an index according to discrete probability distribution."""
    val = random_fn()
    for i, p in enumerate(probabilities):
        val -= p
        if val <= 0:
            return i
    return len(probabilities) - 1


class PPOAgent(BaseAgent):
    """Discrete PPO policy agent with tabular state representation and GAE."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None):
        self.id = METADATA["id"]
        self.h = {**METADATA["defaults"], **(config or {})}

        # Migrate and initialize policy & value lookup tables
        self.policy: Dict[str, List[float]] = {}
        self.values: Dict[str, float] = {}
        if checkpoint:
            for k, v in checkpoint.get("policy", []):
                if len(str(k).split(",")) == OBSERVATION_SIZE:
                    self.policy[str(k)] = list(v)
            for k, v in checkpoint.get("values", []):
                if len(str(k).split(",")) == OBSERVATION_SIZE:
                    self.values[str(k)] = float(v)

        self.rollout: List[Dict[str, Any]] = []
        raw_seed = checkpoint.get("randomState") if checkpoint else self.h.get("seed", 1337)
        self.random_state = int(raw_seed) & 0xFFFFFFFF

    def _random(self) -> float:
        self.random_state = (1664525 * self.random_state + 1013904223) & 0xFFFFFFFF
        return self.random_state / 0x100000000

    def _logits_for(self, key: str) -> List[float]:
        if key not in self.policy:
            self.policy[key] = [0.0] * len(ACTIONS)
        return self.policy[key]

    def _value_for(self, key: str) -> float:
        return self.values.get(key, 0.0)

    def learn(self) -> None:
        """Run policy and value updates over collected rollout buffer."""
        if not self.rollout:
            return

        n = len(self.rollout)
        advantages = [0.0] * n
        returns = [0.0] * n
        gae = 0.0

        for i in range(n - 1, -1, -1):
            t = self.rollout[i]
            next_val = 0.0 if t["done"] else self._value_for(t["nextKey"])
            delta = t["reward"] + self.h["discount"] * next_val - self._value_for(t["key"])
            gae = delta + self.h["discount"] * self.h["gaeLambda"] * (0.0 if t["done"] else gae)
            advantages[i] = gae
            returns[i] = gae + self._value_for(t["key"])

        mean = sum(advantages) / n
        variance = sum((a - mean) ** 2 for a in advantages) / n
        std = math.sqrt(variance) + 1e-6

        epochs = int(self.h["epochs"])
        clip_range = float(self.h["clipRange"])
        learning_rate = float(self.h["learningRate"])
        entropy_coeff = float(self.h["entropy"])

        for _ in range(epochs):
            for i in range(n):
                t = self.rollout[i]
                logits = self._logits_for(t["key"])
                probs = softmax(logits)
                advantage = (advantages[i] - mean) / std
                ratio = probs[t["action"]] / max(t["oldProbability"], 1e-8)

                clipped_out = (advantage > 0 and ratio > 1.0 + clip_range) or (
                    advantage < 0 and ratio < 1.0 - clip_range
                )
                if not clipped_out:
                    scale = learning_rate * advantage * ratio / n
                    for a in range(len(logits)):
                        logits[a] += scale * ((1.0 if a == t["action"] else 0.0) - probs[a])

                entropy = -sum(p * math.log(p + 1e-8) for p in probs)
                if entropy_coeff:
                    for a in range(len(logits)):
                        logits[a] += entropy_coeff * probs[a] * (-math.log(probs[a] + 1e-8) - entropy)

                old_val = self._value_for(t["key"])
                self.values[t["key"]] = old_val + min(0.2, learning_rate) * (returns[i] - old_val) / epochs

        self.rollout.clear()

    def act(self, observation: List[float], state_key: str, explore: bool = True) -> Dict[str, Any]:
        probs = softmax(self._logits_for(state_key))
        if explore:
            action = sample_categorical(probs, self._random)
        else:
            best = max(probs)
            tied = [idx for idx, p in enumerate(probs) if abs(p - best) < 1e-12]
            action = tied[math.floor(self._random() * len(tied))]
        return {"action": action, "probability": probs[action]}

    def observe(self, transition: Dict[str, Any]) -> None:
        self.rollout.append(transition)
        if len(self.rollout) >= self.h["rolloutSteps"] or transition["done"]:
            self.learn()

    def end_episode(self) -> None:
        if len(self.rollout) >= self.h["rolloutSteps"]:
            self.learn()

    def serialize(self) -> Dict[str, Any]:
        self.learn()
        return {
            "policy": [[k, list(v)] for k, v in self.policy.items()],
            "values": [[k, v] for k, v in self.values.items()],
            "randomState": self.random_state,
        }

    @property
    def action_count(self) -> int:
        return len(ACTIONS)


def create_agent(config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None) -> PPOAgent:
    """Factory creating a PPOAgent."""
    return PPOAgent(config, checkpoint)

