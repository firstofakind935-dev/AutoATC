"""
Position from a stand number (port of companion/lib/stands.js). Parked at a stand, the pilot picks the airport and
types the stand number; we put them where that stand is on the radar's ground chart (src/stands.json, read off the
charts), plus the airport's nudge where the chart sits a little off the real map.
"""

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
NM_PER_STUD = 0.00030488559747884637
ORIGIN_X_NM = 22.061527459937743
ORIGIN_Y_NM = 15.039210123446306

_cache = {}


def _stands():
    if "stands" not in _cache:
        _cache["stands"] = json.loads((HERE / "stands.json").read_text(encoding="utf-8")).get("airports", {})
        _cache["nudges"] = json.loads((HERE / "stand_offsets.json").read_text(encoding="utf-8")).get("airports", {})
    return _cache["stands"]


def list_stands():
    """{ICAO: ['1', '2', ...]}"""
    return {icao: sorted(s, key=int) for icao, s in _stands().items()}


def shipped_nudge(icao):
    _stands()
    return _cache["nudges"].get(icao.upper(), {"dxNm": 0.0, "dyNm": 0.0})


def stand_fix(icao, stand, user_nudges=None):
    """-> dict with xNm, yNm (radar grid) or {'error': ...}."""
    stands = _stands().get((icao or "").upper())
    if stands is None:
        return {"error": f"no stand data for {icao or 'that airport'} yet"}
    key = str(stand or "").strip().lstrip("0") or "0"
    s = stands.get(key)
    if s is None:
        sample = ", ".join(list(stands)[:4])
        return {"error": f"{icao} has no stand {stand or '?'} (try {sample}...)"}
    line = s.get("line")
    # The aircraft sits along the stand's line - its middle is the best single point.
    if line:
        ux, uy = (line["a"][0] + line["b"][0]) / 2, (line["a"][1] + line["b"][1]) / 2
    else:
        ux, uy = s["x"], s["y"]
    x_nm = ux * 100 * NM_PER_STUD + ORIGIN_X_NM
    y_nm = uy * 100 * NM_PER_STUD + ORIGIN_Y_NM
    nudge = (user_nudges or {}).get(icao.upper()) or shipped_nudge(icao)
    return {"xNm": x_nm + nudge["dxNm"], "yNm": y_nm + nudge["dyNm"], "stand": key, "nudge": nudge}
