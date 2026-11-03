"""Standard I/O IPC server for direct child-process communication with Electron."""

import json
import sys
from pathlib import Path
from typing import Any, Dict

# Ensure project root is always in sys.path
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app import app


def handle_message(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Dispatch an IPC message dictionary to the appropriate app handler."""
    action = msg.get("action", "")
    data = msg.get("data", {})
    req_id = msg.get("id")

    try:
        if action == "health":
            result = app.handle_health()
        elif action == "algorithms":
            result = app.handle_algorithms()
        elif action == "rewards":
            result = app.handle_rewards()
        elif action == "train_init":
            result = app.handle_train_init(data)
        elif action == "train_start":
            result = app.handle_train_start(data)
        elif action == "train_status":
            result = app.handle_train_status()
        elif action == "train_control":
            result = app.handle_train_control(str(data.get("action", "")))
        elif action == "train_chunk":
            result = app.handle_train_chunk(data)
        elif action == "train_evaluate":
            result = app.handle_train_evaluate(data)
        elif action == "checkpoint_save":
            result = app.handle_checkpoint_save()
        elif action == "checkpoint_load":
            result = app.handle_checkpoint_load(data)
        elif action == "playback_start":
            result = app.handle_playback_start(data)
        elif action == "playback_step":
            result = app.handle_playback_step(data)
        else:
            return {"id": req_id, "error": f"Unknown action: {action}"}

        return {"id": req_id, "result": result}
    except Exception as err:
        return {"id": req_id, "error": str(err)}


def run_ipc():
    """Continuously read newline-delimited JSON commands from stdin and write JSON to stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            resp = handle_message(req)
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        except Exception as err:
            sys.stdout.write(json.dumps({"error": f"Malformed request: {str(err)}"}) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    run_ipc()
