"""Application logic and dispatch handlers for the The-ReaL-Exit backend API."""

import copy
import threading
import time
from typing import Any, Dict, Optional

from backend.config import DEFAULT_REWARDS, REWARD_LABELS
from backend.rl.environment import WorldEnvironment
from backend.rl.registry import get_registry_metadata
from backend.rl.trainer import RLTrainer


class BackendApp:
    """Manages active training sessions, playback environments, and API requests."""

    def __init__(self):
        self.trainer: Optional[RLTrainer] = None
        self.playback_env: Optional[WorldEnvironment] = None
        self.training_lock = threading.RLock()
        self.progress_lock = threading.Lock()
        self.training_progress: Optional[Dict[str, Any]] = None
        self.training_thread: Optional[threading.Thread] = None
        self.training_stop = threading.Event()
        self.training_paused = False
        self.training_target_steps = 0
        self.training_chunk_size = 2048
        self.training_state = "idle"
        self.training_error: Optional[str] = None

    def handle_health(self) -> Dict[str, Any]:
        """Health check endpoint returning active session status."""
        with self.training_lock:
            return {
                "status": "ok",
                "hasTrainer": self.trainer is not None,
                "trainerAlgorithm": self.trainer.algorithm_id if self.trainer else None,
                "trainingState": self.training_state,
            }

    def handle_algorithms(self) -> Dict[str, Any]:
        """List registered RL algorithms and their hyperparameter schemas."""
        return {"algorithms": get_registry_metadata()}

    def handle_rewards(self) -> Dict[str, Any]:
        """Return default reward values and readable labels."""
        return {
            "defaults": DEFAULT_REWARDS,
            "labels": REWARD_LABELS,
        }

    def handle_train_init(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Initialize or reset the RL trainer with configuration or checkpoint."""
        with self.training_lock:
            if self.training_thread and self.training_thread.is_alive():
                raise ValueError("Stop the active training run before starting another.")
            checkpoint = data.get("checkpoint")
            self.trainer = RLTrainer(
                algorithm_id=data.get("algorithm", "ppo"),
                hyperparameters=data.get("hyperparameters"),
                levels=data.get("levels"),
                seed=int(data.get("seed", 17)),
                max_episode_steps=int(data.get("maxEpisodeSteps", 240)),
                checkpoint=checkpoint,
                rewards=data.get("rewards"),
            )
            self.training_state = "initialized"
            self.training_error = None
            self.training_progress = copy.deepcopy(self.trainer.stats())
        return {
            "status": "initialized",
            "algorithm": self.trainer.algorithm_id,
            "stats": self.trainer.stats(),
        }

    def handle_train_start(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Run training continuously in a Python worker; the UI only polls summaries."""
        with self.training_lock:
            if not self.trainer:
                raise ValueError("No active training session. Call /train/init first.")
            if self.training_thread and self.training_thread.is_alive():
                raise ValueError("Training is already running.")
            self.training_target_steps = max(self.trainer.total_steps + 1, int(data.get("targetSteps", 50000)))
            self.training_chunk_size = max(64, min(8192, int(data.get("stepBudget", 2048))))
            self.training_stop.clear()
            self.training_paused = False
            self.training_error = None
            self.training_state = "running"
            self.training_thread = threading.Thread(target=self._training_worker, daemon=True, name="The-ReaL-Exit-rl-trainer")
            self.training_thread.start()
            return self._training_status_locked()

    def _training_worker(self) -> None:
        try:
            while not self.training_stop.is_set():
                if self.training_paused:
                    self.training_stop.wait(0.05)
                    continue
                with self.training_lock:
                    if not self.trainer:
                        self.training_state = "stopped"
                        return
                    remaining = self.training_target_steps - self.trainer.total_steps
                    if remaining <= 0:
                        self.training_state = "complete"
                        return
                    self.trainer.run_chunk(min(self.training_chunk_size, remaining))
                    with self.progress_lock:
                        self.training_progress = copy.deepcopy(self.trainer.stats())
                    if self.trainer.total_steps >= self.training_target_steps:
                        self.training_state = "complete"
                        return
                # Yield between batches so pause/stop requests and progress polls are responsive.
                time.sleep(0.001)
            with self.training_lock:
                self.training_state = "stopped"
        except Exception as err:
            with self.training_lock:
                self.training_error = str(err)
                self.training_state = "error"

    def _training_status_locked(self) -> Dict[str, Any]:
        return {
            "status": self.training_state,
            "state": self.training_state,
            "isComplete": self.training_state == "complete",
            "error": self.training_error,
            "targetSteps": self.training_target_steps,
            "stats": self.trainer.stats() if self.trainer else None,
        }

    def handle_train_status(self) -> Dict[str, Any]:
        with self.progress_lock:
            stats = copy.deepcopy(self.training_progress)
        return {
            "status": self.training_state,
            "state": self.training_state,
            "isComplete": self.training_state == "complete",
            "error": self.training_error,
            "targetSteps": self.training_target_steps,
            "stats": stats,
        }

    def handle_train_control(self, action: str) -> Dict[str, Any]:
        with self.training_lock:
            if not self.trainer:
                raise ValueError("No active training session.")
            if action == "pause" and self.training_state == "running":
                self.training_paused = True
                self.training_state = "paused"
            elif action == "resume" and self.training_state == "paused":
                self.training_paused = False
                self.training_state = "running"
            elif action == "stop" and self.training_state in ("running", "paused"):
                self.training_stop.set()
                self.training_paused = False
                self.training_state = "stopping"
            return self._training_status_locked()

    def handle_train_chunk(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Run a batch chunk of steps in the active trainer."""
        step_budget = int(data.get("stepBudget", 512))
        target_steps = int(data.get("targetSteps", 50000))
        with self.training_lock:
            if not self.trainer:
                raise ValueError("No active training session. Call /train/init first.")
            if self.training_state in ("running", "paused", "stopping"):
                raise ValueError("Use the background training controls while a run is active.")
            chunk_result = self.trainer.run_chunk(step_budget)
            is_complete = self.trainer.total_steps >= target_steps
        return {
            "status": "complete" if is_complete else "running",
            "isComplete": is_complete,
            **chunk_result,
        }

    def handle_train_evaluate(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate the current policy over headless episodes."""
        if not self.trainer:
            raise ValueError("No active training session to evaluate.")
        episode_count = int(data.get("episodes", 20))
        with self.training_lock:
            metrics = self.trainer.evaluate(episode_count)
        return {"status": "evaluated", "metrics": metrics}

    def handle_checkpoint_save(self) -> Dict[str, Any]:
        """Serialize current training state to a JSON checkpoint."""
        if not self.trainer:
            raise ValueError("No active trainer to checkpoint.")
        with self.training_lock:
            return {"checkpoint": self.trainer.serialize()}

    def handle_checkpoint_load(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Load and restore an existing checkpoint."""
        checkpoint = data.get("checkpoint") or data
        if not isinstance(checkpoint, dict) or checkpoint.get("format") not in {
            "worldforge-rl-checkpoint",
            "The-ReaL-Exit-rl-checkpoint",
        }:
            raise ValueError("Invalid The-ReaL-Exit checkpoint format.")

        with self.training_lock:
            if self.training_thread and self.training_thread.is_alive():
                raise ValueError("Stop training before loading a checkpoint.")
            self.trainer = RLTrainer(checkpoint=checkpoint)
            self.training_state = "loaded"
        return {
            "status": "loaded",
            "algorithm": self.trainer.algorithm_id,
            "stats": self.trainer.stats(),
            "checkpoint": checkpoint,
        }

    def handle_playback_start(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Initialize the headless playback environment for in-game observation."""
        levels = data.get("levels") or (self.trainer.levels if self.trainer else [])
        if not levels:
            raise ValueError("No levels provided for playback.")
        seed = int(data.get("seed", 431))
        rewards = data.get("rewards") or (self.trainer.rewards if self.trainer else None)
        self.playback_env = WorldEnvironment(levels, {"seed": seed, "rewards": rewards})
        obs = self.playback_env.reset()
        return {
            "status": "ready",
            "levelIndex": self.playback_env.level_index,
            "position": self.playback_env.position,
            "heading": self.playback_env.heading,
            "observation": obs,
        }

    def handle_playback_step(self, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Step the playback environment using the agent's greedy policy."""
        if not self.playback_env:
            raise ValueError("Playback environment not started. Call /playback/start first.")

        obs = self.playback_env.observe()
        state_key = self.playback_env.get_state_key()

        if self.trainer and self.trainer.agent:
            decision = self.trainer.agent.act(obs, state_key, explore=False)
            action = decision["action"]
        else:
            action = 8  # wait

        previous_pos = list(self.playback_env.position)
        result = self.playback_env.step(action)

        return {
            "action": action,
            "previousPosition": previous_pos,
            "position": self.playback_env.position,
            "heading": self.playback_env.heading,
            "doorsOpen": self.playback_env.doors_open,
            "plateMask": self.playback_env.plate_mask,
            "coinMask": self.playback_env.coin_mask,
            "levelIndex": self.playback_env.level_index,
            "deathCount": self.playback_env.death_count,
            "coins": self.playback_env.total_coins,
            "result": result,
        }


# Global app instance for the HTTP and IPC servers
app = BackendApp()

