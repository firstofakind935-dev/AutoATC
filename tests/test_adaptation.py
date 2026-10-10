"""Tests for the ATC365 adaptation: map matching against the radar world map and the monitor reports.
Run from the repo root:  python -m unittest discover -s tests -v
"""
import os
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import monitor_client  # noqa: E402
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


class MonitorClientTest(unittest.TestCase):
    def setUp(self):
        self.airports = monitor_client.load_airports()

    def test_airports_are_the_radar_points(self):
        self.assertAlmostEqual(self.airports["IRFD"][0], 502 / 24, places=2)
        self.assertAlmostEqual(self.airports["IRFD"][1], 508.3 / 24, places=2)

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


if __name__ == "__main__":
    unittest.main()
