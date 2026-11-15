"""Double DQN in numpy: replay memory, target network, Huber loss, Adam."""

import math
from typing import Any, Dict, Optional, Tuple

import numpy as np

from backend.config import ACTIONS, OBSERVATION_SIZE
from backend.rl.algorithms.base import BaseAgent
from backend.rl.nn import Adam, orthogonal

METADATA = {
    "id": "dqn",
    "name": "DQN · Double Q-Network",
    "description": "Off-policy Double DQN with replay memory on the egocentric view. Slower to start than PPO but sample-efficient once warm.",
    "defaults": {
        "learningRate": 0.0005,
        "discount": 0.99,
        "epsilonStart": 1.0,
        "epsilonEnd": 0.03,
        "epsilonDecaySteps": 60000,
        "batchSize": 128,
        "replaySize": 20000,
        "learnStart": 2000,
        "targetSyncSteps": 1500,
        "hidden": 128,
        "parallelInstances": 16,
    },
    "fields": [
        {"key": "learningRate", "label": "Learning rate", "min": 0.00005, "max": 0.005, "step": 0.00005},
        {"key": "discount", "label": "Discount γ", "min": 0.8, "max": 0.999, "step": 0.001},
        {"key": "epsilonStart", "label": "Initial exploration ε", "min": 0.1, "max": 1.0, "step": 0.01},
        {"key": "epsilonEnd", "label": "Final exploration ε", "min": 0.01, "max": 0.4, "step": 0.01},
        {"key": "epsilonDecaySteps", "label": "Exploration decay steps", "min": 1000, "max": 500000, "step": 1000, "integer": True},
        {"key": "batchSize", "label": "Replay batch size", "min": 32, "max": 512, "step": 32, "integer": True},
        {"key": "replaySize", "label": "Replay capacity", "min": 2000, "max": 60000, "step": 1000, "integer": True},
        {"key": "learnStart", "label": "Steps before learning", "min": 500, "max": 20000, "step": 500, "integer": True},
        {"key": "targetSyncSteps", "label": "Target sync interval (steps)", "min": 100, "max": 10000, "step": 100, "integer": True},
        {"key": "hidden", "label": "Hidden units", "min": 32, "max": 512, "step": 32, "integer": True},
        {"key": "parallelInstances", "label": "Parallel environments", "min": 1, "max": 64, "step": 1, "integer": True},
    ],
}

ACTION_COUNT = len(ACTIONS)


class DQNAgent(BaseAgent):
    """Double DQN with a two-hidden-layer ReLU network."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None):
        self.id = METADATA["id"]
        self.h = {**METADATA["defaults"], **(config or {})}
        self.rng = np.random.default_rng(int(self.h.get("seed", 421)))
        hidden = int(self.h["hidden"])

        loaded = checkpoint.get("params") if checkpoint else None
        if loaded and "W1" in loaded and "W3" in loaded and np.asarray(loaded["W1"]).shape == (OBSERVATION_SIZE, hidden):
            self.params = {k: np.asarray(v, dtype=np.float32) for k, v in loaded.items()}
        else:
            self.params = {
                "W1": orthogonal(self.rng, OBSERVATION_SIZE, hidden, math.sqrt(2)),
                "b1": np.zeros(hidden, dtype=np.float32),
                "W2": orthogonal(self.rng, hidden, hidden, math.sqrt(2)),
                "b2": np.zeros(hidden, dtype=np.float32),
                "W3": orthogonal(self.rng, hidden, ACTION_COUNT, 1.0),
                "b3": np.zeros(ACTION_COUNT, dtype=np.float32),
            }
        self.target = {k: v.copy() for k, v in self.params.items()}
        self.opt = Adam(self.params, lr=float(self.h["learningRate"]), max_grad_norm=10.0)

        cap = int(self.h["replaySize"])
        self.cap = cap
        self.r_obs = np.zeros((cap, OBSERVATION_SIZE), dtype=np.float16)
        self.r_next = np.zeros((cap, OBSERVATION_SIZE), dtype=np.float16)
        self.r_act = np.zeros(cap, dtype=np.int64)
        self.r_rew = np.zeros(cap, dtype=np.float32)
        self.r_done = np.zeros(cap, dtype=np.float32)
        self.size = 0
        self.ptr = 0
        self.steps = int(checkpoint.get("steps", 0)) if checkpoint else 0
        self.updates = int(checkpoint.get("updates", 0)) if checkpoint else 0
        self.last_sync = self.steps
        self.last_stats: Dict[str, float] = {}

    def _q(self, x: np.ndarray, p: Dict[str, np.ndarray], keep: bool = False):
        z1 = x @ p["W1"] + p["b1"]
        a1 = np.maximum(z1, 0)
        z2 = a1 @ p["W2"] + p["b2"]
        a2 = np.maximum(z2, 0)
        q = a2 @ p["W3"] + p["b3"]
        return (q, a1, a2) if keep else q

    def epsilon(self) -> float:
        start, end = float(self.h["epsilonStart"]), float(self.h["epsilonEnd"])
        return end + (start - end) * max(0.0, 1.0 - self.steps / float(self.h["epsilonDecaySteps"]))

    def act_batch(self, observations: np.ndarray, explore: bool = True, masks: np.ndarray | None = None) -> Tuple[np.ndarray, Dict[str, Any]]:
        obs = np.asarray(observations, dtype=np.float32)
        q = self._q(obs, self.params)
        if masks is None:
            masks = np.ones((len(obs), ACTION_COUNT), dtype=bool)
        masks = np.asarray(masks, dtype=bool)
        actions = np.where(masks, q, -1e9).argmax(axis=1)
        if explore:
            eps = self.epsilon()
            random_mask = self.rng.random(len(obs)) < eps
            weights = masks.astype(np.float64)
            weights /= weights.sum(axis=1, keepdims=True)
            sampled = np.minimum((weights.cumsum(axis=1) < self.rng.random(len(obs))[:, None]).sum(axis=1), ACTION_COUNT - 1)
            actions = np.where(random_mask, sampled, actions)
        return actions, {"prob": np.full(len(obs), 1.0)}

    def observe_batch(self, obs, actions, extras, rewards, next_obs, terminated, truncated) -> None:
        for i in range(len(obs)):
            j = self.ptr
            self.r_obs[j] = obs[i]
            self.r_next[j] = next_obs[i]
            self.r_act[j] = actions[i]
            self.r_rew[j] = rewards[i]
            self.r_done[j] = 1.0 if terminated[i] else 0.0
            self.ptr = (self.ptr + 1) % self.cap
            self.size = min(self.size + 1, self.cap)
        self.steps += len(obs)
        if self.steps - self.last_sync >= int(self.h["targetSyncSteps"]):
            self.target = {k: v.copy() for k, v in self.params.items()}
            self.last_sync = self.steps

    def maybe_learn(self, current_obs: np.ndarray) -> Dict[str, float] | None:
        batch = int(self.h["batchSize"])
        if self.size < max(batch, int(self.h["learnStart"])):
            return None
        idx = self.rng.integers(0, self.size, batch)
        x = self.r_obs[idx].astype(np.float32)
        nx = self.r_next[idx].astype(np.float32)
        a = self.r_act[idx]
        r = self.r_rew[idx]
        d = self.r_done[idx]
        gamma = float(self.h["discount"])

        # Double DQN target
        best = self._q(nx, self.params).argmax(axis=1)
        q_next = self._q(nx, self.target)[np.arange(batch), best]
        y = r + gamma * (1.0 - d) * q_next

        q, a1, a2 = self._q(x, self.params, keep=True)
        err = q[np.arange(batch), a] - y
        dq = np.zeros_like(q)
        dq[np.arange(batch), a] = np.clip(err, -1.0, 1.0) / batch  # Huber gradient
        p = self.params
        g = {"W3": a2.T @ dq, "b3": dq.sum(axis=0)}
        da2 = (dq @ p["W3"].T) * (a2 > 0)
        g["W2"] = a1.T @ da2
        g["b2"] = da2.sum(axis=0)
        da1 = (da2 @ p["W2"].T) * (a1 > 0)
        g["W1"] = x.T @ da1
        g["b1"] = da1.sum(axis=0)
        self.opt.step({k: v.astype(np.float32) for k, v in g.items()})
        self.updates += 1
        self.last_stats = {"loss": float(np.mean(np.where(np.abs(err) < 1, 0.5 * err ** 2, np.abs(err) - 0.5))), "epsilon": self.epsilon()}
        return self.last_stats

    def serialize(self) -> Dict[str, Any]:
        return {
            "params": {k: v.tolist() for k, v in self.params.items()},
            "steps": self.steps,
            "updates": self.updates,
        }

    @property
    def action_count(self) -> int:
        return ACTION_COUNT


def create_agent(config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None) -> DQNAgent:
    """Factory creating a DQNAgent."""
    return DQNAgent(config, checkpoint)
