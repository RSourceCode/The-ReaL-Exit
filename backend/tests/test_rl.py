"""Unit and integration tests for the Python RL package."""

import json
import unittest

import numpy as np

from backend.config import ACTIONS, OBSERVATION_SIZE
from backend.levels import starter_campaign
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
        compass = obs[-16:-12]
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
        level = {**starter_campaign(1)[0], "start": [6, 6]}  # two cells from the bar's hub at (6, 8)
        env = WorldEnvironment([level], {"seed": 3})
        flagged = 0
        for _ in range(12):
            obs = env.observe()
            danger = obs[:14 * 81].reshape(14, 9, 9)[10:]
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
        env = WorldEnvironment(starter_campaign(4), {"seed": 5, "randomStartLevel": True})
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
        trainer = RLTrainer(algorithm_id="ppo", levels=starter_campaign(4), seed=4, max_episode_steps=300)
        trainer.set_target_steps(100_000)
        while trainer.total_steps < 100_000:
            trainer.run_chunk(8192)
        result = trainer.evaluate(30)
        self.assertGreaterEqual(result["successRate"], 0.9, result)


if __name__ == "__main__":
    unittest.main()
