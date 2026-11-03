"""Lightweight HTTP server providing JSON REST endpoints for the The-ReaL-Exit frontend."""

import argparse
import http.server
import json
import sys
from pathlib import Path
from typing import Tuple
from urllib.parse import urlparse

# Ensure project root is always in sys.path regardless of how the script is invoked
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from backend.app import app
from backend.config import DEFAULT_PORT


class APIHandler(http.server.BaseHTTPRequestHandler):
    """Handles HTTP requests with JSON responses and permissive local CORS + Private Network Access."""

    def _send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def _read_json_body(self) -> dict:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 0:
            raw = self.rfile.read(content_length).decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
        return {}

    def _send_json(self, status_code: int, data: dict) -> None:
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        try:
            if path in ("/api/health", "/health", ""):
                self._send_json(200, app.handle_health())
            elif path in ("/api/algorithms", "/algorithms"):
                self._send_json(200, app.handle_algorithms())
            elif path in ("/api/rewards", "/rewards"):
                self._send_json(200, app.handle_rewards())
            elif path == "/api/train/status":
                self._send_json(200, app.handle_train_status())
            else:
                self._send_json(404, {"error": f"Endpoint not found: {path}"})
        except Exception as err:
            self._send_json(500, {"error": str(err)})

    def do_POST(self) -> None:
        path = urlparse(self.path).path.rstrip("/")
        try:
            body = self._read_json_body()
            if path == "/api/train/init":
                self._send_json(200, app.handle_train_init(body))
            elif path == "/api/train/start":
                self._send_json(200, app.handle_train_start(body))
            elif path == "/api/train/control":
                self._send_json(200, app.handle_train_control(str(body.get("action", ""))))
            elif path == "/api/train/chunk":
                self._send_json(200, app.handle_train_chunk(body))
            elif path == "/api/train/evaluate":
                self._send_json(200, app.handle_train_evaluate(body))
            elif path == "/api/checkpoint/save":
                self._send_json(200, app.handle_checkpoint_save())
            elif path == "/api/checkpoint/load":
                self._send_json(200, app.handle_checkpoint_load(body))
            elif path == "/api/playback/start":
                self._send_json(200, app.handle_playback_start(body))
            elif path == "/api/playback/step":
                self._send_json(200, app.handle_playback_step(body))
            else:
                self._send_json(404, {"error": f"Endpoint not found: {path}"})
        except Exception as err:
            self._send_json(500, {"error": str(err)})

    def log_message(self, format: str, *args) -> None:
        # Suppress verbose terminal logging of successful requests
        pass


def run_server(host: str = "127.0.0.1", port: int = DEFAULT_PORT) -> None:
    """Start the HTTP server on the specified host and port."""
    address: Tuple[str, int] = (host, port)
    server = http.server.ThreadingHTTPServer(address, APIHandler)
    print(f"The-ReaL-Exit Python Backend running on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down The-ReaL-Exit Python Backend...", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="The-ReaL-Exit Python RL Backend Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind to")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to listen on")
    args = parser.parse_args()
    run_server(args.host, args.port)
