"""Deep Q-Network (DQN) with experience replay, target network, and Huber loss."""

import math
from typing import Any, Dict, List, Optional, Tuple

from backend.config import ACTIONS, OBSERVATION_SIZE
from backend.rl.algorithms.base import BaseAgent

METADATA = {
    "id": "dqn",
    "name": "DQN · Replay Q-Network",
    "description": "Off-policy value learning with a small neural Q-network and replay memory.",
    "defaults": {
        "learningRate": 0.001,
        "discount": 0.99,
        "epsilonStart": 1.0,
        "epsilonEnd": 0.05,
        "epsilonDecaySteps": 12000,
        "batchSize": 32,
        "replaySize": 5000,
        "trainEvery": 4,
        "targetSyncSteps": 250,
    },
    "fields": [
        {"key": "learningRate", "label": "Learning rate", "min": 0.0001, "max": 0.01, "step": 0.0001},
        {"key": "discount", "label": "Discount γ", "min": 0.8, "max": 0.999, "step": 0.001},
        {"key": "epsilonStart", "label": "Initial exploration ε", "min": 0.1, "max": 1.0, "step": 0.01},
        {"key": "epsilonEnd", "label": "Final exploration ε", "min": 0.01, "max": 0.4, "step": 0.01},
        {"key": "epsilonDecaySteps", "label": "Exploration decay steps", "min": 500, "max": 100000, "step": 500, "integer": True},
        {"key": "batchSize", "label": "Replay batch size", "min": 8, "max": 128, "step": 8, "integer": True},
        {"key": "replaySize", "label": "Replay capacity", "min": 500, "max": 20000, "step": 500, "integer": True},
        {"key": "trainEvery", "label": "Train every N steps", "min": 1, "max": 16, "step": 1, "integer": True},
        {"key": "targetSyncSteps", "label": "Target sync interval", "min": 50, "max": 2000, "step": 50, "integer": True},
    ],
}

HIDDEN = 32
ACTION_COUNT = len(ACTIONS)


class ParamTensor:
    """Stores tensor weights alongside first and second moment vectors for Adam."""

    def __init__(self, length: int, random_fn=None, scale: float = 0.0):
        if random_fn and scale > 0:
            self.data = [(random_fn() * 2.0 - 1.0) * scale for _ in range(length)]
        else:
            self.data = [0.0] * length
        self.m = [0.0] * length
        self.v = [0.0] * length


class DQNAgent(BaseAgent):
    """Neural Q-learning agent with replay memory and Adam optimizer."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None):
        self.id = METADATA["id"]
        self.h = {**METADATA["defaults"], **(config or {})}

        raw_seed = checkpoint.get("randomState") if checkpoint else self.h.get("seed", 421)
        self.random_state = int(raw_seed) & 0xFFFFFFFF

        if checkpoint and "params" in checkpoint:
            self.params: List[ParamTensor] = []
            for p in checkpoint["params"]:
                tensor = ParamTensor(len(p["data"]))
                tensor.data = [float(x) for x in p["data"]]
                tensor.m = [float(x) for x in p.get("m", [0.0] * len(p["data"]))]
                tensor.v = [float(x) for x in p.get("v", [0.0] * len(p["data"]))]
                self.params.append(tensor)
        else:
            self.params = [
                ParamTensor(HIDDEN * OBSERVATION_SIZE, self._random, 0.12),
                ParamTensor(HIDDEN, self._random, 0.0),
                ParamTensor(ACTION_COUNT * HIDDEN, self._random, 0.12),
                ParamTensor(ACTION_COUNT, self._random, 0.0),
            ]

        # Target network weights
        self.target_params = [list(p.data) for p in self.params]
        self.replay: List[Dict[str, Any]] = list(checkpoint.get("replay", [])) if checkpoint else []
        self.steps = int(checkpoint.get("steps", 0)) if checkpoint else 0
        self.updates = int(checkpoint.get("updates", 0)) if checkpoint else 0
        self.last_target_sync = int(checkpoint.get("lastTargetSync", 0)) if checkpoint else 0
        self.beta1_power = 1.0
        self.beta2_power = 1.0

    def _random(self) -> float:
        self.random_state = (1664525 * self.random_state + 1013904223) & 0xFFFFFFFF
        return self.random_state / 0x100000000

    def _forward(self, obs: List[float], weights: Optional[List[Any]] = None) -> Tuple[List[float], List[float], List[float]]:
        """Compute feedforward activation values: (q_values, pre_activation, hidden)."""
        w1, b1, w2, b2 = weights if weights is not None else self.params
        w1_data = w1.data if hasattr(w1, "data") else w1
        b1_data = b1.data if hasattr(b1, "data") else b1
        w2_data = w2.data if hasattr(w2, "data") else w2
        b2_data = b2.data if hasattr(b2, "data") else b2

        pre = [0.0] * HIDDEN
        hidden = [0.0] * HIDDEN
        for j in range(HIDDEN):
            val = b1_data[j]
            offset = j * OBSERVATION_SIZE
            for k in range(OBSERVATION_SIZE):
                obs_k = obs[k] if k < len(obs) else 0.0
                val += w1_data[offset + k] * obs_k
            pre[j] = val
            hidden[j] = max(0.0, val)

        q = [0.0] * ACTION_COUNT
        for a in range(ACTION_COUNT):
            val = b2_data[a]
            offset = a * HIDDEN
            for j in range(HIDDEN):
                val += w2_data[offset + j] * hidden[j]
            q[a] = val

        return q, pre, hidden

    def _learn_batch(self) -> None:
        """Sample a batch from experience replay and perform an Adam gradient update."""
        batch_size = int(self.h["batchSize"])
        if len(self.replay) < batch_size:
            return

        grads = [[0.0] * len(p.data) for p in self.params]

        for _ in range(batch_size):
            idx = math.floor(self._random() * len(self.replay))
            t = self.replay[idx]

            q_cur, pre, hidden = self._forward(t["obs"])
            q_next, _, _ = self._forward(t["nextObs"], self.target_params)

            target = t["reward"] + (0.0 if t["done"] else self.h["discount"] * max(q_next))
            error = q_cur[t["action"]] - target

            # Huber gradient
            grad_out = [0.0] * ACTION_COUNT
            grad_out[t["action"]] = max(-1.0, min(1.0, error))

            # Gradients for layer 2
            for a in range(ACTION_COUNT):
                grads[3][a] += grad_out[a]
                offset = a * HIDDEN
                for j in range(HIDDEN):
                    grads[2][offset + j] += grad_out[a] * hidden[j]

            # Gradients for layer 1
            w2_data = self.params[2].data
            for j in range(HIDDEN):
                grad_hidden = sum(w2_data[a * HIDDEN + j] * grad_out[a] for a in range(ACTION_COUNT))
                if pre[j] <= 0:
                    continue
                grads[1][j] += grad_hidden
                offset = j * OBSERVATION_SIZE
                for k in range(OBSERVATION_SIZE):
                    obs_k = t["obs"][k] if k < len(t["obs"]) else 0.0
                    grads[0][offset + k] += grad_hidden * obs_k

        self.updates += 1
        self.beta1_power *= 0.9
        self.beta2_power *= 0.999
        lr = float(self.h["learningRate"])

        for p_idx, param in enumerate(self.params):
            g_vec = grads[p_idx]
            for i in range(len(param.data)):
                g = g_vec[i] / batch_size
                param.m[i] = 0.9 * param.m[i] + 0.1 * g
                param.v[i] = 0.999 * param.v[i] + 0.001 * g * g
                m_hat = param.m[i] / (1.0 - self.beta1_power)
                v_hat = param.v[i] / (1.0 - self.beta2_power)
                param.data[i] -= lr * m_hat / (math.sqrt(v_hat) + 1e-8)

    def act(self, observation: List[float], state_key: str, explore: bool = True) -> Dict[str, Any]:
        decay_steps = float(self.h["epsilonDecaySteps"])
        eps_start = float(self.h["epsilonStart"])
        eps_end = float(self.h["epsilonEnd"])
        epsilon = eps_end + (eps_start - eps_end) * max(0.0, 1.0 - self.steps / decay_steps)

        if explore and self._random() < epsilon:
            action = math.floor(self._random() * ACTION_COUNT)
            prob = epsilon / ACTION_COUNT
        else:
            q, _, _ = self._forward(observation)
            best_q = max(q)
            tied = [a for a, val in enumerate(q) if abs(val - best_q) < 1e-9]
            action = tied[math.floor(self._random() * len(tied))]
            prob = 1.0 - epsilon + (epsilon / ACTION_COUNT)

        return {"action": action, "probability": prob}

    def observe(self, transition: Dict[str, Any]) -> None:
        self.replay.append({
            "obs": list(transition["observation"]),
            "action": int(transition["action"]),
            "reward": float(transition["reward"]),
            "nextObs": list(transition["nextObservation"]),
            "done": bool(transition["done"]),
        })

        if len(self.replay) > int(self.h["replaySize"]):
            self.replay.pop(0)

        self.steps += 1
        if self.steps - self.last_target_sync >= int(self.h["targetSyncSteps"]):
            self.target_params = [list(p.data) for p in self.params]
            self.last_target_sync = self.steps

        if self.steps % int(self.h["trainEvery"]) == 0:
            self._learn_batch()

    def end_episode(self) -> None:
        pass

    def serialize(self) -> Dict[str, Any]:
        return {
            "params": [{"data": list(p.data), "m": list(p.m), "v": list(p.v)} for p in self.params],
            "steps": self.steps,
            "updates": self.updates,
            "lastTargetSync": self.last_target_sync,
            "randomState": self.random_state,
            "replay": self.replay[-500:],
        }

    @property
    def action_count(self) -> int:
        return ACTION_COUNT


def create_agent(config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None) -> DQNAgent:
    """Factory creating a DQNAgent."""
    return DQNAgent(config, checkpoint)

