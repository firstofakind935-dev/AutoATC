"""Tests for the ATC365 adaptation: map matching against the radar world map and the monitor reports.
Run from the repo root:  python -m unittest discover -s tests -v
"""
import math
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import frames  # noqa: E402
import monitor_client  # noqa: E402
import position_filter  # noqa: E402
import stands  # noqa: E402
from map_locator import MapLocator, land_mask  # noqa: E402

REFERENCE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "reference_map.png")


def fake_minimap(reference_bgr, x0, y0, w, h, zoom):
    """The reference map seen through a window, redrawn crisp at `zoom` (like the real minimap)."""
    mask = land_mask(reference_bgr)[y0:y0 + h, x0:x0 + w]
    big = cv2.resize(mask, None, fx=zoom, fy=zoom, interpolation=cv2.INTER_NEAREST)
    img = np.zeros((big.shape[0], big.shape[1], 3), np.uint8)
    img[:] = (125, 90, 59)  # BGR sea
    img[big > 0.5] = (68, 137, 67)  # BGR land
    return img


class LocatorTest(unittest.TestCase):
    def test_finds_a_zoomed_in_minimap_on_the_world_map(self):
        ref = cv2.imread(REFERENCE)
        loc = MapLocator(REFERENCE)
        x0, y0, w, h = 940, 960, 150, 130  # around Rockford, in reference pixels
        crop = fake_minimap(ref, x0, y0, w, h, 6)
        x, y, scale, conf = loc.locate_crop(crop)
        self.assertGreater(conf, 0.6)
        self.assertLess(abs(x - x0), 4)
        self.assertLess(abs(y - y0), 4)
        self.assertAlmostEqual(scale, 1 / 6, delta=0.02)

    def test_open_sea_is_not_a_fix(self):
        loc = MapLocator(REFERENCE)
        sea = np.zeros((200, 200, 3), np.uint8)
        sea[:] = (125, 90, 59)
        self.assertIsNone(loc.locate_crop(sea))


class ReferenceRegistrationTest(unittest.TestCase):
    def test_your_own_reference_is_lined_up_with_the_radar_map(self):
        import tempfile
        from reference_registration import prepare_tracking_reference

        ref = cv2.imread(REFERENCE)
        # "your capture": most of the play area, drawn at 1.5x - a different size than the shipped map
        x0, y0, w, h = 600, 500, 900, 700
        user = fake_minimap(ref, x0, y0, w, h, 1.5)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "mine.png")
            cv2.imwrite(path, user)
            locator, to_radar, message = prepare_tracking_reference(REFERENCE, path)
        self.assertIn("Using your reference map", message)
        # a point at pixel (300, 450) of the capture is (x0 + 300/1.5, y0 + 450/1.5) on the radar map
        rx, ry = to_radar(300, 450)
        self.assertLess(abs(rx - (x0 + 200)), 4)
        self.assertLess(abs(ry - (y0 + 300)), 4)

    def test_falls_back_to_the_radar_map(self):
        import tempfile
        from reference_registration import prepare_tracking_reference

        sea = np.zeros((300, 300, 3), np.uint8)
        sea[:] = (125, 90, 59)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "sea.png")
            cv2.imwrite(path, sea)
            _, to_radar, message = prepare_tracking_reference(REFERENCE, path)
        self.assertIn("could not be lined up", message)
        self.assertEqual(to_radar(10, 20), (10, 20))
        _, to_radar, message = prepare_tracking_reference(REFERENCE, os.path.join(d, "missing.png"))
        self.assertIn("radar world map", message)


class MonitorClientTest(unittest.TestCase):
    def setUp(self):
        self.airports = monitor_client.load_airports()

    def test_airports_are_the_radar_points(self):
        self.assertAlmostEqual(self.airports["IRFD"][0], 498.9 / 24, places=2)
        self.assertAlmostEqual(self.airports["IRFD"][1], 509.1 / 24, places=2)

    def test_pixel_becomes_distance_and_bearing_from_the_nearest_airport(self):
        ax, ay = self.airports["IRFD"]
        # 1 nm due east of IRFD, in the 48 px-per-nm reference frame
        icao, dist, brg = monitor_client.nearest_airport(self.airports, ax + 1, ay)
        self.assertEqual(icao, "IRFD")
        self.assertAlmostEqual(dist, 1.0, places=3)
        self.assertAlmostEqual(brg, 90.0, places=3)
        _, _, north = monitor_client.nearest_airport(self.airports, ax, ay - 0.5)  # y grows south
        self.assertAlmostEqual(north, 0.0, places=3)

    def test_speed_and_heading_come_from_the_track(self):
        r = monitor_client.MonitorReporter("http://x", clock=lambda: 0)
        ax, ay = self.airports["IRFD"]
        first = r.build_payload("N1", "A320", ax * 48, ay * 48, now=0.0)
        self.assertIsNone(first["speed"])
        # 0.05 nm east in 6 s = 30 kt, heading 090
        p = r.build_payload("N1", "A320", (ax + 0.05) * 48, ay * 48, now=6.0)
        self.assertEqual(p["speed"], 30)
        self.assertEqual(p["position"]["headingDeg"], 90)
        # stopped: speed ~0, heading kept
        q = r.build_payload("N1", "A320", (ax + 0.05) * 48, ay * 48, now=20.0)
        self.assertLess(q["speed"], 3)
        self.assertEqual(q["position"]["headingDeg"], 90)

    def test_posts_to_api_position_with_the_key_and_throttles(self):
        calls = []

        class Resp:
            status_code = 204
            text = ""

        class Session:
            def post(self, url, json=None, headers=None, timeout=None):
                calls.append((url, json, headers))
                return Resp()

        now = [100.0]
        r = monitor_client.MonitorReporter("https://m.test/", "secret", 2, session=Session(), clock=lambda: now[0])
        ax, ay = self.airports["IRFD"]
        self.assertIn("Sent to monitor", r.report("N42Y", "A320", ax * 48, ay * 48))
        now[0] += 0.5
        self.assertIsNone(r.report("N42Y", "A320", ax * 48, ay * 48))  # throttled
        now[0] += 3
        self.assertIn("Sent to monitor", r.report("N42Y", "A320", ax * 48, ay * 48))
        self.assertEqual(len(calls), 2)
        url, body, headers = calls[0]
        self.assertEqual(url, "https://m.test/api/position")
        self.assertEqual(headers["Authorization"], "Bearer secret")
        self.assertEqual(body["callsign"], "N42Y")
        self.assertEqual(body["position"]["referenceAirport"], "IRFD")

    def test_no_url_means_no_posting(self):
        r = monitor_client.MonitorReporter("", clock=lambda: 0)
        self.assertFalse(r.configured)
        self.assertIsNone(r.report("N1", "A320", 100, 100))


class StandsAndFramesTest(unittest.TestCase):
    def test_stand_data_and_nudges(self):
        self.assertEqual(sorted(stands.list_stands()), ["IPPH", "IRFD", "ITKO"])
        fix = stands.stand_fix("ITKO", "22")
        self.assertAlmostEqual(fix["xNm"], 19.338, places=3)  # the same point the companion app computes
        self.assertAlmostEqual(fix["yNm"], 5.034, places=3)
        mine = stands.stand_fix("ITKO", "22", {"ITKO": {"dxNm": -0.05, "dyNm": 0.0}})
        self.assertAlmostEqual(mine["xNm"] - fix["xNm"], -0.05, places=6)
        self.assertIn("error", stands.stand_fix("IRFD", "99"))
        self.assertIn("error", stands.stand_fix("IMLR", "1"))

    def test_picture_fix_is_carried_to_the_stand(self):
        x, y, dx, dy, icao = frames.picture_to_game(19.3, 5.05)  # what a picture-frame fix said at ITKO stand 22
        stand = stands.stand_fix("ITKO", "22")
        # The picture is on the exact game frame now, so the raw fix already sits on the stand (0.04 nm away).
        self.assertLess(math.hypot(x - stand["xNm"], y - stand["yNm"]), 0.06)
        self.assertEqual((dx, dy), (0.0, 0.0))
        far = frames.picture_to_game(2.0, 2.0)
        self.assertEqual((far[2], far[3]), (0.0, 0.0))

    def test_report_goes_through_the_frame_shift(self):
        posted = []

        class Resp:
            status_code = 204
            text = ""

        class Session:
            def post(self, url, json=None, headers=None, timeout=None):
                posted.append(json)
                return Resp()

        r = monitor_client.MonitorReporter("http://x", "", 0, session=Session(), clock=lambda: 100.0)
        r.report("N42Y", "A350", 19.3 * 48, 5.05 * 48)
        p = posted[0]["position"]
        stand = stands.stand_fix("ITKO", "22")
        ax, ay = monitor_client.load_airports()["ITKO"]
        got_x = ax + p["distanceNm"] * math.sin(math.radians(p["bearingDeg"]))
        got_y = ay - p["distanceNm"] * math.cos(math.radians(p["bearingDeg"]))
        self.assertEqual(p["referenceAirport"], "ITKO")
        self.assertLess(math.hypot(got_x - stand["xNm"], got_y - stand["yNm"]), 0.12)


class PositionFilterTest(unittest.TestCase):
    def test_a_parked_aircraft_cannot_jump(self):
        f = position_filter.PositionFilter()
        f.anchor(19.5, 5.2, 0.0)
        ok, why = f.accept(31.4, 25.1, 0.9, 3.0)  # 23 nm away, strong match: still refused the first time
        self.assertFalse(ok)
        self.assertTrue(f.accept(19.52, 5.21, 0.8, 6.0)[0])

    def test_a_jump_needs_agreeing_strong_fixes(self):
        f = position_filter.PositionFilter()
        f.anchor(19.5, 5.2, 0.0)
        # parked: the same answer must hold for a minute, strongly
        self.assertFalse(f.accept(25.0, 10.0, 0.9, 5.0)[0])
        self.assertFalse(f.accept(25.0, 10.0, 0.9, 7.0)[0])
        self.assertFalse(f.accept(25.0, 10.0, 0.9, 9.0)[0])  # three agreeing, but only 4 s old
        self.assertTrue(f.accept(25.0, 10.0, 0.9, 66.0)[0])
        # moving: three agreeing strong fixes are enough
        m = position_filter.PositionFilter()
        m.anchor(19.5, 5.2, 0.0)
        m.speed_kt = 120.0
        self.assertFalse(m.accept(25.0, 10.0, 0.8, 5.0)[0])
        self.assertFalse(m.accept(25.0, 10.0, 0.8, 7.0)[0])
        self.assertTrue(m.accept(25.0, 10.0, 0.8, 9.0)[0])
        g = position_filter.PositionFilter()
        g.anchor(19.5, 5.2, 0.0)
        for t in (5.0, 7.0, 9.0, 80.0):
            self.assertFalse(g.accept(25.0, 10.0, 0.6, t)[0])  # agreeing but weak: never believed

    def test_first_fix_must_be_strong(self):
        f = position_filter.PositionFilter()
        self.assertFalse(f.accept(10.0, 10.0, 0.5, 0.0)[0])
        self.assertTrue(f.accept(10.0, 10.0, 0.8, 1.0)[0])


class NoCoastlineTest(unittest.TestCase):
    def test_a_view_with_no_coastline_is_refused(self):
        loc = MapLocator(REFERENCE)
        land = np.zeros((200, 200, 3), np.uint8)
        land[:] = (68, 137, 67)
        self.assertIsNone(loc.locate_crop(land))
        self.assertIn("coastline", loc.last_reason)


class TileTest(unittest.TestCase):
    """The Rockford tile (src/tiles/IRFD.png): a minimap-like view of it is placed to a few metres, at several zooms."""

    def test_minimap_views_of_rockford_are_placed_precisely(self):
        import json as _json
        here = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "tiles")
        tile = cv2.imread(os.path.join(here, "IRFD.png"))
        to_world = np.array(_json.load(open(os.path.join(here, "IRFD.json")))["toWorld"])
        loc = MapLocator(REFERENCE)
        for (x0, y0, w) in [(400, 430, 300), (480, 500, 200), (420, 470, 180), (250, 600, 300)]:  # incl. apron-only views
            for zoom in (0.6, 1.0, 1.6):
                crop = cv2.resize(tile[y0:y0 + w, x0:x0 + w], None, fx=zoom, fy=zoom,
                                  interpolation=cv2.INTER_AREA if zoom < 1 else cv2.INTER_CUBIC)
                crop = cv2.GaussianBlur(crop, (3, 3), 0.8)
                r = loc.locate_crop(crop)
                self.assertIsNotNone(r, (x0, y0, zoom))
                self.assertTrue(loc.last_method.startswith("tile"), loc.last_method)
                got = loc.last_transform @ np.array([crop.shape[1] / 2, crop.shape[0] / 2, 1.0])
                want = to_world @ np.array([x0 + w / 2, y0 + w / 2, 1.0])
                err_m = float(np.hypot(*(got - want))) / 48 * 1852
                self.assertLess(err_m, 30, (x0, y0, zoom, err_m))

    def test_a_view_it_cannot_place_is_refused_not_guessed(self):
        loc = MapLocator(REFERENCE)
        noise = np.random.default_rng(3).integers(0, 255, (200, 200, 3), dtype=np.uint8)
        r = loc.locate_crop(noise)
        self.assertTrue(r is None or r[3] <= MapLocator.MASK_CONFIDENCE_CAP)


class PosInitTest(unittest.TestCase):
    def test_a_good_match_at_the_stand_calibrates_the_airport(self):
        import posinit
        stand = stands.stand_fix("IRFD", "12")
        raw = (stand["xNm"] - 0.05, stand["yNm"] + 0.12)  # where the picture says the same spot is
        ok, offset, msg = posinit.calibrate((stand["xNm"], stand["yNm"]), raw, 0.95)
        self.assertTrue(ok, msg)
        # with that calibration, a later fix at the same picture spot lands on the stand
        x, y, *_ = frames.picture_to_game(raw[0], raw[1], {"IRFD": offset})
        self.assertLess(math.hypot(x - stand["xNm"], y - stand["yNm"]), 0.01)

    def test_a_far_or_weak_match_teaches_nothing(self):
        import posinit
        self.assertFalse(posinit.calibrate((20.0, 20.0), (21.0, 20.0), 0.95)[0])  # 1 nm: wrong stand or wrong match
        self.assertFalse(posinit.calibrate((20.0, 20.0), (20.05, 20.0), 0.5)[0])  # too weak


if __name__ == "__main__":
    unittest.main()
