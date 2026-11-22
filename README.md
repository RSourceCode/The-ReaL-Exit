# The-ReaL-Exit
Will Deeba Survive the challenges given by Deeborah?

The-ReaL-Exit is a desktop 3D sandbox and reinforcement learning testbed built with Electron, Three.js, Rapier rigid-body physics, and a Python RL backend.

The renderer runs locally in the desktop window in JavaScript, while all headless RL simulation, algorithms (PPO, DQN, Random), training orchestration, and checkpoint serialization are implemented completely in Python.

## Architecture

- **`backend/`**: Python backend and RL package (requires Python 3.10+ and NumPy; install dependencies from `backend/requirements.txt`).
  - **`backend/config.py`**: Observation dimensions, discrete actions, and default reward structure.
  - **`backend/app.py`**: Application state and API endpoint dispatch handlers.
  - **`backend/server.py`**: Lightweight HTTP/REST server providing JSON endpoints on `http://127.0.0.1:5050`.
  - **`backend/ipc.py`**: Standard I/O (stdin/stdout) JSON-RPC handler for direct IPC.
  - **`backend/rl/environment.py`**: Headless grid simulator (`WorldEnvironment`) executing moves, line-of-sight checks, and hazard physics.
  - **`backend/rl/trainer.py`**: Batch runner (`RLTrainer`) managing chunked simulation, the adaptive `Curriculum`, mastery detection, evaluation, and checkpoint serialization.
  - **`backend/rl/registry.py`**: Algorithm registry exposing PPO, DQN, and Random baseline metadata.
  - **`backend/rl/algorithms/`**:
    - `ppo.py`: Discrete clipped PPO policy with GAE and tabular state-value estimation.
    - `dqn.py`: Neural Q-network with experience replay, target network synchronization, and Adam optimizer.
    - `random_agent.py`: Uniform random baseline agent.
  - **`backend/tests/test_rl.py`**: Unit test suite for RL simulation and agent learning.
- **`desktop/`**: Desktop UI and 3D client.
  - **`desktop/main.cjs`**: Electron main process; automatically launches and stops the Python backend server.
  - **`desktop/world.js`**: Application bootstrap entry point.
  - **`desktop/js/`**: Modular ES modules for 3D graphics, physics, camera, editor, and UI.
    - `builder.js`: Three.js geometry construction for level pieces and decorative lighting.
    - `physics.js`: Rapier 3D physics integration, character movement, and collision solvers.
    - `camera.js`: Camera views (Isometric, Top-down, 3rd Person follow, 1st Person).
    - `player.js`: Character controls and keyboard input.
    - `editor.js`: Level editor tools, cursor placement, object inspector and world resizing.
    - `deaths.js`, `liquid.js`, `locomotion.js`: per-obstacle death animations, liquid shader, ground/ice movement model.
    - `game.js`: Campaign progression, pressure plates, timers, and win conditions.
    - `rl_client.js`: HTTP API client connecting the UI to the Python RL backend.
    - `rl_ui.js`: AI Lab training dashboard, live canvas reward charts, and parameter controls.
    - `rl_playback.js`: In-game 3D checkpoint playback controller.
    - `ui.js`: Navigation tabs, fullscreen focus mode, and notifications.

## Run in development

1. Install [Node.js](https://nodejs.org/) and Python 3.10+.
2. Install the Python RL dependency:
   ```bash
   python -m pip install -r backend/requirements.txt
   ```
3. From this folder, install desktop dependencies:
   ```bash
   npm install
   ```
4. Run the desktop application:
   ```bash
   npm run desktop
   ```
   Electron automatically starts the Python backend on `http://127.0.0.1:5050`.

## Run Python RL Tests

To verify the Python RL environment and training algorithms:
```bash
python -m unittest backend/tests/test_rl.py
```

## Run Python Backend Standalone

You can run the Python backend server independently:
```bash
python -m backend.server --port 5050
```

## Build a Windows installer

Run `npm run dist:win`. The installer will be written to `release/`.

Saved worlds are stored in the app's local browser storage on this computer. The game itself works offline.

## Deeba's Skyway upgrade
Continuous floating-island world, Rapier kinematic character controller (acceleration, ice/air friction, variable jump,
coyote time, jump buffer, auto-step, lift carry, pushable crates), scanning lasers with burst death, lever lifts,
climbable ledges with plates/coins on top, wardrobe shop (coins), glass UI, generative soundtrack and SFX.
Levels live in `backend/levels.py`; regenerate the JS copy with `python -m backend.tools.gen_levels`.

## CatLab upgrade (lab theme, resizable pieces, new hazards)

**Setting.** The level is now a closed laboratory: tiled floor, panelled steel walls on all four sides (the camera can
look in from outside like a dollhouse), a ceiling with light panels, pipes, screens and hazard striping. The campaign is
deliberately short: six rooms.

**Hazards** (all are pure functions of the world clock, mirrored in `desktop/js/constants.js` and
`backend/rl/environment.py`):

| Piece | List / format | Behaviour |
| --- | --- | --- |
| Laser | `lasers: [x, z, sweep, range, half, beam, y, speed]` | A beam that **sweeps along any axis** (`sweep` = x / y / z) and extends along any other (`beam`). Lethal if it crosses Deeba's body; standing on a ledge above a low beam is safe. The old fixed laser is gone and the old *scanner* is now simply "laser". |
| Shock | `shocks: [x, z, dir, length, period, y]` | The electric gate: an emitter that idles, charges (visible warning), then strikes **in one direction** (`down`, `up`, `xp`, `xn`, `zp`, `zn`) for exactly `length`. |
| Cutter | `cutters: [x, z, axis, range, radius, speed]` | Saw blade riding a floor groove; jump over it. |
| Spikes | `spikes: [x, z, period]` | Floor spikes; `period` 0 = always out, otherwise they pop out on a timer (warning blink first). |
| Acid | `hazards` | Lethal pool (was lava). |
| Water | `water` | Harmless wade (small RL step cost). |

Old saved levels are migrated automatically (`movingLasers` → `lasers`, fixed lasers dropped, `electricBarriers` →
`shocks`).

**Editor.** Pick *Select* and click a piece: the inspector appears only for the selected piece and shows just its own
settings. Selected pieces also show drag handles (red = X, green = Y, blue = Z) to resize walls / ledges / acid / ice /
water (`objectProperties["wall:x:z"] = {w, d, height}`), crates (size and height), a laser's sweep range, length and
height, a shock's reach, a cutter's rail and radius, and a lift's top.

**Stability fixes.** The physics loop is capped at 6 sub-steps per frame (no more spiral-of-death hangs), the player
body is moved immediately after each controller step (no one-step-late collider), a NaN / out-of-room guard respawns
Deeba at the start, a ceiling lid closes the room, the character controller is released on rebuild, per-wall texture
clones (a GPU leak) are gone, and ice uses a short ground timer so a one-step grounded flicker no longer cancels the
slide.

**RL.** New danger layers (3-axis lasers, shocks, cutters, spikes), new rail hints, and per-hazard death rewards
(`laserHit`, `shockHit`, `cutterHit`, `spikeHit`, `waterStep`; see `backend/config.py`). Every campaign level is
verified by `backend/tests/solver.py`.

## Wiring, stacking and bigger rooms (v3)

- **Colour-coded wiring.** Select a plate or lever and pick a *Wire colour* in the inspector; give lasers, shocks, cutters,
  spikes or lifts the same colour. Green (0) = default (plates open the exit gate, levers drive default lifts). Gold, blue,
  pink, orange, purple and teal (1–6): a pressed plate / pulled lever of that colour **switches off** every laser, shock,
  cutter or spike carrying it and **powers** every lift carrying it. Coloured beacons and floor cables show the links.
  Implemented in `desktop/js/constants.js` (`CHANNELS`, `channelOf`, `lethalHazard(..., channelsOn)`), `game.js`, `physics.js`,
  `builder.js`, `editor.js` and mirrored in `backend/rl/environment.py` (`channels_on`, `lift_powered`).
- **Stack anywhere.** Coins, power-ups, crates, plates, levers and crystals can sit on walls and ledges (`surfaceHeightAt`).
- **Rooms of any size.** Every level carries its own `width` × `depth` (9–41 cells; the original six are 17 × 17). The editor's *World size* panel resizes the room, rebuilds the wall and keeps the exit gate on its wall; the camera, shadows and hall scale with the room, and the RL environment (`backend/rl/environment.py`) handles rectangular worlds. The campaign itself is the 11-level curriculum below (`backend/levels_curriculum.py`, drawn as ASCII maps with the helpers in `backend/levels_long.py`); the four long winding rooms that used to follow it are still in `levels_long.py` as extra challenge rooms but are no longer part of the campaign.
- **Exit gate.** The gate is part of the outer wall: two sliding panels between solid pillars (`DOOR_SPAN` = 3 wall cells, `DOOR_CLEAR` = 2.4 m). The editor's Door tool snaps to the nearest wall.
- **Ice.** `desktop/js/locomotion.js` holds the ground / air / ice movement model (unit-testable, no engine dependency). Ice is brisk but skids; stepping on / off it is eased.
- **Deaths.** `desktop/js/deaths.js` gives every obstacle its own ending (acid dissolves, lasers slice, shocks electrocute and char, cutters tear Deeba into parts, spikes impale and deflate, a timeout powers her down).
- **Liquids.** `desktop/js/liquid.js` is the shared water / acid / ice surface shader (waves, caustic veins, glints, bubbles, ripples).
- Natural liquids (acid / water / ice pools), lime shock emitters, slipperier ice and a fixed fullscreen exit.

## Campaign as a curriculum, and training the AI

The campaign is 11 small rooms ordered simple -> hard, each adding exactly one new idea: **1 First Steps** (just the door) ·
**2 Press the Button** · **3 Ice & Pond** · **4 Acid Hop** · **5 Spike Row** · **6 Laser Lane** · **7 Shock Gate** ·
**8 Saw & Spinner** · **9 Crate Switch** · **10 Lift Off** · **11 Grand Exit** (a longer room with turns that uses most of it).
Every room and its mirror image is checked solvable by `backend/tests/solver.py` (`CurriculumTests`).

**How the AI Lab trains on it** (`backend/rl/trainer.py`):
- *Curriculum* – training starts on level 1 and unlocks the next level once the newest one is cleared reliably; half the
  episodes go to the newest level and the rest to whatever the agent is currently worst at, so nothing is forgotten.
- *Mirrored levels* – every level is also played left-right mirrored half the time, so the policy learns "go round the wall"
  rather than "go left".
- *Mastery + early stop* – when every level is cleared >= the mastery target (default 95%) over the recent window **and** a
  greedy, no-exploration check (original + mirrored, random obstacle phases) confirms it, training stops by itself.
- Faster simulation (the danger-layer observation and per-level set-up are cached/vectorised: ~2.5x more steps per second) and
  larger PPO batches (32 x 16 envs, minibatch 128).  Typical result: all 11 levels mastered in roughly 60-160k steps (about
  20-60 s on one CPU core).

From the command line: `python -m backend.train_cli` (see `--help`; `--mastery 0.98` for a stricter target, `--no-curriculum`,
`--no-augment`, `--no-early-stop`).  A ready-trained model is in `checkpoints/the-real-exit-curriculum-ppo.json` (load it in the
AI Lab and press *Watch checkpoint in game*; it clears the whole campaign with no deaths).

