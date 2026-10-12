"""
Finds your player marker's pixel position within a captured minimap frame.

Default approach: color-based blob detection — looks for pixels close to
MARKER_COLOR_RGB and returns the centroid of the largest matching blob.
This works well if your marker is a distinct, mostly-solid color that
nothing else on the minimap shares.

If that's not reliable (marker blends with map colors, or varies), switch
to template matching instead: crop a clean image of just the marker icon,
save it as a .png, and use cv2.matchTemplate — ask me to swap this in if
color matching isn't working well for you.
"""

import cv2
import numpy as np

import app_config as config


def _best_blob(frame_bgr, mask):
    """
    The marker among the blobs in `mask`: small and compact (the marker is a little arrow, land is big and sprawling)
    and the most "marker-coloured" of those: a light yellow-green has high red AND green with low blue, unlike grass
    (low red) and fields or roads (more blue). Returns its centroid, or None.
    """
    f = frame_bgr.astype(np.int16)
    v = np.minimum(f[:, :, 2], f[:, :, 1]) - f[:, :, 0]  # min(R, G) - B
    count, labels, stats, cents = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    max_area = frame_bgr.shape[0] * frame_bgr.shape[1] * 0.02
    min_area = max(3, getattr(config, "MARKER_MIN_PIXEL_AREA", 4) - 1)
    best, best_v = None, 0.0
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if area < min_area or area > max_area or max(w, h) > 3 * max(1, min(w, h)):
            continue
        mean_v = float(v[labels == i].mean())
        if mean_v > best_v:
            best, best_v = (float(cents[i][0]), float(cents[i][1])), mean_v
    return best


def _exact_colour(frame_bgr):
    """Mask: pixels near MARKER_COLOR_RGB (per-channel tolerance)."""
    r, g, b = config.MARKER_COLOR_RGB
    tol = config.MARKER_COLOR_TOLERANCE
    lower = np.array([max(0, b - tol), max(0, g - tol), max(0, r - tol)])
    upper = np.array([min(255, b + tol), min(255, g + tol), min(255, r + tol)])
    return cv2.inRange(frame_bgr, lower, upper) > 0


def _bright_green_blob(frame_bgr):
    """Mask, for when the exact colour misses when the exact colour misses (screens, colour profiles and JPEG all shift it): bright, saturated
    yellow-green."""
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    return (h >= 30) & (h <= 55) & (s >= 100) & (v >= 150)


def find_marker_pixel(frame_bgr):
    """
    frame_bgr: the captured minimap image (BGR, as returned by mss/cv2).
    Returns (px, py) of the marker's centroid, or None if not found.
    """
    # candidates from both the configured colour and the looser hue/brightness test; the scoring picks the marker
    return _best_blob(frame_bgr, _exact_colour(frame_bgr) | _bright_green_blob(frame_bgr))
