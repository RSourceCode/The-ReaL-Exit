# The-ReaL-Exit

The-ReaL-Exit is a desktop 3D sandbox and reinforcement learning testbed built with Electron, Three.js, Rapier rigid-body physics, and a Python RL backend.

The renderer runs locally in the desktop window in JavaScript, while all headless RL simulation, algorithms (PPO, DQN, Random), training orchestration, and checkpoint serialization are implemented completely in Python.

## Architecture

- **`backend/`**: Pure Python backend and RL package (requires Python 3.10+; uses only standard library).
  - **`backend/config.py`**: Observation dimensions, discrete actions, and default reward structure.
  - **`backend/app.py`**: Application state and API endpoint dispatch handlers.
  - **`backend/server.py`**: Lightweight HTTP/REST server providing JSON endpoints on `http://127.0.0.1:5050`.
  - **`backend/ipc.py`**: Standard I/O (stdin/stdout) JSON-RPC handler for direct IPC.
  - **`backend/rl/environment.py`**: Headless grid simulator (`WorldEnvironment`) executing moves, line-of-sight checks, and hazard physics.
  - **`backend/rl/trainer.py`**: Batch runner (`RLTrainer`) managing chunked simulation, evaluation, and checkpoint serialization.
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
    - `editor.js`: Level editor tools, cursor placement, and object inspector.
    - `game.js`: Campaign progression, pressure plates, timers, and win conditions.
    - `rl_client.js`: HTTP API client connecting the UI to the Python RL backend.
    - `rl_ui.js`: AI Lab training dashboard, live canvas reward charts, and parameter controls.
    - `rl_playback.js`: In-game 3D checkpoint playback controller.
    - `ui.js`: Navigation tabs, fullscreen focus mode, and notifications.

## Run in development

1. Install [Node.js](https://nodejs.org/) and Python 3.10+.
2. From this folder, install desktop dependencies:
   ```bash
   npm install
   ```
3. Run the desktop application:
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
