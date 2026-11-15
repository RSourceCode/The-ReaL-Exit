"""Tiny numpy neural-network helpers (orthogonal init, Adam) shared by PPO and DQN."""

from typing import Dict

import numpy as np


def orthogonal(rng: np.random.Generator, n_in: int, n_out: int, gain: float = 1.0) -> np.ndarray:
    """Orthogonal weight initialisation, shape (n_in, n_out), float32."""
    a = rng.standard_normal((max(n_in, n_out), min(n_in, n_out)))
    q, r = np.linalg.qr(a)
    q = q * np.sign(np.diag(r))
    q = q if n_in >= n_out else q.T
    return (gain * q[:n_in, :n_out]).astype(np.float32)


def softmax(logits: np.ndarray) -> np.ndarray:
    z = logits - logits.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


class Adam:
    """Adam optimiser over a dict of float32 arrays, with global-norm gradient clipping."""

    def __init__(self, params: Dict[str, np.ndarray], lr: float = 3e-4, eps: float = 1e-5, max_grad_norm: float = 0.5):
        self.params = params
        self.lr = lr
        self.eps = eps
        self.max_grad_norm = max_grad_norm
        self.m = {k: np.zeros_like(v) for k, v in params.items()}
        self.v = {k: np.zeros_like(v) for k, v in params.items()}
        self.t = 0

    def step(self, grads: Dict[str, np.ndarray]) -> float:
        norm = float(np.sqrt(sum(float((g * g).sum()) for g in grads.values())))
        scale = min(1.0, self.max_grad_norm / (norm + 1e-8)) if self.max_grad_norm else 1.0
        self.t += 1
        b1, b2 = 0.9, 0.999
        c1 = 1.0 - b1 ** self.t
        c2 = 1.0 - b2 ** self.t
        for k, p in self.params.items():
            g = grads[k] * scale
            self.m[k] = b1 * self.m[k] + (1 - b1) * g
            self.v[k] = b2 * self.v[k] + (1 - b2) * g * g
            p -= (self.lr * (self.m[k] / c1) / (np.sqrt(self.v[k] / c2) + self.eps)).astype(np.float32)
        return norm


class RunningMeanStd:
    """Streaming mean / variance (Welford, batched)."""

    def __init__(self):
        self.mean = 0.0
        self.var = 1.0
        self.count = 1e-4

    def update(self, x: np.ndarray) -> None:
        x = np.asarray(x, dtype=np.float64).ravel()
        if x.size == 0:
            return
        bm, bv, bc = x.mean(), x.var(), x.size
        delta = bm - self.mean
        total = self.count + bc
        self.mean += delta * bc / total
        m2 = self.var * self.count + bv * bc + delta * delta * self.count * bc / total
        self.var = m2 / total
        self.count = total
