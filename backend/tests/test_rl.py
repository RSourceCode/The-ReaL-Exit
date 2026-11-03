"""Unit and integration tests for the Python RL package."""

import unittest
from backend.config import ACTIONS, DEFAULT_REWARDS
from backend.rl.environment import WorldEnvironment
from backend.rl.trainer import RLTrainer
from backend.rl.registry import ALGORITHM_REGISTRY, get_algorithm


def make_test_level():
    """Create a minimal 7x7 level with a plate and an exit door."""
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


class TestWorldRL(unittest.TestCase):
    def setUp(self):
        self.level = make_test_level()

    def test_environment_initialization(self):
        env = WorldEnvironment([self.level], {"seed": 42})
        obs = env.reset()
        self.assertEqual(len(obs), 726)
        self.assertEqual(env.position, [3, 1])
        self.assertEqual(env.heading, 0)
        self.assertFalse(env.doors_open)

    def test_environment_step(self):
        env = WorldEnvironment([self.level], {"seed": 42})
        env.reset()
        # Action 0: move forward (+Z in heading 0)
        res = env.step(0)
        self.assertEqual(env.position, [3, 2])
        self.assertEqual(res["coins"], 1)  # Collected coin at [3, 2]
        self.assertFalse(res["done"])

    def test_random_agent(self):
        algo = get_algorithm("random")
        agent = algo.create_agent({"seed": 10})
        obs = [0.0] * 726
        act = agent.act(obs, "key", True)
        self.assertIn("action", act)
        self.assertTrue(0 <= act["action"] < len(ACTIONS))

    def test_ppo_agent_learning(self):
        trainer = RLTrainer(
            algorithm_id="ppo",
            levels=[self.level],
            seed=17,
            max_episode_steps=50,
        )
        res = trainer.run_chunk(step_budget=64)
        self.assertGreaterEqual(res["transitions"], 64)
        self.assertIn("meanReward", res)

        checkpoint = trainer.serialize()
        self.assertEqual(checkpoint["format"], "worldforge-rl-checkpoint")
        self.assertEqual(checkpoint["algorithm"], "ppo")

        # Verify restoring from checkpoint
        restored = RLTrainer(checkpoint=checkpoint)
        self.assertEqual(restored.total_steps, trainer.total_steps)
        self.assertEqual(restored.algorithm_id, "ppo")

    def test_dqn_agent_learning(self):
        trainer = RLTrainer(
            algorithm_id="dqn",
            levels=[self.level],
            seed=23,
            max_episode_steps=50,
        )
        res = trainer.run_chunk(step_budget=64)
        self.assertGreaterEqual(res["transitions"], 64)
        checkpoint = trainer.serialize()
        self.assertEqual(checkpoint["algorithm"], "dqn")
        restored = RLTrainer(checkpoint=checkpoint)
        self.assertEqual(restored.total_steps, trainer.total_steps)

    def test_evaluation(self):
        trainer = RLTrainer(
            algorithm_id="random",
            levels=[self.level],
            seed=99,
            max_episode_steps=20,
        )
        eval_metrics = trainer.evaluate(episode_count=3)
        self.assertEqual(eval_metrics["episodes"], 3)
        self.assertIn("successRate", eval_metrics)
        self.assertIn("meanReward", eval_metrics)


if __name__ == "__main__":
    unittest.main()

