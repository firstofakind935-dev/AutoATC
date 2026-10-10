"""
Main entry point. Run this after calibrate.py has produced calibration.json.

Loop:
  1. Capture the minimap region from the screen
  2. Find the player marker's pixel position
  3. Convert to game coordinates using the saved calibration
  4. Post to Discord (throttled) and broadcast to any connected web clients
"""

import time
import sys

import cv2
import mss
import numpy as np

import config
import webhook
import broadcast_server
from geometry import CoordinateTransform
from marker_finder import find_marker_pixel


def capture_minimap(sct):
    shot = sct.grab(config.MINIMAP_REGION)
    img = np.array(shot)  # BGRA
    return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)


def main():
    try:
        transform = CoordinateTransform.load("calibration.json")
    except FileNotFoundError:
        print("No calibration.json found. Run calibrate.py first.")
        sys.exit(1)

    broadcast_server.run_in_background_thread()
    time.sleep(0.5)  # give the server a moment to start

    print(f"Tracking every {config.POLL_INTERVAL_SECONDS}s. Ctrl+C to stop.")

    with mss.mss() as sct:
        while True:
            frame = capture_minimap(sct)
            marker_px = find_marker_pixel(frame)

            if marker_px is None:
                print("[tracker] Marker not found this frame — skipping.")
            else:
                px, py = marker_px
                gx, gy = transform.pixel_to_game(px, py)
                print(f"[tracker] pixel=({px:.1f},{py:.1f}) -> "
                      f"game=({gx:.1f},{gy:.1f})")

                webhook_result = webhook.post_position(gx, gy)
                if webhook_result:
                    print(f"[webhook] {webhook_result}")
                broadcast_server.broadcast({
                    "callsign": config.CALLSIGN,
                    "x": gx,
                    "y": gy,
                    "timestamp": time.time(),
                })

            time.sleep(config.POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
