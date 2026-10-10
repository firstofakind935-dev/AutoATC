"""
Picks the reference map to track against, and says how to turn its pixels into radar-map pixels.

Two choices:
  - the radar world map shipped with the app (src/reference_map.png) - always works, all pilots share its frame;
  - your own capture from "Set Reference Map" (the game's expanded map). The minimap then matches against
    your own capture, as in the original app - but the monitor needs positions on the radar's grid, so
    your capture is first lined up with the radar world map (their coastlines are the same) and every fix
    is carried across with that offset and scale.
If your capture can't be lined up with the radar map (too little coastline, or too low a match), the shipped
world map is used instead and the log says so.
"""

import os

import cv2

from map_locator import MapLocator

MIN_REGISTRATION_CONFIDENCE = 0.5


def identity(x, y):
    return x, y


def prepare_tracking_reference(bundled_path, user_path):
    """-> (locator, to_radar_px, message). to_radar_px(x, y) maps a fix on the chosen reference to radar-map pixels."""
    bundled = MapLocator(bundled_path)
    if not user_path or not os.path.exists(user_path):
        return bundled, identity, "Using the radar world map as the reference."

    user_bgr = cv2.imread(user_path, cv2.IMREAD_COLOR)
    reg = bundled.locate_crop(user_bgr) if user_bgr is not None else None
    if reg is None or reg[3] < MIN_REGISTRATION_CONFIDENCE:
        pct = "no match" if reg is None else f"{reg[3] * 100:.0f}% match"
        return bundled, identity, (
            f"Your reference map could not be lined up with the radar map ({pct}) - "
            "using the radar world map instead. Capture it again with the whole play area showing."
        )

    x0, y0, scale, confidence = reg

    def to_radar_px(x, y):
        return x0 + scale * x, y0 + scale * y

    return MapLocator(user_path), to_radar_px, (
        f"Using your reference map (lined up with the radar map, {confidence * 100:.0f}% match)."
    )
