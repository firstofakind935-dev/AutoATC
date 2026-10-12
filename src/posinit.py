"""
POS INIT: the pilot says where they are (airport + stand); the tracker then works out how the minimap's picture lines
up with the radar AT THAT AIRPORT, from that one known spot.

At the stand we know the true position (the stand on the ground chart). The first good minimap match tells us where
the same spot is on the map picture. The difference is this airport's picture-to-radar offset for this pilot's game,
so every later fix near the airport lands exactly - no nudging. A difference that is too big means the stand number
or the match is wrong, so nothing is learnt and the stand position is kept.
"""

import math

MAX_CALIBRATION_NM = 0.6  # the picture and the radar never differ more than this near an airport we have tiles for
MIN_SCORE = 0.8
WINDOW_SECONDS = 60.0  # how long after POS INIT a match may still be used to calibrate


def calibrate(stand_xy, raw_picture_nm, score):
    """-> (ok, offset {dxNm, dyNm} or None, message)."""
    if score < MIN_SCORE:
        return False, None, f"minimap match too weak to calibrate ({score * 100:.0f}%) - keeping the stand position"
    dx = stand_xy[0] - raw_picture_nm[0]
    dy = stand_xy[1] - raw_picture_nm[1]
    gap = math.hypot(dx, dy)
    if gap > MAX_CALIBRATION_NM:
        return False, None, (f"the minimap puts you {gap:.2f} nm from that stand - check the stand number "
                             "(keeping the stand position, nothing learnt)")
    return True, {"dxNm": round(dx, 4), "dyNm": round(dy, 4)}, (
        f"calibrated: the map picture is {gap * 1852:.0f} m off the radar here - corrected for every fix at this airport")
