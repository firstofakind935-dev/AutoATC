"""The pilot's own stand nudges and airport calibrations, kept in user_state.json next to the settings."""

import json

import app_config

# Bumped whenever the coordinate frame changes. Corrections saved under an older frame were measured against
# positions that have since moved, so they would now push every fix off by the old error - they are dropped.
# 2: the exact game frame (island-shape fit), replacing the airport-point fit.
FRAME_VERSION = 2


def load():
    try:
        data = json.loads(app_config.USER_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if data.get("frame") != FRAME_VERSION:
        return {"standOffsets": {}, "airportOffsets": {}, "frame": FRAME_VERSION,
                "dropped": bool(data.get("standOffsets") or data.get("airportOffsets"))}
    return {"standOffsets": data.get("standOffsets", {}), "airportOffsets": data.get("airportOffsets", {}), "frame": FRAME_VERSION}


def save(state):
    state = {k: v for k, v in state.items() if k != "dropped"}
    state["frame"] = FRAME_VERSION
    app_config.USER_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    app_config.USER_STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
