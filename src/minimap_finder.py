"""
Finds PTFS's minimap on the screen, so nobody has to draw a box around it.

The minimap panel always has the same four dark slate buttons in its corners (expand top-left, X top-right, "/"
bottom-left, "+" / "-" bottom-right), each a small square with a white glyph. Those squares are found by colour,
and the panel is the rectangle they frame. It works at any resolution or UI scale, wherever the panel sits.
"""

import cv2
import numpy as np

BUTTON_BGR = (57, 51, 44)   # the corner buttons' fill
BUTTON_TOLERANCE = 40       # summed |B|+|G|+|R| distance
SEA_BGR = (125, 90, 59)     # the minimap's sea


def _buttons(screen_bgr):
    """Dark slate squares with a bright glyph inside: [(x, y, w, h), ...]."""
    h_screen = screen_bgr.shape[0]
    diff = np.abs(screen_bgr.astype(np.int16) - np.array(BUTTON_BGR, np.int16)).sum(axis=2)
    mask = (diff < BUTTON_TOLERANCE).astype(np.uint8)
    # fill the glyph strokes so each button is one solid blob
    k = 3 if h_screen < 900 else 5
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    lo, hi = h_screen * 0.012, h_screen * 0.08
    bright = screen_bgr.min(axis=2) > 130
    found = []
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if not (lo <= w <= hi and lo <= h <= hi) or max(w, h) > 1.6 * min(w, h):
            continue
        if area < 0.5 * w * h:
            continue
        if bright[y:y + h, x:x + w].sum() < 0.03 * w * h:  # needs a white glyph
            continue
        found.append((int(x), int(y), int(w), int(h)))
    return found


def _looks_like_map(panel_bgr):
    """Most of a minimap is sea blue or land green; a dark UI panel with similar buttons is neither."""
    px = panel_bgr.reshape(-1, 3).astype(np.int16)
    sea = (np.abs(px - np.array(SEA_BGR, np.int16)).sum(axis=1) < 45).mean()
    b, g, r = px[:, 0], px[:, 1], px[:, 2]
    green = ((g > r + 15) & (g > b + 15)).mean()
    return sea + green > 0.35


def find_minimap(screen_bgr):
    """
    screen_bgr: a full screenshot (BGR). Returns {"left", "top", "width", "height"} in that screenshot's pixels for
    the minimap panel, or None when it isn't on screen.
    """
    buttons = _buttons(screen_bgr)
    slate = (np.abs(screen_bgr.astype(np.int16) - np.array(BUTTON_BGR, np.int16)).sum(axis=2) < BUTTON_TOLERANCE).astype(np.float32)
    rows = slate.shape[0]

    def density(x0, y0, x1, y1):
        x0, y0 = max(int(x0), 0), max(int(y0), 0)
        block = slate[y0:int(y1), x0:int(x1)]
        return float(block.mean()) if block.size else 0.0

    best = None
    for tl in buttons:
        s = (tl[2] + tl[3]) / 2
        for tr in buttons:
            # top-right: same row, similar size, at least ~4 buttons further right
            if tr is tl or abs(tr[1] - tl[1]) > s * 0.4 or tr[0] - tl[0] < 4 * s or abs(tr[3] - tl[3]) > s * 0.5:
                continue
            x0, y0, x1 = tl[0], min(tl[1], tr[1]), tr[0] + tr[2]
            width = x1 - x0
            # The bottom edge: both bottom corners hold buttons ("/" left, "+"/"-" right) and the panel ends there.
            # (Thin glyphs make those buttons hard to pick out as squares on small screens, so look at the corners.)
            for height in range(int(width * 1.4), int(width * 0.7), -1):
                y1 = y0 + height
                if y1 > rows:
                    continue
                left = density(x0, y1 - s * 0.8, x0 + s * 0.8, y1)
                right = density(x1 - s * 0.8, y1 - s * 0.8, x1, y1)
                if left < 0.4 or right < 0.4:
                    continue
                below = max(density(x0, y1 + 2, x0 + s, y1 + 2 + s * 0.5), density(x1 - s, y1 + 2, x1, y1 + 2 + s * 0.5))
                if y1 + 2 < rows and below > 0.3:
                    continue
                inner = screen_bgr[int(y0 + s):int(y1 - s), int(x0 + s):int(x1 - s)]
                if inner.size and _looks_like_map(inner) and (best is None or width * height > best[2] * best[3]):
                    best = (x0, y0, width, height)
                break
    if best is None:
        return None
    x, y, w, h = best
    return {"left": int(x), "top": int(y), "width": int(w), "height": int(h)}


# The placeholder box the example config used to ship: treat it like "auto" (nobody's minimap is really there).
_OLD_PLACEHOLDER = {"left": 20, "top": 20, "width": 300, "height": 300}


def wants_auto(configured):
    return configured in (None, "", "auto", "AUTO") or configured == _OLD_PLACEHOLDER


def locate_on_screen(sct):
    """Searches every monitor (mss instance) for the minimap. Returns an mss region dict, or None."""
    for mon in sct.monitors[1:] or sct.monitors[:1]:
        shot = np.array(sct.grab(mon))[:, :, :3]
        found = find_minimap(np.ascontiguousarray(shot))
        if found:
            return {"left": mon["left"] + found["left"], "top": mon["top"] + found["top"],
                    "width": found["width"], "height": found["height"]}
    return None


def resolve_region(sct, configured):
    """The configured MINIMAP_REGION, or - when it is "auto" - wherever the minimap is on screen right now (or None)."""
    return locate_on_screen(sct) if wants_auto(configured) else configured
