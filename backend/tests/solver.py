"""Best-first level solver used by the tests (and handy for level designers).

It searches the *real* environment (so every mechanic – lasers, lifts, crates, ice – is honoured) for
a sequence of actions that clears a level before its timer runs out.  If it finds one the level is
provably solvable under the RL rules.
"""

import heapq
import itertools
from typing import Any, Dict, List, Optional, Tuple

from backend.rl.environment import WorldEnvironment


def solve_level(level: Dict[str, Any], max_nodes: int = 60000, weight: float = 1.0) -> Optional[Tuple[List[int], float]]:
    """Return ``(actions, steps_used)`` for the cheapest-looking clear, or ``None`` if the budget ran out."""
    env = WorldEnvironment([level], {"seed": 3, "randomPhase": False})
    env.reset(0)
    start = env.capture()
    counter = itertools.count()
    heap: List[Tuple[float, int, float, Dict[str, Any], List[int]]] = []
    heapq.heappush(heap, (0.0, next(counter), 0.0, start, []))
    seen = set()
    nodes = 0
    limit = env.time_limit_steps
    while heap and nodes < max_nodes:
        _f, _n, g, state, path = heapq.heappop(heap)
        key = (
            tuple(state["position"]), state["heading"], state["plate_mask"], tuple(sorted(state["lever_state"].items())),
            tuple(sorted(state["blocks"])), state["powerup_type"], round(state["simulation_steps"] * 3),
        )
        if key in seen:
            continue
        seen.add(key)
        nodes += 1
        env.restore(state)
        mask = env.action_mask()
        for action in range(len(mask)):
            if not mask[action]:
                continue
            env.restore(state)
            res = env.step(action)
            if res["death"]:
                continue
            if res["done"] and res["success"]:
                return path + [action], res["levelSteps"]
            if env.level_steps >= limit:
                continue
            new_state = env.capture()
            h = env._dist_at(env.position[0], env.position[1])
            # Stage-aware: a state that has already opened the door / pulled the lever is *closer* to done even though
            # the compass distance jumps up when the objective switches.  Without this the search stalls at the button.
            h = (0.0 if h >= 1e8 else h) + 30.0 * (not env.doors_open) + 30.0 * (not env.lever_on)
            # buttons still to press (a hold-button only counts once a crate sits on it: Deeba standing there does not open the door for long)
            todo = sum(1 for i, p in enumerate(env.plates) if env.plate_ch[i] == 0 and ((tuple(p) in env.continuous_plates and tuple(p) not in env.blocks)
                                                                                    or (tuple(p) not in env.continuous_plates and not (env.plate_mask >> i) & 1)))
            h += 15.0 * todo + 4.0 * env._crate_total
            heapq.heappush(heap, (env.level_steps + weight * h, next(counter), env.level_steps, new_state, path + [action]))
    return None
