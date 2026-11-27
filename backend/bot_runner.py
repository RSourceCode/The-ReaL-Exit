"""Headless bot play: run a policy on a level with the real game rules and report how hard it was."""

import math
from typing import Any, Dict, List, Optional

from backend.config import RL_ACTION_DURATION_SECONDS
from backend.rl.environment import WorldEnvironment

POLICIES = ("auto", "agent", "solver", "random")


def _popcount(n: int) -> int:
    return bin(int(n)).count("1")


def _play_once(level: Dict[str, Any], policy: str, agent: Any, seed: int, max_attempts: int, explore: bool,
               rewards: Optional[Dict[str, float]], actions: Optional[List[int]] = None) -> Dict[str, Any]:
    env = WorldEnvironment([level], {"seed": seed, "rewards": rewards, "randomPhase": policy != "solver"})
    obs = env.reset(0)
    step_cap = (env.time_limit_steps + 5) * max_attempts
    total_steps, cleared, clear_time, coins = 0.0, False, None, 0
    causes = {"timeout": 0, "hazard": 0, "other": 0}
    n = 0
    while n < step_cap:
        mask = env.action_mask()
        if policy == "solver":
            if n >= len(actions):
                break
            action = actions[n]
        elif policy == "agent":
            action = int(agent.act(obs, "", explore=explore, mask=mask)["action"])
        else:  # random valid action
            valid = [i for i, ok in enumerate(mask) if ok] or [8]
            action = valid[int(env.random() * len(valid)) % len(valid)]
        res = env.step(action)
        n += 1
        obs = res["observation"]
        total_steps += float(res.get("timeStepsUsed") or 1)
        coins = max(coins, _popcount(env.coin_mask))
        if res["death"]:
            causes["timeout" if res["timedOut"] else "hazard" if res["hazard"] else "other"] += 1
            if env.death_count >= max_attempts:
                break
        if res["done"] and res["success"]:
            cleared, clear_time = True, float(res["levelSteps"]) * RL_ACTION_DURATION_SECONDS
            break
    deaths = env.death_count
    return {"cleared": cleared, "attempts": deaths + 1, "deaths": deaths, "actions": n,
            "total_time": round(total_steps * RL_ACTION_DURATION_SECONDS, 3),
            "clear_time": None if clear_time is None else round(clear_time, 3),
            "coins_collected": coins, "collisions": env.collision_count, "death_causes": causes}


def _mean(values: List[float]) -> Optional[float]:
    return round(sum(values) / len(values), 4) if values else None


def simulate_level(level: Dict[str, Any], policy: str = "auto", runs: int = 10, max_attempts: int = 5, seed: int = 1,
                   explore: bool = True, agent: Any = None, rewards: Optional[Dict[str, float]] = None,
                   solver_nodes: int = 20000) -> Dict[str, Any]:
    """Play ``level`` ``runs`` times and aggregate. One *run* = play until cleared or ``max_attempts`` deaths
    (a death restarts the level, exactly like the game). Times are simulated seconds, not wall-clock."""
    if policy not in POLICIES:
        raise ValueError(f"policy must be one of {POLICIES}")
    if policy == "auto":
        policy = "agent" if agent is not None else "solver"
    if policy == "agent" and agent is None:
        raise ValueError("policy 'agent' needs a trained or loaded agent (train in the AI Lab or load a checkpoint)")
    results, extra = [], {}
    if policy == "solver":
        from backend.level_tools import check_solvable
        sol = check_solvable(level, solver_nodes)
        extra = {"solvable": sol["solvable"], "min_time_seconds": sol["minTimeSeconds"], "solution_steps": sol["solutionSteps"]}
        if sol["solvable"]:
            results.append(_play_once(level, "solver", None, seed, max_attempts, False, rewards, sol["solution"]))
        else:
            results.append({"cleared": False, "attempts": max_attempts, "deaths": max_attempts, "actions": 0, "total_time": 0.0, "clear_time": None,
                            "coins_collected": 0, "collisions": 0, "death_causes": {"timeout": 0, "hazard": 0, "other": 0}})
    else:
        runs = max(1, int(runs))
        results = [_play_once(level, policy, agent, seed + 7919 * i, max_attempts, explore, rewards) for i in range(runs)]
    wins = [r for r in results if r["cleared"]]
    causes = {k: sum(r["death_causes"][k] for r in results) for k in ("timeout", "hazard", "other")}
    limit = math.ceil(float(level.get("timeLimit", 45)))
    return {
        "policy": policy, "runs": len(results), "max_attempts": max_attempts, "time_limit": limit,
        "clear_rate": round(len(wins) / len(results), 4),
        "mean_attempts": _mean([r["attempts"] for r in results]), "mean_deaths": _mean([r["deaths"] for r in results]),
        "mean_clear_time": _mean([r["clear_time"] for r in wins]), "min_clear_time": min((r["clear_time"] for r in wins), default=None),
        "mean_total_time": _mean([r["total_time"] for r in results]),
        "mean_coins": _mean([r["coins_collected"] for r in results]), "mean_collisions": _mean([r["collisions"] for r in results]),
        "death_causes": causes, **extra, "details": results,
    }
