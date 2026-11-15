"""RL training controller: vectorised rollouts, curriculum, evaluation and checkpointing.

Training episode = **one attempt at one level**:

* every episode starts on a *random* level of the selected set with a random rotator phase,
  so the agent practises the hard levels from the very first minute instead of having to
  clear levels 1-3 first (a classic reason campaign-style training never takes off);
* the episode ends when the agent clears the level, dies, or runs out of level time;
* time-limit truncation (``maxEpisodeSteps``) is passed to the agent as *truncation*, not death.

``evaluate`` plays the real game rules (full campaign, restarts on death) with the greedy policy.
"""

from typing import Any, Dict, List, Optional

import numpy as np

from backend.config import DEFAULT_REWARDS
from backend.rl.environment import WorldEnvironment
from backend.rl.registry import get_algorithm


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

        self.parallel_instances = max(1, int(self.hyperparameters.get("parallelInstances", 16)))
        self.parallel_envs = [
            WorldEnvironment(self.levels, {"seed": self.seed + 7919 * i, "rewards": self.rewards, "randomStartLevel": True})
            for i in range(self.parallel_instances)
        ]
        self.obs = np.stack([env.reset() for env in self.parallel_envs]).astype(np.float32)
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
                })
                if len(self.history) > 300:
                    del self.history[:-300]
                self.agent.end_episode()
                self.ep_reward[i] = 0.0
                self.ep_steps[i] = 0
                next_obs[i] = env.reset()
                self.env = env

            self.obs = next_obs
            learned = self.agent.maybe_learn(self.obs)
            if learned:
                self.last_learn = learned

        return {"transitions": transitions, "newEpisodes": new_episodes, **self.stats()}

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

        for _ in range(episode_count):
            obs = env.reset(0)
            reward = 0.0
            steps = 0
            success = False
            while steps < self.max_episode_steps:
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
            "agent": self.agent.serialize(),
            "levelNames": [lvl.get("name", "Untitled level") for lvl in self.levels],
        }
