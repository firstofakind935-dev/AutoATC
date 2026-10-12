"""No-setup start: the minimap is found on screen and the first fix needs no POS INIT."""

import math
import os
import sys
import unittest

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))

import minimap_finder  # noqa: E402
import stands  # noqa: E402
from map_locator import MapLocator  # noqa: E402
from marker_finder import find_marker_pixel  # noqa: E402

# A pilot's full screen at 2000x1125, parked at Rockford stand 14 (A350 cockpit view, minimap bottom right).
SHOT = os.path.join(HERE, "fixtures", "ptfs_irfd_stand14.jpg")


class MinimapFinderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shot = cv2.imread(SHOT)

    def test_finds_the_panel(self):
        r = minimap_finder.find_minimap(self.shot)
        self.assertIsNotNone(r)
        self.assertLess(abs(r["left"] - 1690), 8)
        self.assertLess(abs(r["top"] - 828), 8)
        self.assertLess(abs(r["width"] - 306), 10)
        self.assertLess(abs(r["height"] - 297), 10)

    def test_any_screen_size(self):
        for f in (0.5, 0.64, 0.96, 1.5, 1.92):  # ~560p up to 4K
            small = cv2.resize(self.shot, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
            r = minimap_finder.find_minimap(small)
            self.assertIsNotNone(r, f"scale {f}")
            self.assertLess(abs(r["left"] / f - 1690), 10, f"scale {f}")

    def test_nothing_on_a_screen_without_it(self):
        self.assertIsNone(minimap_finder.find_minimap(np.zeros((1080, 1920, 3), np.uint8)))
        no_map = self.shot.copy()
        no_map[800:, 1650:] = (40, 40, 40)
        self.assertIsNone(minimap_finder.find_minimap(no_map))

    def test_auto_setting(self):
        self.assertTrue(minimap_finder.wants_auto("auto"))
        self.assertTrue(minimap_finder.wants_auto({"left": 20, "top": 20, "width": 300, "height": 300}))  # old placeholder
        self.assertFalse(minimap_finder.wants_auto({"left": 5, "top": 6, "width": 200, "height": 200}))


class FirstFixTest(unittest.TestCase):
    def test_parked_at_rockford_without_pos_init(self):
        shot = cv2.imread(SHOT)
        r = minimap_finder.find_minimap(shot)
        crop = shot[r["top"]:r["top"] + r["height"], r["left"]:r["left"] + r["width"]]
        marker = find_marker_pixel(crop)
        self.assertIsNotNone(marker)
        locator = MapLocator(os.path.join(HERE, "..", "src", "reference_map.png"))
        x, y, confidence = locator.locate_marker(crop, marker)  # no hint, no tile: the whole world
        stand = stands.stand_fix("IRFD", "14")
        off = math.hypot(x / 48 - stand["xNm"], y / 48 - stand["yNm"])
        self.assertGreater(confidence, 0.8)
        self.assertLess(off, 0.08, f"{off:.3f} nm from stand 14")


if __name__ == "__main__":
    unittest.main()
