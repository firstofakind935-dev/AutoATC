"""
Replaces the old manual-coordinate calibration entirely.

Idea: the small corner minimap is just a zoomed-in, fixed-orientation crop
of the same static game map. If we have ONE full screenshot of that map
(captured once via the game's expandable map view), we can, every tick,
search for where the live minimap crop best matches inside that full image
using OpenCV template matching. Wherever it matches best IS your position
on the map — no typed-in coordinates, no drift, self-correcting every tick.

Because the live minimap's zoom level might not exactly match the
resolution the reference map was captured at, we try a range of scale
factors on the crop and keep whichever gives the strongest match.
"""

import numpy as np
import cv2


def land_mask(bgr):
    """1.0 where the game map shows land, 0.0 where it shows sea.

    The sea is one flat blue; labels (yellow) and the white dashed track lines are ignored. Matching these
    masks instead of the raw pixels is what lets a crisp, zoomed-in minimap line up with the blurry
    low-resolution radar world map: they only have the coastline in common, and that is all the mask keeps.
    """
    b = bgr[..., 0].astype(np.int16)
    g = bgr[..., 1].astype(np.int16)
    r = bgr[..., 2].astype(np.int16)
    water = (np.abs(r - 59) < 18) & (np.abs(g - 90) < 18) & (np.abs(b - 125) < 22)
    white = (r > 185) & (g > 185) & (b > 185) & ((np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b)) < 40)
    label = (r > 170) & (g > 130) & (b < 110) & ((r - b) > 80)
    return (~(water | white | label)).astype(np.float32)


class MapLocator:
    COARSE = 4  # the first search runs on masks shrunk by this much

    def __init__(self, reference_map_path: str,
                 scale_min: float = 0.08, scale_max: float = 2.5, scale_steps: int = 40):
        reference_bgr = cv2.imread(reference_map_path, cv2.IMREAD_COLOR)
        if reference_bgr is None:
            raise FileNotFoundError(f"Could not load reference map: {reference_map_path}")
        self.reference_gray = cv2.cvtColor(reference_bgr, cv2.COLOR_BGR2GRAY)  # kept for callers that want it
        self.reference_size = (reference_bgr.shape[1], reference_bgr.shape[0])  # (w, h)
        self.reference_mask = land_mask(reference_bgr)
        ref_w, ref_h = self.reference_size
        self.coarse_mask = cv2.resize(
            self.reference_mask, (ref_w // self.COARSE, ref_h // self.COARSE), interpolation=cv2.INTER_AREA)
        # The reference is the radar world map (the whole play area, low resolution), so the live minimap is
        # usually zoomed in several times over it: search small scales too, spaced geometrically.
        self._scales = np.geomspace(scale_min, scale_max, scale_steps)

    @staticmethod
    def _match(image, template):
        if template.shape[0] >= image.shape[0] or template.shape[1] >= image.shape[1]:
            return None
        if template.std() < 1e-3:
            return None  # all sea or all land says nothing about where you are
        result = cv2.matchTemplate(image, template, cv2.TM_CCOEFF_NORMED)
        result = np.nan_to_num(result, nan=-1.0, posinf=-1.0, neginf=-1.0)
        # OpenCV's normalised score turns into noise (often a perfect 1.0) over windows that are all sea or all
        # land, where there is nothing to correlate. Throw those positions out.
        th, tw = template.shape[:2]
        n = tw * th
        s1 = cv2.integral(image)
        s2 = cv2.integral(image * image)

        def window(sat):
            return sat[th:, tw:][: result.shape[0], : result.shape[1]] - sat[:-th, tw:][: result.shape[0], : result.shape[1]] \
                - sat[th:, :-tw][: result.shape[0], : result.shape[1]] + sat[:-th, :-tw][: result.shape[0], : result.shape[1]]

        variance = window(s2) - window(s1) ** 2 / n
        result[variance < 0.01 * n] = -1.0
        _, max_val, _, max_loc = cv2.minMaxLoc(result)
        return max_loc[0], max_loc[1], float(max_val)

    def locate_crop(self, crop_bgr):
        """
        Returns (top_left_x, top_left_y, scale, confidence): where the crop sits on the reference map, in
        reference pixels, and how many reference pixels one crop pixel covers. None if nothing fits.
        """
        crop_mask = land_mask(crop_bgr)
        ch, cw = crop_mask.shape[:2]
        f = self.COARSE

        # Coarse: every scale, on shrunken masks.
        coarse = []
        for scale in self._scales:
            tw, th = int(round(cw * scale / f)), int(round(ch * scale / f))
            if tw < 8 or th < 8:
                continue
            tpl = cv2.resize(crop_mask, (tw, th), interpolation=cv2.INTER_AREA)
            m = self._match(self.coarse_mask, tpl)
            if m is not None:
                coarse.append((m[2], scale, m[0] * f, m[1] * f))
        if not coarse:
            return None
        coarse.sort(reverse=True)

        # Fine: around the best few, at full resolution, with narrow scale and position steps.
        ref_w, ref_h = self.reference_size
        best = None
        for _, scale, x, y in coarse[:3]:
            for k in np.linspace(0.94, 1.06, 9):
                sc = scale * k
                tw, th = int(round(cw * sc)), int(round(ch * sc))
                if tw < 8 or th < 8:
                    continue
                pad = 2 * f
                x0, y0 = max(0, int(x) - pad), max(0, int(y) - pad)
                x1, y1 = min(ref_w, int(x) + tw + pad), min(ref_h, int(y) + th + pad)
                roi = self.reference_mask[y0:y1, x0:x1]
                tpl = cv2.resize(crop_mask, (tw, th), interpolation=cv2.INTER_AREA)
                m = self._match(roi, tpl)
                if m is not None and (best is None or m[2] > best[3]):
                    best = (x0 + m[0], y0 + m[1], tw / cw, m[2])
        return best  # (top_left_x, top_left_y, scale, confidence) or None

    def locate_marker(self, crop_bgr, marker_pixel_xy):
        """
        Combines locate_crop() with a marker's pixel position WITHIN the
        crop (from marker_finder.find_marker_pixel) to compute the marker's
        absolute position on the reference map image.

        Returns (abs_x, abs_y, confidence) or None.
        """
        match = self.locate_crop(crop_bgr)
        if match is None:
            return None

        top_left_x, top_left_y, scale, confidence = match
        marker_px, marker_py = marker_pixel_xy

        abs_x = top_left_x + marker_px * scale
        abs_y = top_left_y + marker_py * scale
        return (abs_x, abs_y, confidence)
