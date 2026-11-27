"""Backend extension points: plugins add their own routes under ``/api/ext/<plugin>/<route>``.

Drop a module into ``backend/plugins/`` that defines ``register(registry)``::

    def register(registry):
        registry.route("levelgen", "generate", handler)          # POST /api/ext/levelgen/generate
        def handler(body): return {"level": {...}}
"""

import importlib
import pkgutil
import sys
import traceback
from typing import Any, Callable, Dict

Handler = Callable[[Dict[str, Any]], Dict[str, Any]]


class ExtensionRegistry:
    def __init__(self) -> None:
        self.routes: Dict[str, Dict[str, Handler]] = {}

    def route(self, plugin: str, name: str, handler: Handler) -> None:
        self.routes.setdefault(plugin, {})[name] = handler

    def call(self, plugin: str, name: str, body: Dict[str, Any]) -> Dict[str, Any]:
        handler = self.routes.get(plugin, {}).get(name)
        if handler is None:
            raise KeyError(f"No extension route {plugin}/{name}")
        return handler(body)

    def describe(self) -> Dict[str, Any]:
        return {plugin: sorted(routes) for plugin, routes in self.routes.items()}

    def load_plugins(self) -> None:
        """Import every module in backend/plugins and call its register(registry)."""
        import backend.plugins as pkg
        for info in pkgutil.iter_modules(pkg.__path__):
            try:
                module = importlib.import_module(f"backend.plugins.{info.name}")
                if hasattr(module, "register"):
                    module.register(self)
            except Exception as err:  # a broken plugin must never take the game backend down
                print(f"[plugins] {info.name} failed to load: {err}", file=sys.stderr, flush=True)
                traceback.print_exc(file=sys.stderr)


registry = ExtensionRegistry()
