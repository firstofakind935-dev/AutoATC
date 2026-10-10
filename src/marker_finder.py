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


def find_marker_pixel(frame_bgr):
    """
    frame_bgr: the captured minimap image (BGR, as returned by mss/cv2).
    Returns (px, py) of the marker's centroid, or None if not found.
    """
    r, g, b = config.MARKER_COLOR_RGB
    tol = config.MARKER_COLOR_TOLERANCE

    # Build a color mask in BGR order to match frame_bgr's channel order
    lower = np.array([max(0, b - tol), max(0, g - tol), max(0, r - tol)])
    upper = np.array([min(255, b + tol), min(255, g + tol), min(255, r + tol)])
    mask = cv2.inRange(frame_bgr, lower, upper)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < config.MARKER_MIN_PIXEL_AREA:
        return None

    M = cv2.moments(largest)
    if M["m00"] == 0:
        return None

    px = M["m10"] / M["m00"]
    py = M["m01"] / M["m00"]
    return (px, py)
