"""The pilot's own stand nudges and airport calibrations, kept in user_state.json next to the settings."""

import json

import app_config


def load():
    try:
        data = json.loads(app_config.USER_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return {"standOffsets": data.get("standOffsets", {}), "airportOffsets": data.get("airportOffsets", {})}


def save(state):
    app_config.USER_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    app_config.USER_STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
