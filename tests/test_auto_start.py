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
        crop = minimap_finder.blank_buttons(shot[r["top"]:r["top"] + r["height"], r["left"]:r["left"] + r["width"]])
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


class StaleCalibrationTest(unittest.TestCase):
    def test_old_frame_corrections_are_dropped(self):
        import json
        import tempfile
        from pathlib import Path
        import app_config
        import user_state
        saved = app_config.USER_STATE_PATH
        with tempfile.TemporaryDirectory() as d:
            app_config.USER_STATE_PATH = Path(d) / "user_state.json"
            try:
                app_config.USER_STATE_PATH.write_text(json.dumps({"airportOffsets": {"IRFD": {"dxNm": -0.05, "dyNm": -0.06}}}))
                st = user_state.load()
                self.assertEqual(st["airportOffsets"], {})
                self.assertTrue(st["dropped"])
                st["airportOffsets"]["IRFD"] = {"dxNm": 0.01, "dyNm": 0.0}
                user_state.save(st)
                again = user_state.load()
                self.assertEqual(again["airportOffsets"]["IRFD"]["dxNm"], 0.01)  # saved under the new frame: kept
                self.assertNotIn("dropped", again)
            finally:
                app_config.USER_STATE_PATH = saved


class MarkerColourTest(unittest.TestCase):
    def test_marker_found_when_the_colour_drifts(self):
        import marker_finder
        crop = cv2.imread(SHOT)[828:1125, 1690:2000]
        for shift in ([0, 0, 0], [-15, 30, -20], [20, -30, 25], [-45, -45, -45]):
            tinted = np.clip(crop.astype(int) + shift, 0, 255).astype(np.uint8)
            p = marker_finder.find_marker_pixel(tinted)
            self.assertIsNotNone(p, shift)
            self.assertLess(math.hypot(p[0] - 155, p[1] - 148.4), 3, shift)
        for shift in ([-30, -30, -30], [30, 30, 30], [0, 40, 0]):  # darker / brighter screens, a strong tint
            tinted = np.clip(crop.astype(int) + shift, 0, 255).astype(np.uint8)
            p = marker_finder.find_marker_pixel(tinted)
            self.assertLess(math.hypot(p[0] - 155, p[1] - 148.4), 3, shift)


class FlightTest(unittest.TestCase):
    def test_tracks_from_the_stand_into_the_air_through_gaps(self):
        # POS INIT on the stand, taxi at 15 kt, take off and climb out at 250 kt; 12 s with no fix over the sea.
        # (The speed used to be measured only between fixes 2 s apart - never, at one fix a second - so the
        # aircraft stayed "parked" and every gap froze it for a minute, up to 5 nm behind.)
        from position_filter import PositionFilter
        f, t, x, y = PositionFilter(), 0.0, 20.84, 21.35
        f.anchor(x, y, t)
        worst = 0.0
        for _ in range(600):
            t += 1.0
            x += (15 if t < 120 else min(250, 15 + (t - 120) * 4)) / 3600.0
            if 300 <= t < 312:
                continue
            ok, why = f.accept(x, y, 0.9, t)
            self.assertTrue(ok, f"t={t}: {why}")
            worst = max(worst, math.hypot(f.pos[0] - x, f.pos[1] - y))
        self.assertLess(worst, 1e-9)
        self.assertGreater(f.speed_kt, 240)

    def test_a_parked_aircraft_still_cannot_jump(self):
        from position_filter import PositionFilter
        f = PositionFilter()
        f.anchor(20.84, 21.35, 0.0)
        for t in range(1, 6):
            self.assertTrue(f.accept(20.84, 21.35, 0.9, float(t))[0])
        self.assertFalse(f.accept(20.0, 21.0, 0.95, 6.0)[0])  # 0.9 nm away a second later: a look-alike, refused


class ShortFinalTest(unittest.TestCase):

    def test_keeps_moving_through_the_gap_and_refuses_a_far_look_alike(self):
        from position_filter import PositionFilter
        f = PositionFilter()
        t, x, y = 0.0, 10.0, 23.2
        f.anchor(x, y, t)
        for _ in range(60):  # cruising in at 140 kt, a fix a second
            t += 1.0
            x -= 140 / 3600.0
            self.assertTrue(f.accept(x, y, 0.9, t)[0])
        last = f.pos
        # 20 s with no fix: the reported position keeps moving along the track (it used to freeze)
        moved = f.position_at(t + 20)
        self.assertAlmostEqual(last[0] - moved[0], 140 / 3600.0 * 20, places=3)
        # ...and stops after COAST_SECONDS instead of flying on for ever
        self.assertAlmostEqual(f.position_at(t + 300)[0], f.position_at(t + 30)[0], places=6)
        # 60 s later, rolled out and slowed down: about 1.3 nm further west
        t += 60
        true_x = x - 1.3
        # a look-alike 3 nm off the track is refused (it used to be believed: anything within ~7 nm was)
        ok, why = f.accept(true_x + 0.5, y + 3.0, 0.95, t)
        self.assertFalse(ok, why)
        # the real position, short of where the old track would have put us, is taken straight away
        ok, why = f.accept(true_x, y, 0.9, t + 1)
        self.assertTrue(ok, why)
