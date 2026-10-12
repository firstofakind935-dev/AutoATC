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

ATC365 build: the match is done on FEATURES first (ORB keypoints - corners of runways, roads, buildings - matched
between the minimap and the reference, then a RANSAC fit of one scale + shift + rotation that most of them agree on).
That works on an airport apron, which has no coastline at all, and a wrong place almost never gets many keypoints to
agree, so the inlier count is an honest confidence. The older land/sea mask match is only a fallback, and its
confidence is capped below what the position filter needs to move you, so it can confirm a position but never jump.
"""

import numpy as np
import cv2

import tiles as tilemod


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
                 scale_min: float = 0.08, scale_max: float = 2.5, scale_steps: int = 40, use_tiles: bool = True):
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
        self.last_reason = None
        self.last_transform = None  # 2x3: crop pixel -> reference pixel, from the last successful match
        self.last_method = None

        # Features of the reference, computed once.
        self._orb_ref = cv2.ORB_create(nfeatures=12000, scaleFactor=1.2, nlevels=8)
        self._ref_kp, self._ref_desc = self._orb_ref.detectAndCompute(self.reference_gray, None)
        self._orb_crop = cv2.ORB_create(nfeatures=2000, scaleFactor=1.2, nlevels=8)
        self._matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
        self._scale_hint = None  # crop->reference scale that worked last time
        # High-detail airport tiles (src/tiles/), only meaningful when the reference IS the shipped world map.
        self.tiles = tilemod.load_tiles() if use_tiles else []
        self._tile_scale_hint = {}
        self.last_world_px = None  # last matched point, to try the nearest tile first

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

    # ---- feature match --------------------------------------------------------------------------------

    MIN_INLIERS = 10
    MIN_INLIER_RATIO = 0.4
    MAX_ROTATION_DEG = 8.0  # the minimap is north-up; a fit that needs a big rotation is a wrong match

    def _feature_try(self, crop_gray, scale, ref_kp=None, ref_desc=None):
        ref_kp = self._ref_kp if ref_kp is None else ref_kp
        ref_desc = self._ref_desc if ref_desc is None else ref_desc
        img = crop_gray if abs(scale - 1.0) < 1e-6 else cv2.resize(
            crop_gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        if img.shape[0] < 24 or img.shape[1] < 24:
            return None
        kp, desc = self._orb_crop.detectAndCompute(img, None)
        if desc is None or len(kp) < self.MIN_INLIERS or ref_desc is None:
            return None
        pairs = self._matcher.knnMatch(desc, ref_desc, k=2)
        good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < 0.75 * n.distance]
        if len(good) < self.MIN_INLIERS:
            return None
        src = np.float32([kp[m.queryIdx].pt for m in good])
        dst = np.float32([ref_kp[m.trainIdx].pt for m in good])
        M, inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
        if M is None or inliers is None:
            return None
        n_in = int(inliers.sum())
        # back to crop pixels: the crop was resized by `scale` before matching
        M = M.copy()
        M[:, :2] *= scale
        return M, n_in, len(good)

    def _feature_locate(self, crop_bgr, ref_kp=None, ref_desc=None, hint_key=None, scales=(1.0, 0.5, 0.29, 0.17, 0.1)):
        crop_gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
        # ORB's own pyramid covers about 4x of zoom, so a handful of scales is enough to cover any minimap zoom;
        # the scale that worked last time goes first.
        scales = list(scales)
        hint = self._tile_scale_hint.get(hint_key) if hint_key else self._scale_hint
        if hint:
            scales = [hint] + [s for s in scales if abs(s - hint) > 0.05]
        best = None
        for sc in scales:
            r = self._feature_try(crop_gray, sc, ref_kp, ref_desc)
            if r is None:
                continue
            M, n_in, n_good = r
            ratio = n_in / max(1, n_good)
            k = float(np.sqrt(abs(np.linalg.det(M[:, :2]))))
            rot = float(np.degrees(np.arctan2(M[1, 0], M[0, 0])))
            if n_in < self.MIN_INLIERS or ratio < self.MIN_INLIER_RATIO or abs(rot) > self.MAX_ROTATION_DEG or k <= 0:
                continue
            if best is None or n_in > best[1]:
                best = (M, n_in, ratio, k, sc)
            if n_in >= 25 and ratio >= 0.6:
                break  # clearly found; don't spend time on other scales
        if best is None:
            return None
        M, n_in, ratio, k, sc = best
        if hint_key:
            self._tile_scale_hint[hint_key] = sc
        else:
            self._scale_hint = sc
        confidence = min(1.0, n_in / 15.0) * min(1.0, ratio / 0.6)
        return M, k, confidence

    def locate_crop(self, crop_bgr):
        """
        Returns (top_left_x, top_left_y, scale, confidence): where the crop sits on the reference map, in
        reference pixels, and how many reference pixels one crop pixel covers. None if nothing fits.
        Features first; the land/sea mask only as a capped fallback (see the module notes).
        """
        self.last_reason = None
        # 1. the high-detail airport tiles, nearest first
        for tile in tilemod.tiles_nearest_first(self.tiles, self.last_world_px):
            found = self._feature_locate(crop_bgr, tile.kp, tile.desc, hint_key=tile.name, scales=(1.0, 0.7, 0.5, 1.4, 2.0, 0.35))
            if found is not None:
                M_tile, _, confidence = found
                M = tilemod.compose(tile.to_world, M_tile)  # crop -> tile -> world map
                k = float(np.sqrt(abs(np.linalg.det(M[:, :2]))))
                self.last_transform, self.last_method = M, f"tile {tile.name}"
                return self._remember(M, k, confidence)
        # 2. the world map's own features
        found = self._feature_locate(crop_bgr)
        if found is not None:
            M, k, confidence = found
            self.last_transform, self.last_method = M, "features"
            return self._remember(M, k, confidence)
        result = self._locate_crop_mask(crop_bgr)
        if result is None:
            self.last_transform, self.last_method = None, None
            return None
        x, y, k, confidence = result
        self.last_transform = np.float64([[k, 0, x], [0, k, y]])
        self.last_method = "coastline"
        return x, y, k, min(confidence, self.MASK_CONFIDENCE_CAP)

    def _remember(self, M, k, confidence):
        self.last_world_px = M @ np.array([0.0, 0.0, 1.0])
        return float(M[0, 2]), float(M[1, 2]), k, confidence

    MASK_CONFIDENCE_CAP = 0.7  # below the filter's 0.75: a coastline-only match may confirm, never move you

    def _locate_crop_mask(self, crop_bgr):
        self.last_reason = None
        crop_mask = land_mask(crop_bgr)
        ch, cw = crop_mask.shape[:2]
        # A view that is nearly all land or all sea has no coastline to match: it fits hundreds of places equally well.
        fraction = float(crop_mask.mean())
        if fraction < 0.06 or fraction > 0.94:
            self.last_reason = "no coastline in the minimap view (almost all land or all sea)"
            return None
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
        if self.last_transform is not None:
            abs_x, abs_y = self.last_transform @ np.array([marker_px, marker_py, 1.0])
            return (float(abs_x), float(abs_y), confidence)

        abs_x = top_left_x + marker_px * scale
        abs_y = top_left_y + marker_py * scale
        return (abs_x, abs_y, confidence)
