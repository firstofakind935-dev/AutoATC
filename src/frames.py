"""
Two maps are in play. A minimap fix is matched on the world-map PICTURE, so it comes out in the picture's frame. The
radar's airport points, the ground charts and the stand positions use the game's (24SPY) frame. They differ by a few
hundred metres to over a nautical mile near an airport. This carries a picture-frame point across, using a per-airport
offset (src/picture_offsets.json), faded out over FADE_NM. A pilot's own calibration overrides the shipped number.
(Port of companion/lib/frames.js.)
"""

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
FADE_NM = 6.0
# A shipped offset bigger than this is more likely a bad hand-measured anchor than a real gap.
MAX_SHIPPED_OFFSET_NM = 0.8


def _load(name):
    return json.loads((HERE / name).read_text(encoding="utf-8")).get("airports", {})


_cache = {}


def _data():
    if not _cache:
        _cache["offsets"] = _load("picture_offsets.json")
        _cache["points"] = _load("world_anchors.json")
        _cache["stand_nudges"] = _load("stand_offsets.json")
    return _cache


def picture_to_game(x_nm, y_nm, user_offsets=None, user_stand_nudges=None):
    """-> (x_nm, y_nm, dx, dy, icao): the shifted point, the shift, and the airport that mostly set it."""
    data = _data()
    user_offsets = user_offsets or {}
    user_stand_nudges = user_stand_nudges or {}

    def nudge(icao):
        return user_stand_nudges.get(icao) or data["stand_nudges"].get(icao) or {"dxNm": 0.0, "dyNm": 0.0}

    candidates = {}
    for icao, o in data["offsets"].items():
        if math.hypot(o["dxNm"], o["dyNm"]) <= MAX_SHIPPED_OFFSET_NM:
            n = nudge(icao)
            candidates[icao] = {"dxNm": o["dxNm"] + n["dxNm"], "dyNm": o["dyNm"] + n["dyNm"]}
    candidates.update(user_offsets)

    total = sx = sy = best_w = 0.0
    best_icao = None
    for icao, o in candidates.items():
        p = data["points"].get(icao)
        if not p:
            continue
        d = math.hypot(x_nm - (p["xNm"] - o["dxNm"]), y_nm - (p["yNm"] - o["dyNm"]))
        w = max(0.0, 1.0 - d / FADE_NM)
        if w == 0:
            continue
        total += w
        sx += w * o["dxNm"]
        sy += w * o["dyNm"]
        if w > best_w:
            best_w, best_icao = w, icao
    norm = max(total, 1.0)
    dx, dy = sx / norm, sy / norm
    return x_nm + dx, y_nm + dy, dx, dy, best_icao
