"""
Sends position reports to the ATC365 tracking system (the AutoATC monitor).

The tracker finds you as a pixel on the reference map. The reference map shipped here is the ATC365
radar's own world map (48 px per nautical mile), so a pixel is a point on the radar's grid. The
monitor wants "distance and bearing from an airport", so this converts the pixel to that - measured from
the nearest airport, at the same airport points the radar draws - and posts it to POST /api/position.

The monitor also shows heading and speed, which this app doesn't read off the screen. They are worked
out from the last few fixes instead (course and speed over the ground).
"""

import json
import math
import time
from collections import deque
from pathlib import Path

import requests

import frames

PX_PER_NM = 48.0  # the bundled reference map: the radar world map at 2x its 24 px per nm
SPEED_WINDOW_SECONDS = 8.0
MIN_MOVING_KT = 3.0  # below this, keep the last heading instead of a noisy course
MAX_PLAUSIBLE_KT = 700.0  # a bigger "speed" is a bad fix, not a fast aircraft

ANCHORS_PATH = Path(__file__).resolve().parent / "world_anchors.json"


def load_airports(path=ANCHORS_PATH):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return {icao: (a["xNm"], a["yNm"]) for icao, a in data["airports"].items()}


def pixel_to_nm(px, py):
    return px / PX_PER_NM, py / PX_PER_NM


def nearest_airport(airports, x_nm, y_nm):
    """-> (icao, distance_nm, bearing_deg) from the closest airport to the point."""
    best = None
    for icao, (ax, ay) in airports.items():
        d = math.hypot(x_nm - ax, y_nm - ay)
        if best is None or d < best[1]:
            best = (icao, d, ax, ay)
    icao, d, ax, ay = best
    bearing = math.degrees(math.atan2(x_nm - ax, -(y_nm - ay))) % 360  # y grows south
    return icao, d, bearing


class MonitorReporter:
    def __init__(self, monitor_url, api_key="", min_interval=2.0, airports=None, session=None, clock=time.time):
        self.url = (monitor_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.min_interval = float(min_interval)
        self.airports = airports if airports is not None else load_airports()
        self.session = session or requests
        self.clock = clock
        self._fixes = deque()  # (time, x_nm, y_nm)
        self._last_post = 0.0
        self._heading = None
        self.user_offsets = {}  # the pilot's airport calibrations
        self.user_stand_nudges = {}  # the pilot's stand nudges

    @property
    def configured(self):
        return bool(self.url)

    def _course_and_speed(self, now, x_nm, y_nm):
        self._fixes.append((now, x_nm, y_nm))
        # Keep the newest fix older than the window too, so a gap in reports still gives a speed (and 'stopped').
        while len(self._fixes) > 2 and now - self._fixes[1][0] > SPEED_WINDOW_SECONDS:
            self._fixes.popleft()
        t0, x0, y0 = self._fixes[0]
        dt = now - t0
        if dt < 2.0:
            return None, self._heading
        dist = math.hypot(x_nm - x0, y_nm - y0)
        speed = dist / (dt / 3600.0)
        if speed > MAX_PLAUSIBLE_KT:
            self._fixes.clear()
            self._fixes.append((now, x_nm, y_nm))
            return None, self._heading
        if speed >= MIN_MOVING_KT:
            self._heading = math.degrees(math.atan2(x_nm - x0, -(y_nm - y0))) % 360
        return speed, self._heading

    def build_payload(self, callsign, aircraft_type, px, py, now=None):
        """Payload for a reference-map pixel taken as-is (no frame shift)."""
        x_nm, y_nm = pixel_to_nm(px, py)
        return self.build_payload_nm(callsign, aircraft_type, x_nm, y_nm, now)

    def build_payload_nm(self, callsign, aircraft_type, x_nm, y_nm, now=None):
        now = self.clock() if now is None else now
        icao, distance, bearing = nearest_airport(self.airports, x_nm, y_nm)
        speed, heading = self._course_and_speed(now, x_nm, y_nm)
        return {
            "callsign": callsign,
            "aircraftType": aircraft_type or None,
            "speed": round(speed) if speed is not None else None,
            "position": {
                "distanceNm": round(distance, 2),
                "bearingDeg": round(bearing, 1),
                "referenceAirport": icao,
                "altitudeFt": None,
                "headingDeg": round(heading) if heading is not None else None,
                "fixAgeSec": 0,
                "squawk": None,
                "identing": False,
            },
        }

    def report(self, callsign, aircraft_type, px, py):
        """A fix on the reference map picture: carried into the radar's frame, then posted (throttled)."""
        x_nm, y_nm = pixel_to_nm(px, py)
        gx, gy, *_ = frames.picture_to_game(x_nm, y_nm, self.user_offsets, self.user_stand_nudges)
        return self.report_game(callsign, aircraft_type, gx, gy)

    def report_game(self, callsign, aircraft_type, x_nm, y_nm):
        """Posts a position already on the radar's grid (nm). Returns a message to log, or None."""
        if not self.configured:
            return None
        now = self.clock()
        payload = self.build_payload_nm(callsign, aircraft_type, x_nm, y_nm, now)  # always fed, so speed uses every fix
        if now - self._last_post < self.min_interval:
            return None
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        self._last_post = now
        try:
            resp = self.session.post(f"{self.url}/api/position", json=payload, headers=headers, timeout=5)
        except requests.RequestException as e:
            return f"Monitor post failed: {e}"
        if resp.status_code >= 300:
            return f"Monitor rejected the position ({resp.status_code}): {resp.text.strip()[:200]}"
        p = payload["position"]
        return f"Sent to monitor: {p['distanceNm']:.2f} nm brg {p['bearingDeg']:.0f} from {p['referenceAirport']}"
