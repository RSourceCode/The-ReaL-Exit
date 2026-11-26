"""Unit and integration tests for the Python RL package."""

import json
import unittest

import numpy as np

from backend.config import ACTIONS, OBSERVATION_SIZE, SCALAR_FEATURES, STATIC_CHANNELS, LOCAL_VIEW_CHANNELS, LOCAL_VIEW_SIZE
from backend.levels import LEGACY_SPECS, expand_level, legacy_campaign, make_level, migrate_level, mirror_level, starter_campaign
from backend.rl.environment import WorldEnvironment
from backend.rl.registry import get_algorithm
from backend.rl.trainer import RLTrainer


def make_test_level():
    """Create a minimal 7x7 level with a plate, a coin and an exit door."""
    return {
        "name": "Test Level",
        "size": 7,
        "start": [3, 1],
        "walls": [[0, 0], [6, 6]],
        "blocks": [],
        "hazards": [],
        "rotators": [],
        "movers": [],
        "plates": [[3, 3]],
        "coins": [[3, 2]],
        "switches": [],
        "exitDoor": [3, 6],
        "goal": [3, 6],
    }


class TestEnvironment(unittest.TestCase):
    def setUp(self):
        self.level = make_test_level()

    def test_observation_shape_and_start(self):
        env = WorldEnvironment([self.level], {"seed": 42})
        obs = env.reset()
        self.assertEqual(obs.shape, (OBSERVATION_SIZE,))
        self.assertEqual(env.position, [3, 1])
        self.assertFalse(env.doors_open)

    def test_step_collects_coin(self):
        env = WorldEnvironment([self.level], {"seed": 42})
        env.reset()
        res = env.step(0)  # forward (+Z)
        self.assertEqual(env.position, [3, 2])
        self.assertEqual(res["coins"], 1)
        self.assertFalse(res["done"])

    def test_full_clear_and_shaping_is_potential_based(self):
        env = WorldEnvironment([self.level], {"seed": 1, "randomPhase": False})
        env.reset()
        total = 0.0
        for _ in range(5):
            res = env.step(0)
            total += res["reward"]
        self.assertTrue(res["done"] and res["success"])
        self.assertGreater(total, 10.0)

    def test_compass_points_at_plate_then_exit(self):
        env = WorldEnvironment([self.level], {"seed": 1})
        obs = env.reset()
        compass = obs[LOCAL_VIEW_SIZE:LOCAL_VIEW_SIZE + 4]
        self.assertEqual(compass[0], 1.0)  # forward is closer
        self.assertEqual(compass[1], -1.0)  # backward is farther

    def test_action_mask_blocks_walls_and_useless_jump(self):
        env = WorldEnvironment([self.level], {"seed": 1})
        env.reset()
        mask = env.action_mask()
        self.assertTrue(mask[0])  # forward is open
        self.assertFalse(mask[6])  # nothing to jump over
        self.assertFalse(mask[7])  # no switch ahead
        self.assertTrue(mask[8])  # wait is always fine

    def test_danger_layers_see_the_rotating_bar(self):
        level = {**legacy_campaign(1)[0], "start": [8, 10]}  # two cells from the bar's hub at (8, 12)
        env = WorldEnvironment([level], {"seed": 3})
        flagged = 0
        for _ in range(12):
            obs = env.observe()
            danger = obs[:LOCAL_VIEW_SIZE].reshape(LOCAL_VIEW_CHANNELS, 9, 9)[STATIC_CHANNELS:]
            flagged += int(danger.sum() > 0)
            env.step(8)  # wait
        self.assertGreater(flagged, 0)
        # the hub cell itself is always swept, in every look-ahead layer
        self.assertTrue(danger[:, 2, 4].all())

    def test_hazard_kills_and_jump_clears_it(self):
        level = {**make_test_level(), "hazards": [[3, 2]], "coins": []}
        env = WorldEnvironment([level], {"seed": 1, "randomPhase": False})
        env.reset()
        self.assertFalse(env.action_mask()[0])  # stepping on lava is masked
        self.assertTrue(env.action_mask()[6])  # jumping over it is allowed
        res = env.step(6)
        self.assertEqual(env.position, [3, 3])
        self.assertFalse(res["death"])
        env.reset()
        self.assertTrue(env.step(0)["death"])  # unmasked step into lava still kills

    def test_random_start_level(self):
        env = WorldEnvironment(legacy_campaign(4), {"seed": 5, "randomStartLevel": True})
        seen = {env.reset() is not None and env.level_index for _ in range(40)}
        self.assertGreater(len(seen), 1)


class TestAgents(unittest.TestCase):
    def setUp(self):
        self.level = make_test_level()

    def _run(self, algo: str):
        trainer = RLTrainer(algorithm_id=algo, levels=[self.level], seed=17, max_episode_steps=50,
                            hyperparameters={"parallelInstances": 4, "learnStart": 200})
        res = trainer.run_chunk(step_budget=512)
        self.assertGreaterEqual(res["transitions"], 512)
        self.assertIn("meanReward", res)
        checkpoint = json.loads(json.dumps(trainer.serialize()))  # must be JSON-safe
        self.assertEqual(checkpoint["format"], "worldforge-rl-checkpoint")
        restored = RLTrainer(checkpoint=checkpoint)
        self.assertEqual(restored.total_steps, trainer.total_steps)
        self.assertEqual(restored.algorithm_id, algo)
        obs = np.zeros(OBSERVATION_SIZE, dtype=np.float32)
        a = restored.agent.act(obs, "", explore=False)
        self.assertTrue(0 <= a["action"] < len(ACTIONS))

    def test_ppo_runs_and_checkpoints(self):
        self._run("ppo")

    def test_dqn_runs_and_checkpoints(self):
        self._run("dqn")

    def test_random_agent(self):
        agent = get_algorithm("random").create_agent({"seed": 10})
        act = agent.act(np.zeros(OBSERVATION_SIZE), "", True)
        self.assertTrue(0 <= act["action"] < len(ACTIONS))

    def test_evaluation_reports_per_level_rates(self):
        trainer = RLTrainer(algorithm_id="random", levels=[self.level], seed=99, max_episode_steps=20)
        metrics = trainer.evaluate(episode_count=3)
        self.assertEqual(metrics["episodes"], 3)
        self.assertEqual(len(metrics["perLevelClearRate"]), 1)


class TestLearning(unittest.TestCase):
    def test_ppo_learns_the_starter_campaign_quickly(self):
        """The regression test for the whole redesign: ~100k steps must be enough."""
        campaign = legacy_campaign()
        # the crate-on-a-hold-button puzzle (level 2) needs far more than 100k steps from scratch; the solver covers it
        levels = [campaign[0], campaign[2], campaign[3]]
        trainer = RLTrainer(algorithm_id="ppo", levels=levels, seed=4, max_episode_steps=300)
        trainer.set_target_steps(100_000)
        while trainer.total_steps < 100_000:
            trainer.run_chunk(8192)
        result = trainer.evaluate(30)
        self.assertGreaterEqual(result["successRate"], 0.6, result)

class SkywayFeatureTests(unittest.TestCase):
    def test_every_campaign_level_loads_and_observes(self):
        for level in legacy_campaign():
            env = WorldEnvironment([level], {"seed": 1})
            obs = env.reset()
            self.assertEqual(obs.shape[0], OBSERVATION_SIZE)

    def test_ledge_jump_gains_height_and_plate_on_top_counts(self):
        level = legacy_campaign(1)[0]
        env = WorldEnvironment([level], {"seed": 2})
        env.reset()
        self.assertGreater(len(level["platforms"]), 0)

    def test_lift_top_is_periodic_and_rests_when_unpowered(self):
        env = WorldEnvironment([legacy_campaign()[4]], {"seed": 1})
        env.reset()
        env.lever_on = False
        self.assertEqual(env.lift_top(0, 3.0), env.lift_top(0, 9.0))
        env.lever_on = True
        tops = {round(env.lift_top(0, t / 4), 2) for t in range(60)}
        self.assertGreater(max(tops), 1.0)


class LabHazardTests(unittest.TestCase):
    def _env(self, **fields):
        level = make_level(0, LEGACY_SPECS)
        level.update({"walls": [], "platforms": [], "plates": [], "rotators": [], "hazards": [], "lasers": [], "shocks": [], "cutters": [], "spikes": []})
        level.update(fields)
        env = WorldEnvironment([level], {"seed": 1})
        env.reset()
        return env

    def test_laser_sweeps_along_any_axis_and_height_matters(self):
        env = self._env(lasers=[[6, 6, "x", 2, 3, "z", 0.5, 1.0]])
        hit_cells = {c for t in np.arange(0, 7, 0.1) for c, k in env.hazard_cells(float(t)).items() if "laser" in k}
        self.assertTrue(any(x != 6 for x, _ in hit_cells), "a laser sweeping along x must visit several columns")
        # a beam at 0.5 m cuts a walker (feet 0) but not somebody standing on a 1.1 m ledge
        t = next(float(t) for t in np.arange(0, 7, 0.05) if (6, 6) in env.hazard_cells(float(t)))
        self.assertFalse(env._kind_lethal("laser", (6, 6), 1.12, t))
        vertical = self._env(lasers=[[6, 6, "y", 0.9, 2, "x", 1.0, 1.0]])
        offsets = {round(vertical.laser_offset(0, float(t)), 1) for t in np.arange(0, 7, 0.1)}
        self.assertGreater(max(offsets), 0.5)

    def test_shock_charges_then_strikes_only_in_its_reach(self):
        env = self._env(shocks=[[6, 6, "xp", 2, 3.0, 0.5]])
        strikes = [float(t) for t in np.arange(0, 6, 0.05) if env.dynamic_hit((7, 6), float(t))]
        self.assertTrue(strikes)
        self.assertIsNone(env.dynamic_hit((9, 6), strikes[0]), "beyond the configured reach nothing is hit")
        idle = [float(t) for t in np.arange(0, 3, 0.05) if env.shock_phase(0, float(t)) < 0.45]
        self.assertTrue(all(env.dynamic_hit((7, 6), t) is None for t in idle))

    def test_cutter_and_spikes(self):
        env = self._env(cutters=[[6, 6, "x", 2, 0.5, 1.0]], spikes=[[3, 3, 0]])
        self.assertEqual(env.dynamic_hit((3, 3), 1.0), "spikes")
        self.assertIsNone(env._kind_lethal("spikes", (3, 3), 1.12, 1.0) or None)
        seen = {c[0] for t in np.arange(0, 6, 0.1) for c, k in env.hazard_cells(float(t)).items() if "cutter" in k}
        self.assertGreaterEqual(len(seen), 3)

    def test_resize_expands_footprints_and_migration_upgrades_old_levels(self):
        level = make_level(0, LEGACY_SPECS)
        level["walls"] = [[3, 3]]
        level["objectProperties"] = {"wall:3:3": {"w": 3, "d": 2, "height": 1.0}}
        grown = expand_level(level)
        self.assertEqual(len(grown["walls"]), 6)
        self.assertEqual(grown["objectProperties"]["wall:5:4"]["height"], 1.0)
        old = {"movingLasers": [[6, 6, "z", 1, 5]], "lasers": [[2, 2]], "electricBarriers": [[4, 4]]}
        migrated = migrate_level(old)
        self.assertEqual(len(migrated["lasers"]), 1)
        self.assertEqual(migrated["shocks"][0][2], "down")

    def test_acid_and_shock_deaths_get_their_own_reward(self):
        acid = self._env(hazards=[[8, 3]])
        res = acid.step(0)  # forward (+Z) straight into the acid
        self.assertTrue(res["hazard"] and res["death"] and not res["success"])
        self.assertLessEqual(res["reward"], -2.0)
        from backend.config import DEFAULT_REWARDS
        self.assertLess(DEFAULT_REWARDS["shockHit"], DEFAULT_REWARDS["spikeHit"])


class WorldSizeTests(unittest.TestCase):
    """Rooms are no longer always 17 x 17: width and depth are per level."""

    def test_long_levels_are_rectangular_with_a_door_in_the_wall(self):
        from backend.levels import CAMPAIGN_SPECS, boundary_walls
        self.assertGreaterEqual(len(CAMPAIGN_SPECS), 10)
        sizes = set()
        for index in range(len(CAMPAIGN_SPECS)):
            level = make_level(index)
            w, d = level["width"], level["depth"]
            sizes.add((w, d))
            door = level["exitDoor"]
            self.assertTrue(door[0] in (0, w - 1) or door[1] in (0, d - 1), f"{level['name']}: door must be in the outer wall")
            self.assertEqual(len(boundary_walls(door, w, d)), 2 * (w + d) - 4 - 1)
            self.assertTrue(1 <= level["start"][0] <= w - 2 and 1 <= level["start"][1] <= d - 2)
        self.assertGreater(len(sizes), 3)

    def test_environment_uses_the_level_dimensions(self):
        levels = [make_level(i) for i in range(6, 10)]
        env = WorldEnvironment(levels)
        for index, level in enumerate(levels):
            obs = env.reset(index)
            self.assertEqual((env.size_x, env.size_z), (level["width"], level["depth"]))
            self.assertEqual(len(obs), OBSERVATION_SIZE)
        self.assertNotEqual(env.size_x, env.size_z)

    def test_stray_doors_snap_to_the_nearest_wall(self):
        from backend.levels import snap_door_to_wall
        self.assertEqual(snap_door_to_wall([8, 15], 17, 17), [8, 16])
        self.assertEqual(snap_door_to_wall([1, 8], 17, 17), [0, 8])
        self.assertEqual(snap_door_to_wall([8, 16], 17, 17), [8, 16])
        self.assertEqual(snap_door_to_wall([0, 0], 17, 17), [0, 2])   # never in a corner

    def test_old_levels_migrate_to_explicit_dimensions(self):
        level = migrate_level({"size": 13, "exitDoor": [6, 11], "walls": [], "start": [6, 2]})
        self.assertEqual((level["width"], level["depth"]), (13, 13))
        self.assertEqual(level["exitDoor"], [6, 12])


def _kinds(level):
    """Which gameplay ingredients a level uses (for checking the curriculum introduces them one at a time)."""
    k = set()
    for field, name in (("plates", "button"), ("ice", "ice"), ("water", "water"), ("hazards", "acid"), ("spikes", "spikes"),
                        ("lasers", "laser"), ("shocks", "shock"), ("cutters", "cutter"), ("rotators", "spinner"),
                        ("blocks", "crate"), ("lifts", "lift"), ("powerups", "boost")):
        if level.get(field):
            k.add(name)
    if len(level.get("walls", [])) > 2 * (level["width"] + level["depth"]) - 5:
        k.add("walls")
    return k


class CurriculumTests(unittest.TestCase):
    """The campaign is a curriculum: simple first, one new idea per level, and every room (and its mirror image) can be won."""

    def test_each_level_adds_at_most_one_new_idea(self):
        seen = set()
        for index, level in enumerate(starter_campaign(11)):
            new = _kinds(level) - seen
            allowed = 2 if level["name"] in ("Press the Button", "Ice & Pond", "Saw & Spinner") else 1
            self.assertLessEqual(len(new), allowed, f"{level['name']} introduces too much at once: {sorted(new)}")
            if index == 0:
                self.assertEqual(_kinds(level), set(), "the first level is just the door")
            seen |= _kinds(level)
        self.assertLessEqual(len(starter_campaign()), 18, "keep the campaign short: training time grows with every level")

    def test_every_level_and_its_mirror_image_is_solvable(self):
        from backend.tests.solver import solve_level
        for level in starter_campaign(11):
            for variant in (level, mirror_level(level)):
                self.assertIsNotNone(solve_level(variant, max_nodes=40000, weight=6.0), f"{variant['name']} cannot be solved")

    def test_mirroring_twice_returns_the_original(self):
        for level in starter_campaign():
            twice = mirror_level(mirror_level(level))
            for field in ("walls", "coins", "plates", "hazards", "lasers", "shocks", "cutters", "spikes", "ice", "water", "lifts", "blocks", "levers"):
                self.assertEqual(sorted(map(tuple, level[field])), sorted(map(tuple, twice[field])), field)
            self.assertEqual((level["start"], level["exitDoor"]), (twice["start"], twice["exitDoor"]))


EXPERT_SOLUTIONS = {"11": [0, 0, 3, 3, 3, 0, 0, 0, 0, 2, 2, 2, 2, 0, 0, 0, 0, 3, 0], "12": [0, 0, 3, 3, 3, 3, 3, 1, 1, 2, 0, 3, 0, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 3, 3, 0], "13": [0, 2, 2, 2, 0, 0, 2, 0, 3, 3, 1, 3, 0, 0, 0, 0, 0, 3, 0, 2, 2, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 0, 0, 0, 3, 0, 2, 2, 2, 1, 2, 0, 0, 0, 0, 0, 2, 0, 3, 3, 0, 0, 0, 2, 2, 0], "14": [0, 0, 0, 3, 3, 3, 0, 0, 0, 0, 0, 2, 2, 4, 6, 6, 6, 1, 1, 1, 3, 3, 0, 3, 3, 3], "15": [0, 0, 0, 6, 6, 6, 6, 6, 0, 0, 0], "16": [0, 0, 0, 3, 3, 3, 3, 5, 6, 0, 0, 0, 0, 2, 2, 2, 0, 2, 1, 1, 1, 1, 2, 1, 0, 3, 4, 2, 2, 2, 2, 2, 0, 0, 0, 2, 2, 0, 0, 0, 0, 3, 3, 3, 3, 3, 3, 3, 3, 5, 6, 6, 6, 1, 1, 1, 2, 2, 0, 0, 2, 4, 6, 0, 0]}
FINALE_MIRROR_SOLUTION = [0, 0, 0, 2, 2, 2, 2, 4, 6, 0, 0, 0, 0, 3, 3, 3, 0, 3, 1, 1, 1, 1, 3, 1, 0, 2, 4, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3, 3, 5, 6, 6, 6, 1, 1, 1, 3, 3, 0, 0, 3, 3, 3, 3, 3]
_MIRROR_ACTION = {2: 3, 3: 2, 4: 5, 5: 4}     # strafe left/right and turn left/right swap in a mirror image


def _replay(level, actions):
    env = WorldEnvironment([level], {"seed": 3, "randomPhase": False})
    env.reset(0)
    result = None
    for action in actions:
        result = env.step(action)
        if result["death"]:
            return False
        if result["done"] and result["success"]:
            return True
    return bool(result and result["done"] and result["success"])


class ExpertLevelTests(unittest.TestCase):
    """Levels 12-17 (crate puzzles and pillar climbs).  Recorded winning runs - found with solver.py / a phased search -
    must still win, on the level and on its mirror image."""

    def test_recorded_solutions_win_each_expert_level(self):
        campaign = starter_campaign()
        self.assertGreaterEqual(len(campaign), 17)
        for key, actions in EXPERT_SOLUTIONS.items():
            level = campaign[int(key)]
            self.assertTrue(_replay(level, actions), f"{level['name']}: recorded run no longer wins")
            mirrored = mirror_level(level)
            mirror_actions = FINALE_MIRROR_SOLUTION if level["name"] == "Grand Finale" else [_MIRROR_ACTION.get(a, a) for a in actions]
            self.assertTrue(_replay(mirrored, mirror_actions), f"{level['name']} (mirrored): recorded run no longer wins")

    def test_crate_plan_leads_behind_the_crate_then_into_it(self):
        env = WorldEnvironment([starter_campaign()[11]], {"seed": 1, "randomPhase": False})   # One Push
        env.reset(0)
        self.assertEqual(env._crate_total, 1)
        crate = next(iter(env.blocks))
        stand = env._targets[0]
        self.assertNotEqual(stand, crate)                         # first it sends the walker to the cell behind the crate…
        self.assertEqual(abs(stand[0] - crate[0]) + abs(stand[1] - crate[1]), 1)
        env.position = list(stand)
        env._refresh_objective()
        self.assertEqual(env._targets, [crate])                   # …and once there, into the crate

    def test_hold_button_and_door_bonuses_are_paid_once(self):
        """Stepping on and off a hold-button must not be a way to farm reward (the agent found exactly that)."""
        level = {**starter_campaign()[11]}
        env = WorldEnvironment([level], {"seed": 1, "randomPhase": False})
        env.reset(0)
        plate = env.plates[0]
        env.blocks = set()                          # no crate: only Deeba can press it
        env._sync_dynamic()
        paid = 0.0
        for _ in range(6):                          # on, off, on, off, on, off
            for cell, flag in ((tuple(plate), True), ((plate[0] + 1, plate[1]), False)):
                env.position = [cell[0], cell[1]]
                result = env.step(8)                # wait a tick
                paid += result["reward"] if result["reward"] > 1.0 else 0.0
        self.assertLessEqual(paid, 8.0, "plate / door bonuses were paid repeatedly")

    def test_pillars_need_consecutive_jumps(self):
        level = starter_campaign()[14]              # Pillar Steps
        heights = sorted(v["height"] for k, v in level["objectProperties"].items() if k.startswith("platform:"))
        self.assertEqual(len(heights), 3)
        self.assertTrue(all(b - a <= 1.3 for a, b in zip([0.0] + heights, heights)), "each step must be within one jump")
        self.assertTrue(all(b - a >= 0.6 for a, b in zip([0.0] + heights, heights)), "steps are too low to count as jumps")


class CurriculumTrainerTests(unittest.TestCase):
    def test_curriculum_unlocks_levels_in_order_and_samples_only_unlocked_ones(self):
        from backend.rl.trainer import Curriculum
        c = Curriculum(4, True, window=10, threshold=0.9, min_episodes=5)
        self.assertEqual(c.unlocked, 1)
        self.assertEqual({c.sample() for _ in range(50)}, {0})
        unlocked_now = [c.record(0, True) for _ in range(5)]
        self.assertTrue(unlocked_now[-1])
        self.assertEqual(c.unlocked, 2)
        self.assertEqual({c.sample() for _ in range(200)}, {0, 1})
        self.assertFalse(c.mastered_in_training())
        for level in (1, 2, 3):
            for _ in range(5):
                c.record(level, True)
        self.assertEqual(c.unlocked, 4)
        for _ in range(5):
            c.record(3, True)
        self.assertTrue(c.mastered_in_training())

    def test_training_masters_the_first_levels_and_stops_by_itself(self):
        campaign = starter_campaign(4)
        trainer = RLTrainer("ppo", {}, campaign, seed=17, options={"masteryThreshold": 0.9})
        trainer.set_target_steps(150000)
        while trainer.total_steps < 150000 and not trainer.solved:
            trainer.run_chunk(2048)
        self.assertTrue(trainer.solved, "four easy levels should be mastered well inside 150k steps")
        self.assertEqual(trainer.curriculum.unlocked, 4)
        self.assertEqual(trainer.stats()["curriculum"]["count"], 4)
        self.assertTrue(all(r >= 0.9 for r in trainer.verification["rates"]))
        restored = RLTrainer(checkpoint=json.loads(json.dumps(trainer.serialize())))
        self.assertTrue(restored.solved)
        self.assertEqual(restored.curriculum.unlocked, 4)

    def test_training_levels_include_mirrored_copies(self):
        trainer = RLTrainer("random", {}, starter_campaign(3), seed=1)
        self.assertEqual(len(trainer.train_levels), 6)
        trainer.run_chunk(256)
        self.assertEqual(len(trainer.parallel_envs[0].levels), 6)


if __name__ == "__main__":
    unittest.main()
