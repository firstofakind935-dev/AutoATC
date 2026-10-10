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
from marker_finder import find_marker_pixel  # noqa: E402
from map_locator import MapLocator  # noqa: E402
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

    def __init__(self, callsign: str, aircraft_type: str):
        super().__init__()
        self._running = False
        self.callsign = callsign
        self.aircraft_type = aircraft_type

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
                    shot = sct.grab(config.MINIMAP_REGION)
                    frame = cv2.cvtColor(np.array(shot), cv2.COLOR_BGRA2BGR)
                    marker_px = find_marker_pixel(frame)

                    if marker_px is None:
                        self.log.emit("Marker not found this frame.")
                    else:
                        result = locator.locate_marker(frame, marker_px)
                        if result is None:
                            self.log.emit("Could not match minimap to reference map.")
                        else:
                            abs_x, abs_y, confidence = result
                            if confidence < MIN_CONFIDENCE:
                                self.log.emit(
                                    f"Low-confidence match ({confidence:.2f}), skipping."
                                )
                            else:
                                self.position.emit(abs_x, abs_y)
                                radar_x, radar_y = to_radar_px(abs_x, abs_y)
                                monitor_result = reporter.report(
                                    self.callsign, self.aircraft_type, radar_x, radar_y
                                )
                                if monitor_result:
                                    self.log.emit(monitor_result)
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
