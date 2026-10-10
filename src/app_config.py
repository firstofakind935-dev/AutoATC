"""Load per-user settings for packaged builds and local config for development."""

import json
import os
import runpy
import sys
from pathlib import Path
from types import SimpleNamespace

DEFAULT_SETTINGS = {
    "MINIMAP_REGION": {
        "left": 20,
        "top": 20,
        "width": 300,
        "height": 300,
    },
    "MARKER_COLOR_RGB": [161, 233, 93],  # the bright green aircraft marker (the map's own greens are much darker)
    "MARKER_COLOR_TOLERANCE": 45,
    "MARKER_MIN_PIXEL_AREA": 4,
    "POLL_INTERVAL_SECONDS": 1.0,
    "DISCORD_WEBHOOK_URL": "",
    "DISCORD_POST_MIN_INTERVAL_SECONDS": 5,
    "BROADCAST_HOST": "localhost",
    "BROADCAST_PORT": 8765,
    "CALLSIGN": "YOURCALLSIGN",
    "MIN_MATCH_CONFIDENCE": 0.35,
    # ATC365 tracking system (the AutoATC monitor): where position reports go.
    "MONITOR_URL": "https://cpdlc.up.railway.app",
    "MONITOR_API_KEY": "",
    "MONITOR_POST_MIN_INTERVAL_SECONDS": 2,
}

if getattr(sys, "frozen", False):
    config_home = os.environ.get("PTFS_TRACKER_HOME")
    if config_home:
        CONFIG_DIR = Path(config_home).expanduser()
    else:
        CONFIG_DIR = Path(os.environ.get("APPDATA", Path.home())) / "PTFS Tracker"
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH = CONFIG_DIR / "settings.json"
    # The reference map is the ATC365 radar world map bundled with the app, so every pilot reports in the same frame.
    REFERENCE_MAP_PATH = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)) / "reference_map.png"

    if not SETTINGS_PATH.exists():
        SETTINGS_PATH.write_text(
            json.dumps(DEFAULT_SETTINGS, indent=2) + "\n",
            encoding="utf-8",
        )

    try:
        user_settings = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"Could not read settings at {SETTINGS_PATH}: {exc}"
        ) from exc

    if not isinstance(user_settings, dict):
        raise RuntimeError(f"Settings must be a JSON object: {SETTINGS_PATH}")

    settings = {**DEFAULT_SETTINGS, **user_settings}
else:
    CONFIG_DIR = Path(__file__).resolve().parent
    SETTINGS_PATH = CONFIG_DIR / "config.py"
    REFERENCE_MAP_PATH = CONFIG_DIR / "reference_map.png"
    settings = runpy.run_path(str(SETTINGS_PATH))


_config = SimpleNamespace(**settings)
for _name, _default in DEFAULT_SETTINGS.items():
    globals()[_name] = getattr(_config, _name, _default)
