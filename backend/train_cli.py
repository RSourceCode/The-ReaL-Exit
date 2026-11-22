"""Headless training from the terminal (no Electron needed).

Examples
--------
    python -m backend.train_cli --steps 300000 --out checkpoints/ppo.json
    python -m backend.train_cli --levels-file my-levels.json --steps 500000
    python -m backend.train_cli --resume checkpoints/ppo.json --steps 600000

The checkpoint written here loads straight into the AI Lab ("Load checkpoint"), where you can
evaluate it or watch it play in the 3D game.  ``--levels-file`` accepts a JSON list of levels or a
single exported world (the editor's "Export" button).
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.levels import starter_campaign  # noqa: E402
from backend.rl.trainer import RLTrainer  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description="Train a The-ReaL-Exit agent headlessly.")
    parser.add_argument("--algo", default="ppo", choices=["ppo", "dqn", "random"])
    parser.add_argument("--steps", type=int, default=400_000, help="maximum environment steps (training stops earlier once every level is mastered)")
    parser.add_argument("--levels", type=int, default=11, help="number of campaign levels to use (1-11)")
    parser.add_argument("--levels-file", help="JSON file with a list of levels (or one level)")
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--max-episode-steps", type=int, default=300)
    parser.add_argument("--out", default="checkpoints/the-real-exit-curriculum-ppo.json")
    parser.add_argument("--no-curriculum", action="store_true", help="sample every level from the start instead of unlocking them in order")
    parser.add_argument("--no-augment", action="store_true", help="do not also train on mirrored copies of the levels")
    parser.add_argument("--no-early-stop", action="store_true", help="keep training to --steps even after every level is mastered")
    parser.add_argument("--mastery", type=float, default=0.95, help="clear rate every level must reach to count as mastered")
    parser.add_argument("--resume", help="continue training from a checkpoint file")
    parser.add_argument("--eval-episodes", type=int, default=50)
    parser.add_argument("--hp", default="{}", help='hyper-parameter overrides as JSON, e.g. \'{"learningRate": 0.0005}\'')
    args = parser.parse_args()

    if args.resume:
        trainer = RLTrainer(checkpoint=json.loads(Path(args.resume).read_text()))
    else:
        if args.levels_file:
            data = json.loads(Path(args.levels_file).read_text())
            levels = data if isinstance(data, list) else data.get("levels", [data])
        else:
            levels = starter_campaign(max(1, min(11, args.levels)))
        trainer = RLTrainer(
            algorithm_id=args.algo, hyperparameters=json.loads(args.hp), levels=levels,
            seed=args.seed, max_episode_steps=args.max_episode_steps,
            options={"curriculum": not args.no_curriculum, "augment": not args.no_augment,
                     "stopWhenMastered": not args.no_early_stop, "masteryThreshold": args.mastery},
        )
    trainer.set_target_steps(args.steps)

    print(f"Training {trainer.algorithm_id.upper()} on {len(trainer.levels)} level(s) · target {args.steps:,} steps")
    start = time.time()
    last_print = 0
    while trainer.total_steps < args.steps and not (trainer.options["stopWhenMastered"] and trainer.solved):
        trainer.run_chunk(min(8192, args.steps - trainer.total_steps))
        if trainer.total_steps - last_print >= 16384 or trainer.total_steps >= args.steps:
            last_print = trainer.total_steps
            s = trainer.stats()
            rate = trainer.total_steps / max(1e-6, time.time() - start)
            print(f"{trainer.total_steps:>9,} steps · {rate:,.0f} steps/s · level-clear {s['successRate']:.0%}"
                  f" · reward {s['meanReward']:.1f} · deaths {s['meanDeaths']:.2f}"
                  f" · unlocked {s['curriculum']['unlocked']}/{s['curriculum']['count']}", flush=True)

    if trainer.solved:
        print(f"\nAll levels mastered after {trainer.total_steps:,} steps ({time.time() - start:.0f} s).")

    result = trainer.evaluate(args.eval_episodes)
    print("\nEvaluation (greedy, real game rules, full campaign):")
    print(f"  campaign success {result['successRate']:.0%} · levels cleared {result['meanLevels']:.1f}"
          f" · steps {result['meanSteps']:.0f} · deaths {result['meanDeaths']:.2f}")
    print("  per-level clear rate:", " ".join(f"L{i + 1}:{r:.0%}" for i, r in enumerate(result["perLevelClearRate"])))

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(trainer.serialize()))
    print(f"\nCheckpoint written to {out} ({os.path.getsize(out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
