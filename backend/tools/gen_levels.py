"""Regenerate the Skyway campaign specs inside ``desktop/js/constants.js`` from ``backend/levels.py``.

Usage (from the project root)::

    python -m backend.tools.gen_levels
"""

import json
import pathlib

from backend.levels import CAMPAIGN_SPECS

START = "// <generated:levels>"
END = "// </generated:levels>"


def _compact(value, indent=2, level=0):
    pad = " " * (indent * level)
    if isinstance(value, dict):
        if not value:
            return "{}"
        inner = ",\n".join(f"{pad}{' ' * indent}{json.dumps(k)}: {_compact(v, indent, level + 1)}" for k, v in value.items())
        return "{\n" + inner + "\n" + pad + "}"
    return json.dumps(value, separators=(", ", ": "))


def render() -> str:
    body = ",\n".join("  " + _compact(spec, 2, 1) for spec in CAMPAIGN_SPECS)
    return f"{START}\nexport const CAMPAIGN_SPECS = [\n{body},\n];\n{END}"


def main() -> None:
    target = pathlib.Path(__file__).resolve().parents[2] / "desktop" / "js" / "constants.js"
    text = target.read_text(encoding="utf-8")
    head, rest = text.split(START, 1)
    _old, tail = rest.split(END, 1)
    target.write_text(head + render() + tail, encoding="utf-8")
    print(f"wrote {len(CAMPAIGN_SPECS)} levels to {target}")


if __name__ == "__main__":
    main()
