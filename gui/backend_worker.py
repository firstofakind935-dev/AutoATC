"""
Runs the actual capture -> locate -> webhook loop on a background thread,
so the GUI stays responsive. Reuses the existing backend code in src/
rather than duplicating it.

Position is now found via map_locator.MapLocator (template matching against
a saved reference map image) instead of the old manual coordinate
calibration - no typed-in coordinates needed.
"""

import os
import sys
import time

from PyQt6.QtCore import QThread, pyqtSignal

SRC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"
)
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

import app_config as config  # noqa: E402
import webhook         # noqa: E402
import broadcast_server  # noqa: E402
import monitor_client  # noqa: E402
import frames  # noqa: E402
import posinit  # noqa: E402
import user_state as user_state_store  # noqa: E402
from position_filter import PositionFilter  # noqa: E402
from marker_finder import find_marker_pixel  # noqa: E402
from map_locator import MapLocator  # noqa: E402
import minimap_finder  # noqa: E402
from reference_registration import prepare_tracking_reference  # noqa: E402

REFERENCE_MAP_PATH = str(config.REFERENCE_MAP_PATH)  # the radar world map shipped with the app
USER_REFERENCE_MAP_PATH = str(config.USER_REFERENCE_MAP_PATH)  # your own capture, if you made one

# Matches below this confidence are treated as "no reliable fix" and skipped
# rather than sent out - avoids spamming garbage positions on a bad frame.
MIN_CONFIDENCE = getattr(config, "MIN_MATCH_CONFIDENCE", 0.35)


class TrackerWorker(QThread):
    log = pyqtSignal(str)
    position = pyqtSignal(float, float)
    error = pyqtSignal(str)
    session_started = pyqtSignal(str, str)
    session_stopped = pyqtSignal(str, str)

    def __init__(self, callsign: str, aircraft_type: str, anchor=None, user_state=None):
        super().__init__()
        self._running = False
        self.callsign = callsign
        self.aircraft_type = aircraft_type
        self._anchor = anchor  # (x_nm, y_nm) on the radar grid from a stand entry, applied at the next tick
        self.user_state = user_state or {"standOffsets": {}, "airportOffsets": {}}

    def set_anchor(self, x_nm: float, y_nm: float, icao: str = None):
        """POS INIT: a known position (a stand), trusted outright; with the airport, the next good minimap match
        calibrates that airport. Safe to call from the GUI thread."""
        self._anchor = (x_nm, y_nm, icao)

    def run(self):
        import mss
        import cv2
        import numpy as np

        if not os.path.exists(REFERENCE_MAP_PATH):
            self.error.emit("The shipped radar world map (src/reference_map.png) is missing.")
            return

        try:
            locator, to_radar_px, reference_message = prepare_tracking_reference(
                REFERENCE_MAP_PATH, USER_REFERENCE_MAP_PATH
            )
            self.log.emit(reference_message)
        except Exception as e:
            self.error.emit(f"Failed to load reference map: {e}")
            return

        reporter = monitor_client.MonitorReporter(
            getattr(config, "MONITOR_URL", ""),
            getattr(config, "MONITOR_API_KEY", ""),
            getattr(config, "MONITOR_POST_MIN_INTERVAL_SECONDS", 2),
        )
        if not reporter.configured:
            self.log.emit("No MONITOR_URL in settings - positions will not reach ATC365.")
        reporter.user_offsets = self.user_state.get("airportOffsets", {})
        reporter.user_stand_nudges = self.user_state.get("standOffsets", {})
        filt = PositionFilter()
        pending_init = None
        last_ignored_log = 0.0
        auto_region = minimap_finder.wants_auto(config.MINIMAP_REGION)
        region = None if auto_region else config.MINIMAP_REGION
        next_region_search = 0.0
        region_logged = False
        misses = 0

        session_started = False
        try:
            with mss.mss() as sct:
                self._running = True
                session_started = True
                self.log.emit(
                    f"Tracker started for {self.callsign} ({self.aircraft_type})."
                )
                self.session_started.emit(self.callsign, self.aircraft_type)
                while self._running:
                    now = time.time()
                    if self._anchor is not None:
                        ax, ay, *rest = self._anchor
                        icao = rest[0] if rest else None
                        self._anchor = None
                        filt.anchor(ax, ay, now)
                        # look at that airport's tile first
                        locator.last_world_px = (ax * monitor_client.PX_PER_NM, ay * monitor_client.PX_PER_NM)
                        pending_init = {"icao": icao, "xy": (ax, ay), "until": now + posinit.WINDOW_SECONDS} if icao else None
                        self.log.emit(f"POS INIT: on your stand ({ax:.2f}, {ay:.2f})"
                                      + (" - lining up the minimap with it..." if icao else "."))

                    if region is None:
                        # "auto": find the minimap on screen (and again whenever it goes missing)
                        if now >= next_region_search:
                            next_region_search = now + 3
                            region = minimap_finder.locate_on_screen(sct)
                            if region:
                                self.log.emit(f"Found the minimap at {region['left']},{region['top']} "
                                              f"({region['width']}x{region['height']}).")
                                region_logged = False
                            elif not region_logged:
                                region_logged = True
                                self.log.emit("Looking for the PTFS minimap - keep the game visible with the minimap open...")
                        if region is None:
                            time.sleep(0.5)
                            continue

                    shot = sct.grab(region)
                    frame = cv2.cvtColor(np.array(shot), cv2.COLOR_BGRA2BGR)
                    marker_px = find_marker_pixel(frame)
                    misses = 0 if marker_px is not None else misses + 1
                    if auto_region and misses >= 10:
                        region, misses = None, 0  # the window moved or the minimap closed: look again

                    if marker_px is None:
                        if not filt.has_position:
                            self.log.emit("Marker not found this frame.")
                    else:
                        result = locator.locate_marker(frame, marker_px)
                        if result is None:
                            reason = getattr(locator, "last_reason", None) or "Could not match minimap to reference map."
                            if not filt.has_position or now - last_ignored_log > 10:
                                last_ignored_log = now
                                self.log.emit(f"Minimap: {reason}")
                        else:
                            abs_x, abs_y, confidence = result
                            if confidence < MIN_CONFIDENCE:
                                self.log.emit(
                                    f"Low-confidence match ({confidence:.2f}), skipping."
                                )
                            else:
                                # Matched on the world-map picture; carry it into the radar's frame before judging it.
                                radar_x, radar_y = to_radar_px(abs_x, abs_y)
                                px_nm, py_nm = monitor_client.pixel_to_nm(radar_x, radar_y)
                                if pending_init and now <= pending_init["until"]:
                                    ok_cal, offset, message = posinit.calibrate(pending_init["xy"], (px_nm, py_nm), confidence)
                                    if ok_cal or confidence >= posinit.MIN_SCORE:
                                        self.log.emit(f"POS INIT {pending_init['icao']}: {message}")
                                        if ok_cal:
                                            self.user_state.setdefault("airportOffsets", {})[pending_init["icao"]] = offset
                                            try:
                                                user_state_store.save(self.user_state)
                                            except OSError as e:
                                                self.log.emit(f"Could not save the calibration: {e}")
                                        pending_init = None
                                elif pending_init:
                                    self.log.emit("POS INIT: no good minimap match within a minute - keeping the stand position.")
                                    pending_init = None
                                gx, gy, *_ = frames.picture_to_game(
                                    px_nm, py_nm,
                                    self.user_state.get("airportOffsets", {}),
                                    self.user_state.get("standOffsets", {}),
                                )
                                ok, reason = filt.accept(gx, gy, confidence, now)
                                if not ok:
                                    if now - last_ignored_log > 5:
                                        last_ignored_log = now
                                        self.log.emit(f"Minimap fix {reason}")
                                else:
                                    self.position.emit(abs_x, abs_y)
                                    webhook_result = webhook.post_position(
                                        abs_x, abs_y,
                                        callsign=self.callsign,
                                        aircraft_type=self.aircraft_type,
                                    )
                                    if webhook_result:
                                        self.log.emit(webhook_result)
                                    broadcast_server.broadcast({
                                        "callsign": self.callsign,
                                        "aircraft_type": self.aircraft_type,
                                        "x": abs_x,
                                        "y": abs_y,
                                        "confidence": confidence,
                                        "timestamp": time.time(),
                                    })

                    # Report whatever we believe our position is (a stand entry holds you there until fixes agree).
                    if filt.has_position:
                        monitor_result = reporter.report_game(
                            self.callsign, self.aircraft_type, filt.pos[0], filt.pos[1]
                        )
                        if monitor_result:
                            self.log.emit(monitor_result)

                    time.sleep(config.POLL_INTERVAL_SECONDS)
        except Exception as e:
            self.error.emit(f"Tracker failed: {e}")
        finally:
            self._running = False
            if session_started:
                self.session_stopped.emit(self.callsign, self.aircraft_type)

        self.log.emit("Tracker stopped.")

    def stop(self):
        self._running = False


class WebhookEventWorker(QThread):
    result = pyqtSignal(str)

    def __init__(self, callsign: str, aircraft_type: str, signed_in: bool):
        super().__init__()
        self.callsign = callsign
        self.aircraft_type = aircraft_type
        self.signed_in = signed_in

    def run(self):
        self.result.emit(webhook.post_session_event(
            self.callsign, self.aircraft_type, self.signed_in
        ))
