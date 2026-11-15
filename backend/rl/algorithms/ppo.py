"""Proximal Policy Optimization (PPO) – a real actor-critic neural network in numpy.

Why this replaces the old tabular PPO: the old policy was a dictionary keyed by a short
string that did not contain the player's position, so every square of the room looked
identical to it.  This version reads the full egocentric observation, shares a two-layer
tanh trunk between the policy and value heads, and uses the standard tricks that make PPO
learn quickly and reliably:

* vectorised environments + GAE(lambda), advantage normalisation
* running **return-based reward scaling** (so edited reward sizes never break training)
* correct handling of time-limit truncation (bootstraps from V(s'))
* clipped surrogate + clipped-free value loss, entropy bonus, global grad-norm clipping
* KL early stopping, learning-rate annealing, orthogonal initialisation
"""

import math
from typing import Any, Dict, Optional, Tuple

import numpy as np

from backend.config import ACTIONS, OBSERVATION_SIZE
from backend.rl.algorithms.base import BaseAgent
from backend.rl.nn import Adam, RunningMeanStd, orthogonal, softmax

METADATA = {
    "id": "ppo",
    "name": "PPO · Actor-Critic Network",
    "description": "Neural-network PPO with GAE on the egocentric view. Recommended: reaches a high clear rate in a few hundred thousand steps.",
    "defaults": {
        "learningRate": 0.001,
        "discount": 0.99,
        "gaeLambda": 0.95,
        "rolloutSteps": 16,
        "epochs": 4,
        "miniBatchSize": 64,
        "clipRange": 0.2,
        "entropy": 0.02,
        "valueCoef": 0.5,
        "hidden": 128,
        "parallelInstances": 16,
        "annealLR": 1,
    },
    "fields": [
        {"key": "learningRate", "label": "Learning rate", "min": 0.00005, "max": 0.003, "step": 0.00005},
        {"key": "discount", "label": "Discount γ", "min": 0.8, "max": 0.999, "step": 0.001},
        {"key": "gaeLambda", "label": "GAE λ", "min": 0.5, "max": 1, "step": 0.01},
        {"key": "rolloutSteps", "label": "Rollout steps per env", "min": 8, "max": 512, "step": 8, "integer": True},
        {"key": "epochs", "label": "Update epochs", "min": 1, "max": 10, "step": 1, "integer": True},
        {"key": "miniBatchSize", "label": "Minibatch size", "min": 64, "max": 4096, "step": 64, "integer": True},
        {"key": "clipRange", "label": "PPO clip range", "min": 0.05, "max": 0.4, "step": 0.01},
        {"key": "entropy", "label": "Entropy bonus", "min": 0, "max": 0.1, "step": 0.001},
        {"key": "hidden", "label": "Hidden units", "min": 32, "max": 512, "step": 32, "integer": True},
        {"key": "parallelInstances", "label": "Parallel environments", "min": 1, "max": 64, "step": 1, "integer": True},
        {"key": "annealLR", "label": "Anneal learning rate (1 = on)", "min": 0, "max": 1, "step": 1, "integer": True},
    ],
}

ACTION_COUNT = len(ACTIONS)


class PPOAgent(BaseAgent):
    """Discrete PPO agent with a shared tanh trunk and policy / value heads."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None):
        self.id = METADATA["id"]
        self.h = {**METADATA["defaults"], **(config or {})}
        seed = int(self.h.get("seed", 1337))
        self.rng = np.random.default_rng(seed)
        hidden = int(self.h["hidden"])

        loaded = checkpoint.get("params") if checkpoint else None
        if loaded and "W1" in loaded and "Wp" in loaded and np.asarray(loaded["W1"]).shape == (OBSERVATION_SIZE, hidden) and np.asarray(loaded["Wp"]).shape[1] == ACTION_COUNT:
            self.params = {k: np.asarray(v, dtype=np.float32) for k, v in loaded.items()}
        else:
            self.params = {
                "W1": orthogonal(self.rng, OBSERVATION_SIZE, hidden, math.sqrt(2)),
                "b1": np.zeros(hidden, dtype=np.float32),
                "W2": orthogonal(self.rng, hidden, hidden, math.sqrt(2)),
                "b2": np.zeros(hidden, dtype=np.float32),
                "Wp": orthogonal(self.rng, hidden, ACTION_COUNT, 0.01),
                "bp": np.zeros(ACTION_COUNT, dtype=np.float32),
                "Wv": orthogonal(self.rng, hidden, 1, 1.0),
                "bv": np.zeros(1, dtype=np.float32),
            }
        self.opt = Adam(self.params, lr=float(self.h["learningRate"]))
        self.base_lr = float(self.h["learningRate"])
        self.ret_rms = RunningMeanStd()
        if checkpoint and "retRms" in checkpoint:
            self.ret_rms.mean, self.ret_rms.var, self.ret_rms.count = checkpoint["retRms"]
        self.progress = 0.0
        self.updates = int(checkpoint.get("updates", 0)) if checkpoint else 0

        self._buf: Dict[str, np.ndarray] = {}
        self._ptr = 0
        self._n_envs = 0
        self._returns_acc: np.ndarray = np.zeros(0)
        self.last_stats: Dict[str, float] = {}

    # ── network ────────────────────────────────────────────────────────────────────────
    def _forward(self, x: np.ndarray, keep: bool = False):
        p = self.params
        a1 = np.tanh(x @ p["W1"] + p["b1"])
        a2 = np.tanh(a1 @ p["W2"] + p["b2"])
        logits = a2 @ p["Wp"] + p["bp"]
        value = (a2 @ p["Wv"] + p["bv"])[:, 0]
        return (logits, value, a1, a2) if keep else (logits, value)

    # ── acting ─────────────────────────────────────────────────────────────────────────
    def act_batch(self, observations: np.ndarray, explore: bool = True, masks: np.ndarray | None = None) -> Tuple[np.ndarray, Dict[str, Any]]:
        obs = np.asarray(observations, dtype=np.float32)
        logits, value = self._forward(obs)
        if masks is None:
            masks = np.ones((len(obs), ACTION_COUNT), dtype=bool)
        masks = np.asarray(masks, dtype=bool)
        probs = softmax(np.where(masks, logits, -1e9))
        if explore:
            u = self.rng.random(len(obs))[:, None]
            actions = np.minimum((probs.cumsum(axis=1) < u).sum(axis=1), ACTION_COUNT - 1)
        else:
            actions = probs.argmax(axis=1)
        chosen = probs[np.arange(len(obs)), actions]
        return actions, {"logp": np.log(chosen + 1e-8), "value": value, "prob": chosen, "mask": masks}

    # ── data collection ────────────────────────────────────────────────────────────────
    def _alloc(self, n_envs: int) -> None:
        t = int(self.h["rolloutSteps"])
        self._n_envs = n_envs
        self._buf = {
            "obs": np.zeros((t, n_envs, OBSERVATION_SIZE), dtype=np.float32),
            "act": np.zeros((t, n_envs), dtype=np.int64),
            "logp": np.zeros((t, n_envs), dtype=np.float32),
            "val": np.zeros((t, n_envs), dtype=np.float32),
            "rew": np.zeros((t, n_envs), dtype=np.float32),
            "end": np.zeros((t, n_envs), dtype=np.float32),
            "mask": np.ones((t, n_envs, ACTION_COUNT), dtype=bool),
        }
        self._returns_acc = np.zeros(n_envs)
        self._ptr = 0

    def observe_batch(self, obs, actions, extras, rewards, next_obs, terminated, truncated) -> None:
        n = len(obs)
        if n != self._n_envs or not self._buf:
            self._alloc(n)
        gamma = float(self.h["discount"])
        rewards = np.asarray(rewards, dtype=np.float64)

        # Running std of discounted returns -> reward scale (robust to custom reward values).
        self._returns_acc = self._returns_acc * gamma + rewards
        self.ret_rms.update(self._returns_acc)
        ended = np.asarray(terminated, dtype=bool) | np.asarray(truncated, dtype=bool)
        self._returns_acc[ended] = 0.0
        scaled = np.clip(rewards / math.sqrt(self.ret_rms.var + 1e-8), -10.0, 10.0)

        trunc_only = np.asarray(truncated, dtype=bool) & ~np.asarray(terminated, dtype=bool)
        if trunc_only.any():  # time-limit cut: bootstrap from the value of the final state
            _, v_final = self._forward(np.asarray(next_obs, dtype=np.float32)[trunc_only])
            scaled[trunc_only] += gamma * v_final

        t = self._ptr
        b = self._buf
        b["obs"][t] = obs
        b["act"][t] = actions
        b["logp"][t] = extras["logp"]
        b["val"][t] = extras["value"]
        b["rew"][t] = scaled
        b["end"][t] = ended
        b["mask"][t] = extras["mask"]
        self._ptr += 1

    def set_progress(self, fraction: float) -> None:
        self.progress = float(min(1.0, max(0.0, fraction)))

    def maybe_learn(self, current_obs: np.ndarray) -> Dict[str, float] | None:
        if not self._buf or self._ptr < int(self.h["rolloutSteps"]):
            return None
        stats = self._learn(np.asarray(current_obs, dtype=np.float32))
        self._ptr = 0
        return stats

    # ── learning ───────────────────────────────────────────────────────────────────────
    def _learn(self, last_obs: np.ndarray) -> Dict[str, float]:
        h = self.h
        b = self._buf
        t_len, n_envs = b["rew"].shape
        gamma, lam = float(h["discount"]), float(h["gaeLambda"])

        _, last_value = self._forward(last_obs)
        adv = np.zeros((t_len, n_envs), dtype=np.float32)
        gae = np.zeros(n_envs, dtype=np.float32)
        for t in range(t_len - 1, -1, -1):
            next_value = last_value if t == t_len - 1 else b["val"][t + 1]
            nonterminal = 1.0 - b["end"][t]
            delta = b["rew"][t] + gamma * next_value * nonterminal - b["val"][t]
            gae = delta + gamma * lam * nonterminal * gae
            adv[t] = gae
        ret = adv + b["val"]

        total = t_len * n_envs
        obs = b["obs"].reshape(total, -1)
        act = b["act"].reshape(total)
        old_logp = b["logp"].reshape(total)
        masks_all = b["mask"].reshape(total, ACTION_COUNT)
        advantages = adv.reshape(total)
        returns = ret.reshape(total)
        advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)

        lr = self.base_lr * (max(0.1, 1.0 - self.progress) if int(h.get("annealLR", 1)) else 1.0)
        self.opt.lr = lr
        clip = float(h["clipRange"])
        ent_coef = float(h["entropy"])
        vf_coef = float(h["valueCoef"])
        batch = int(min(total, h["miniBatchSize"]))
        stats = {"kl": 0.0, "entropy": 0.0, "policyLoss": 0.0, "valueLoss": 0.0, "clipFrac": 0.0}
        count = 0
        stop = False

        for _ in range(int(h["epochs"])):
            order = self.rng.permutation(total)
            for start in range(0, total, batch):
                idx = order[start:start + batch]
                if len(idx) < 2:
                    continue
                x = obs[idx]
                a = act[idx]
                A = advantages[idx]
                R = returns[idx]
                olp = old_logp[idx]
                m = len(idx)

                logits, value, a1, a2 = self._forward(x, keep=True)
                probs = softmax(np.where(masks_all[idx], logits, -1e9))
                logp_all = np.log(probs + 1e-8)
                logp = logp_all[np.arange(m), a]
                ratio = np.exp(logp - olp)

                active = ((A >= 0) & (ratio <= 1 + clip)) | ((A < 0) & (ratio >= 1 - clip))
                dlogp = np.where(active, -A * ratio, 0.0)  # d(policy loss)/d(logp)
                onehot = np.zeros_like(probs)
                onehot[np.arange(m), a] = 1.0
                dlogits = dlogp[:, None] * (onehot - probs)
                entropy = -(probs * logp_all).sum(axis=1)
                dlogits += ent_coef * probs * (logp_all + entropy[:, None])  # -ent_coef * dH/dz
                dlogits /= m
                dvalue = (vf_coef * (value - R) / m)[:, None]

                g: Dict[str, np.ndarray] = {}
                p = self.params
                g["Wp"] = a2.T @ dlogits
                g["bp"] = dlogits.sum(axis=0)
                g["Wv"] = a2.T @ dvalue
                g["bv"] = dvalue.sum(axis=0)
                da2 = (dlogits @ p["Wp"].T + dvalue @ p["Wv"].T) * (1.0 - a2 * a2)
                g["W2"] = a1.T @ da2
                g["b2"] = da2.sum(axis=0)
                da1 = (da2 @ p["W2"].T) * (1.0 - a1 * a1)
                g["W1"] = x.T @ da1
                g["b1"] = da1.sum(axis=0)
                self.opt.step({k: v.astype(np.float32) for k, v in g.items()})

                approx_kl = float(((ratio - 1.0) - np.log(ratio + 1e-8)).mean())
                stats["kl"] += approx_kl
                stats["entropy"] += float(entropy.mean())
                stats["policyLoss"] += float(-np.minimum(ratio * A, np.clip(ratio, 1 - clip, 1 + clip) * A).mean())
                stats["valueLoss"] += float(0.5 * ((value - R) ** 2).mean())
                stats["clipFrac"] += float((np.abs(ratio - 1.0) > clip).mean())
                count += 1
                if approx_kl > 0.05:  # policy moved too far – stop this update early
                    stop = True
                    break
            if stop:
                break

        self.updates += 1
        self.last_stats = {k: v / max(1, count) for k, v in stats.items()}
        self.last_stats["lr"] = lr
        return self.last_stats

    # ── persistence ────────────────────────────────────────────────────────────────────
    def serialize(self) -> Dict[str, Any]:
        return {
            "params": {k: v.tolist() for k, v in self.params.items()},
            "retRms": [self.ret_rms.mean, self.ret_rms.var, self.ret_rms.count],
            "updates": self.updates,
        }

    @property
    def action_count(self) -> int:
        return ACTION_COUNT


def create_agent(config: Optional[Dict[str, Any]] = None, checkpoint: Optional[Dict[str, Any]] = None) -> PPOAgent:
    """Factory creating a PPOAgent."""
    return PPOAgent(config, checkpoint)
