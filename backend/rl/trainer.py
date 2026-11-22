"""RL training controller: vectorised rollouts, adaptive curriculum, mastery detection, evaluation, checkpoints.

Training episode = **one attempt at one level**: it ends when the agent clears the level, dies, or runs out of
level time (time-limit truncation is passed to the agent as *truncation*, not death).

Curriculum (on by default)
--------------------------
The campaign is ordered simple -> hard (door only, then a button, ice, acid, spikes, lasers, ...).  The trainer
keeps a *frontier*: it starts on level 1 and unlocks the next level as soon as the agent clears the newest one
reliably.  Unlocked levels are sampled so that most episodes go to the frontier and the rest to whatever the agent
is currently worst at (prioritised replay), so earlier skills are never forgotten.  Every level is also played
mirrored left-to-right half of the time (data augmentation) so the policy learns the *idea* – "go round the wall",
"jump the acid" – not which side things happen to be on.

Mastery / early stop
--------------------
Training is *mastered* when, over the last ``window`` attempts, every level is cleared at least ``threshold`` of the
time **and** a separate greedy (no-exploration) check under the real game rules confirms it.  The AI Lab then stops
by itself ("Stop when mastered"), which is what keeps the overall training time short.

``evaluate`` plays the real game (full campaign, restarts on death) with the greedy policy.
"""

from collections import deque
from typing import Any, Dict, List, Optional

import numpy as np

import math

from backend.config import DEFAULT_REWARDS, LEVEL_TIME_LIMIT_SECONDS, RL_ACTION_DURATION_SECONDS
from backend.levels import mirror_level
from backend.rl.environment import WorldEnvironment
from backend.rl.registry import get_algorithm


class Curriculum:
    """Decides which level each new training episode starts on, and when the agent has mastered them all."""

    def __init__(self, count: int, enabled: bool = True, window: int = 30, threshold: float = 0.9, min_episodes: int = 20,
                 rng: Optional[np.random.Generator] = None):
        self.count = count
        self.enabled = bool(enabled)
        self.window = window
        self.threshold = threshold
        self.min_episodes = min_episodes
        self.rng = rng or np.random.default_rng(0)
        self.unlocked = 1 if self.enabled else count
        self.results = [deque(maxlen=window) for _ in range(count)]
        self.attempts = [0] * count

    # -- bookkeeping ------------------------------------------------------------------------------------------------
    def rate(self, level: int) -> Optional[float]:
        r = self.results[level]
        return (sum(r) / len(r)) if len(r) else None

    def record(self, level: int, cleared: bool) -> bool:
        """Log one finished attempt; returns True when this unlocked a new level."""
        self.results[level].append(1.0 if cleared else 0.0)
        self.attempts[level] += 1
        frontier = self.unlocked - 1
        if self.enabled and level == frontier and self.unlocked < self.count:
            r = self.results[level]
            if len(r) >= self.min_episodes and sum(r) / len(r) >= self.threshold:
                self.unlocked += 1
                return True
        return False

    def mastered_in_training(self) -> bool:
        if self.unlocked < self.count:
            return False
        for r in self.results:
            if len(r) < self.min_episodes or sum(r) / len(r) < self.threshold:
                return False
        return True

    # -- sampling ---------------------------------------------------------------------------------------------------
    def sample(self) -> int:
        n = self.unlocked
        if n == 1:
            return 0
        frontier = n - 1
        weights = np.zeros(n)
        for i in range(n):
            r = self.rate(i)
            weakness = 0.5 if r is None else (1.0 - r)
            weights[i] = 0.08 + weakness * weakness          # prioritised replay: struggle -> more practice
        if self.enabled and n < self.count:
            weights /= weights.sum()
            weights = 0.5 * weights                           # half of the episodes go to the newest level
            weights[frontier] += 0.5
        weights /= weights.sum()
        return int(self.rng.choice(n, p=weights))

    def summary(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled, "unlocked": self.unlocked, "count": self.count, "threshold": self.threshold,
            "rates": [self.rate(i) for i in range(self.count)], "attempts": list(self.attempts),
        }

    def restore(self, saved: Dict[str, Any]) -> None:
        self.unlocked = max(1, min(self.count, int(saved.get("unlocked", self.unlocked))))
        for i, r in enumerate(saved.get("rates", [])[: self.count]):
            if r is not None:
                self.results[i].extend([1.0] * round(r * self.window) + [0.0] * (self.window - round(r * self.window)))
        self.attempts = list(saved.get("attempts", self.attempts))[: self.count] + [0] * max(0, self.count - len(saved.get("attempts", [])))


class RLTrainer:
    """Orchestrates simulation batches, agent policy updates, metrics, and checkpointing."""

    def __init__(
        self,
        algorithm_id: str = "ppo",
        hyperparameters: Optional[Dict[str, Any]] = None,
        levels: Optional[List[Dict[str, Any]]] = None,
        seed: int = 17,
        max_episode_steps: int = 300,
        checkpoint: Optional[Dict[str, Any]] = None,
        rewards: Optional[Dict[str, Any]] = None,
        options: Optional[Dict[str, Any]] = None,
    ):
        algo_name = checkpoint.get("algorithm", algorithm_id) if checkpoint else algorithm_id
        self.algorithm = get_algorithm(algo_name)
        self.algorithm_id = self.algorithm.METADATA["id"]

        defaults = self.algorithm.METADATA["defaults"]
        hp_override = checkpoint.get("hyperparameters", hyperparameters or {}) if checkpoint else (hyperparameters or {})
        self.hyperparameters = {**defaults, **hp_override}

        self.levels = checkpoint.get("levels", levels or []) if checkpoint else (levels or [])
        if not self.levels:
            raise ValueError("Select at least one level for training.")

        self.seed = int(checkpoint.get("seed", seed)) if checkpoint else int(seed)
        reward_vals = rewards or (checkpoint.get("rewards") if checkpoint else {}) or {}
        self.rewards = {k: float(reward_vals.get(k, DEFAULT_REWARDS[k])) for k in DEFAULT_REWARDS}
        self.max_episode_steps = int(checkpoint.get("maxEpisodeSteps", max_episode_steps)) if checkpoint else int(max_episode_steps)

        agent_cp = checkpoint.get("agent") if checkpoint else None
        agent_cfg = {**self.hyperparameters, "seed": self.seed}
        self.agent = self.algorithm.create_agent(agent_cfg, agent_cp)

        saved_options = checkpoint.get("options", {}) if checkpoint else {}
        opts = {"curriculum": True, "augment": True, "stopWhenMastered": True, "masteryThreshold": 0.9, **saved_options, **(options or {})}
        self.options = {
            "curriculum": bool(opts["curriculum"]), "augment": bool(opts["augment"]),
            "stopWhenMastered": bool(opts["stopWhenMastered"]), "masteryThreshold": float(opts["masteryThreshold"]),
        }
        self.rng = np.random.default_rng(self.seed + 31)
        self.base_count = len(self.levels)
        # Training sees every level as written and (optionally) mirrored: variant index = base + count * mirrored.
        self.train_levels = list(self.levels) + ([mirror_level(l) for l in self.levels] if self.options["augment"] else [])
        self.curriculum = Curriculum(self.base_count, self.options["curriculum"], threshold=self.options["masteryThreshold"], rng=self.rng)
        if checkpoint and checkpoint.get("curriculum"):
            self.curriculum.restore(checkpoint["curriculum"])
        self.solved = bool(checkpoint.get("solved", False)) if checkpoint else False
        self.verification: Dict[str, Any] = dict(checkpoint.get("verification", {})) if checkpoint else {}
        self._last_check = 0

        self.parallel_instances = max(1, int(self.hyperparameters.get("parallelInstances", 16)))
        self.parallel_envs = [
            WorldEnvironment(self.train_levels, {"seed": self.seed + 7919 * i, "rewards": self.rewards})
            for i in range(self.parallel_instances)
        ]
        self.env_base = [0] * self.parallel_instances
        self.obs = np.stack([self._reset_env(i) for i in range(self.parallel_instances)]).astype(np.float32)
        self.ep_reward = np.zeros(self.parallel_instances)
        self.ep_steps = np.zeros(self.parallel_instances, dtype=np.int64)

        self.env = self.parallel_envs[0]
        self.target_steps = int(checkpoint.get("targetSteps", 1_000_000)) if checkpoint else 1_000_000
        self.total_steps = int(checkpoint.get("totalSteps", 0)) if checkpoint else 0
        self.episodes = int(checkpoint.get("episodes", 0)) if checkpoint else 0
        self.history: List[Dict[str, Any]] = list(checkpoint.get("history", []))[-300:] if checkpoint else []
        self.last_learn: Dict[str, float] = {}

    # ── training ───────────────────────────────────────────────────────────────────────
    def set_target_steps(self, target: int) -> None:
        self.target_steps = max(1, int(target))

    def run_chunk(self, step_budget: int = 512) -> Dict[str, Any]:
        """Run about ``step_budget`` environment transitions (rounded up to whole vector steps)."""
        n = self.parallel_instances
        transitions = 0
        new_episodes = 0

        while transitions < step_budget:
            self.agent.set_progress(self.total_steps / self.target_steps)
            masks = np.stack([env.action_mask() for env in self.parallel_envs])
            actions, extras = self.agent.act_batch(self.obs, True, masks)

            rewards = np.zeros(n)
            terminated = np.zeros(n, dtype=bool)
            truncated = np.zeros(n, dtype=bool)
            next_obs = np.empty_like(self.obs)
            results: List[Dict[str, Any]] = []
            for i, env in enumerate(self.parallel_envs):
                res = env.step(int(actions[i]))
                results.append(res)
                rewards[i] = res["reward"]
                next_obs[i] = res["observation"]
                # One episode = one attempt at one level.
                terminated[i] = res["death"] or res["done"] or res["levelChanged"]
                truncated[i] = (not terminated[i]) and (self.ep_steps[i] + 1 >= self.max_episode_steps)

            self.agent.observe_batch(self.obs, actions, extras, rewards, next_obs, terminated, truncated)
            self.ep_reward += rewards
            self.ep_steps += 1
            self.total_steps += n
            transitions += n

            for i in np.nonzero(terminated | truncated)[0]:
                env = self.parallel_envs[i]
                res = results[i]
                cleared = bool(res["done"] or res["levelChanged"])
                self.curriculum.record(self.env_base[i], cleared)
                self.episodes += 1
                new_episodes += 1
                self.history.append({
                    "episode": self.episodes,
                    "reward": round(float(self.ep_reward[i]), 2),
                    "success": cleared,
                    "steps": int(self.ep_steps[i]),
                    "collisions": env.collision_count,
                    "deaths": env.death_count,
                    "coins": env.total_coins,
                    "hazard": bool(res["hazard"]),
                    "timedOut": bool(res["timedOut"]),
                    "level": self.env_base[i],
                })
                if len(self.history) > 300:
                    del self.history[:-300]
                self.agent.end_episode()
                self.ep_reward[i] = 0.0
                self.ep_steps[i] = 0
                next_obs[i] = self._reset_env(i)
                self.env = env

            self.obs = next_obs
            learned = self.agent.maybe_learn(self.obs)
            if learned:
                self.last_learn = learned

        if self.options["stopWhenMastered"] and not self.solved and self.curriculum.mastered_in_training() \
                and self.total_steps - self._last_check >= 4096:
            self._last_check = self.total_steps
            self.solved = self.verify()["passed"]
        return {"transitions": transitions, "newEpisodes": new_episodes, **self.stats()}

    # -- curriculum helpers -------------------------------------------------------------------------------------------
    def _reset_env(self, i: int) -> np.ndarray:
        """Start a fresh episode in environment ``i`` on the level the curriculum picks (maybe mirrored)."""
        base = self.curriculum.sample()
        mirrored = self.options["augment"] and self.rng.random() < 0.5
        self.env_base[i] = base
        return self.parallel_envs[i].reset(base + (self.base_count if mirrored else 0))

    def verify(self, tries: int = 10) -> Dict[str, Any]:
        """Greedy (no exploration) check of every level, as written and mirrored, with random obstacle phases."""
        env = WorldEnvironment(self.train_levels, {"seed": self.seed + 4242, "rewards": self.rewards})
        rates: List[float] = []
        for base in range(self.base_count):
            wins = total = 0
            for variant in ([base, base + self.base_count] if self.options["augment"] else [base]):
                for _ in range(tries):
                    total += 1
                    wins += int(self._greedy_clear(env, variant))
            rates.append(wins / max(1, total))
        self.verification = {"rates": rates, "step": self.total_steps, "passed": all(r >= self.options["masteryThreshold"] for r in rates)}
        return self.verification

    def _greedy_clear(self, env: WorldEnvironment, level_index: int) -> bool:
        obs = env.reset(level_index)
        for _ in range(self.max_episode_steps):
            actions, _ = self.agent.act_batch(obs[None, :], False, env.action_mask()[None, :])
            result = env.step(int(actions[0]))
            obs = result["observation"]
            if result["levelChanged"] or result["done"]:
                return True
            if result["death"]:
                return False
        return False

    def stats(self) -> Dict[str, Any]:
        """Compute summary metrics over the recent training history."""
        recent = self.history[-100:]
        n = len(recent)
        return {
            "steps": self.total_steps,
            "episodes": self.episodes,
            "meanReward": sum(ep["reward"] for ep in recent) / n if n else 0.0,
            # Fraction of recent level attempts that ended with the exit being reached.
            "successRate": sum(1 for ep in recent if ep["success"]) / n if n else 0.0,
            "meanLength": sum(ep["steps"] for ep in recent) / n if n else 0.0,
            "collisionCount": sum(ep["collisions"] for ep in recent) / n if n else 0.0,
            "meanDeaths": sum(ep.get("deaths", 0) for ep in recent) / n if n else 0.0,
            "coinRate": sum(ep["coins"] for ep in recent) / n if n else 0.0,
            "learn": self.last_learn,
            "curriculum": self.curriculum.summary(),
            "mastered": self.solved,
            "verification": self.verification,
            "history": self.history,
        }

    def snapshot(self) -> Dict[str, Any]:
        """Capture environment and trainer progress."""
        return {**self.env.snapshot(), "episode": self.episodes, "reward": float(self.ep_reward[0])}

    # ── evaluation ─────────────────────────────────────────────────────────────────────
    def evaluate(self, episode_count: int = 20) -> Dict[str, Any]:
        """Greedy evaluation under the *real* game rules (full campaign, level restarts on death)."""
        env = WorldEnvironment(self.levels, {"seed": self.seed + 997, "rewards": self.rewards})
        results: List[Dict[str, Any]] = []
        # A whole campaign takes far longer than one level: allow each level its own time limit (twice over).
        campaign_cap = 2 * sum(math.ceil(float(l.get("timeLimit", LEVEL_TIME_LIMIT_SECONDS)) / RL_ACTION_DURATION_SECONDS) for l in self.levels) + 50

        for _ in range(episode_count):
            obs = env.reset(0)
            reward = 0.0
            steps = 0
            success = False
            while steps < max(self.max_episode_steps, campaign_cap):
                actions, _ = self.agent.act_batch(obs[None, :], False, env.action_mask()[None, :])
                result = env.step(int(actions[0]))
                obs = result["observation"]
                reward += result["reward"]
                steps += 1
                if result["done"]:
                    success = result["success"]
                    break
            results.append({
                "reward": reward,
                "steps": steps,
                "success": success,
                "collisions": env.collision_count,
                "deaths": env.death_count,
                "coins": env.total_coins,
                "levels": env.level_changes + (1 if success else 0),
            })

        # Per-level diagnostics: how often does the greedy policy clear each level on its own?
        per_level: List[float] = []
        for level_index in range(len(self.levels)):
            wins = 0
            tries = max(10, episode_count)
            for _ in range(tries):
                obs = env.reset(level_index)
                for _step in range(self.max_episode_steps):
                    actions, _ = self.agent.act_batch(obs[None, :], False, env.action_mask()[None, :])
                    result = env.step(int(actions[0]))
                    obs = result["observation"]
                    if result["levelChanged"] or result["done"]:
                        wins += 1
                        break
                    if result["death"]:
                        break
            per_level.append(wins / tries)

        n = len(results)
        return {
            "episodes": episode_count,
            "successRate": sum(1 for r in results if r["success"]) / n if n else 0.0,
            "meanReward": sum(r["reward"] for r in results) / n if n else 0.0,
            "meanSteps": sum(r["steps"] for r in results) / n if n else 0.0,
            "meanCollisions": sum(r["collisions"] for r in results) / n if n else 0.0,
            "meanDeaths": sum(r["deaths"] for r in results) / n if n else 0.0,
            "meanCoins": sum(r["coins"] for r in results) / n if n else 0.0,
            "meanLevels": sum(r["levels"] for r in results) / n if n else 0.0,
            "perLevelClearRate": per_level,
        }

    # ── persistence ────────────────────────────────────────────────────────────────────
    def serialize(self) -> Dict[str, Any]:
        """Generate a portable JSON checkpoint matching the The-ReaL-Exit checkpoint specification."""
        return {
            "format": "worldforge-rl-checkpoint",
            "version": 2,
            "algorithm": self.algorithm_id,
            "hyperparameters": self.hyperparameters,
            "rewards": self.rewards,
            "seed": self.seed,
            "maxEpisodeSteps": self.max_episode_steps,
            "targetSteps": self.target_steps,
            "totalSteps": self.total_steps,
            "episodes": self.episodes,
            "history": self.history,
            "levels": self.levels,
            "options": self.options,
            "curriculum": self.curriculum.summary(),
            "solved": self.solved,
            "verification": self.verification,
            "agent": self.agent.serialize(),
            "levelNames": [lvl.get("name", "Untitled level") for lvl in self.levels],
        }
