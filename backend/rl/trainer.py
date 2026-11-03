"""RL training controller managing episodes, chunked simulation, evaluation, and serialization."""

from typing import Any, Dict, List, Optional

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
        max_episode_steps: int = 180,
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

        self.env = WorldEnvironment(self.levels, {"seed": self.seed, "rewards": self.rewards})
        self.observation = self.env.reset()
        self.episode_reward = 0.0
        self.episode_steps = 0
        self.total_steps = int(checkpoint.get("totalSteps", 0)) if checkpoint else 0
        self.episodes = int(checkpoint.get("episodes", 0)) if checkpoint else 0
        self.history: List[Dict[str, Any]] = list(checkpoint.get("history", []))[-300:] if checkpoint else []

    def run_chunk(self, step_budget: int = 512) -> Dict[str, Any]:
        """Execute a chunk of environment steps and agent learning updates."""
        transitions = 0
        new_episodes = 0

        while transitions < step_budget:
            key = self.env.get_state_key()
            decision = self.agent.act(self.observation, key, explore=True)
            result = self.env.step(decision["action"])

            truncated = (self.episode_steps + 1 >= self.max_episode_steps) and not result["done"]
            done = result["done"] or truncated
            next_obs = result["observation"]

            self.agent.observe({
                "key": key,
                "action": decision["action"],
                "oldProbability": decision["probability"],
                "observation": self.observation,
                "nextKey": self.env.get_state_key(),
                "nextObservation": next_obs,
                "reward": result["reward"],
                "done": done,
            })

            self.episode_reward += result["reward"]
            self.episode_steps += 1
            self.total_steps += 1
            transitions += 1
            self.observation = next_obs

            if done:
                self.agent.end_episode()
                self.episodes += 1
                new_episodes += 1
                self.history.append({
                    "episode": self.episodes,
                    "reward": round(self.episode_reward, 2),
                    "success": bool(result["success"]),
                    "steps": self.episode_steps,
                    "collisions": self.env.collision_count,
                    "deaths": self.env.death_count,
                    "coins": self.env.total_coins,
                    "hazard": bool(result["hazard"]),
                })
                if len(self.history) > 300:
                    self.history.pop(0)

                self.episode_reward = 0.0
                self.episode_steps = 0
                self.observation = self.env.reset()

        stats_dict = self.stats()
        return {"transitions": transitions, "newEpisodes": new_episodes, **stats_dict}

    def stats(self) -> Dict[str, Any]:
        """Compute summary metrics over the recent training history."""
        recent = self.history[-50:]
        n = len(recent)
        successes = sum(1 for ep in recent if ep["success"])
        return {
            "steps": self.total_steps,
            "episodes": self.episodes,
            "meanReward": sum(ep["reward"] for ep in recent) / n if n else 0.0,
            "successRate": successes / n if n else 0.0,
            "meanLength": sum(ep["steps"] for ep in recent) / n if n else 0.0,
            "collisionCount": sum(ep["collisions"] for ep in recent) / n if n else 0.0,
            "meanDeaths": sum(ep.get("deaths", 0) for ep in recent) / n if n else 0.0,
            "coinRate": sum(ep["coins"] for ep in recent) / n if n else 0.0,
            "history": self.history,
        }

    def snapshot(self) -> Dict[str, Any]:
        """Capture environment and trainer progress."""
        return {
            **self.env.snapshot(),
            "episode": self.episodes,
            "reward": self.episode_reward,
        }

    def evaluate(self, episode_count: int = 20) -> Dict[str, Any]:
        """Run headless deterministic evaluation without exploration."""
        env = WorldEnvironment(self.levels, {"seed": self.seed + 997, "rewards": self.rewards})
        results: List[Dict[str, Any]] = []

        for _ in range(episode_count):
            obs = env.reset()
            reward = 0.0
            steps = 0
            done = False
            success = False

            while not done and steps < self.max_episode_steps:
                decision = self.agent.act(obs, env.get_state_key(), explore=False)
                result = env.step(decision["action"])
                obs = result["observation"]
                reward += result["reward"]
                steps += 1
                done = result["done"]
                success = result["success"]

            results.append({
                "reward": reward,
                "steps": steps,
                "success": success,
                "collisions": env.collision_count,
                "deaths": env.death_count,
                "coins": env.total_coins,
            })

        n = len(results)
        return {
            "episodes": episode_count,
            "successRate": sum(1 for r in results if r["success"]) / n if n else 0.0,
            "meanReward": sum(r["reward"] for r in results) / n if n else 0.0,
            "meanSteps": sum(r["steps"] for r in results) / n if n else 0.0,
            "meanCollisions": sum(r["collisions"] for r in results) / n if n else 0.0,
            "meanDeaths": sum(r["deaths"] for r in results) / n if n else 0.0,
            "meanCoins": sum(r["coins"] for r in results) / n if n else 0.0,
        }

    def serialize(self) -> Dict[str, Any]:
        """Generate a portable JSON checkpoint matching the The-ReaL-Exit checkpoint specification."""
        return {
            "format": "worldforge-rl-checkpoint",
            "version": 1,
            "algorithm": self.algorithm_id,
            "hyperparameters": self.hyperparameters,
            "rewards": self.rewards,
            "seed": self.seed,
            "maxEpisodeSteps": self.max_episode_steps,
            "totalSteps": self.total_steps,
            "episodes": self.episodes,
            "history": self.history,
            "levels": self.levels,
            "agent": self.agent.serialize(),
            "levelNames": [lvl.get("name", "Untitled level") for lvl in self.levels],
        }

