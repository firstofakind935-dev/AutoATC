"""
One-time calibration tool.

Run this while PTFS is open and your minimap is visible. It grabs the
minimap region, shows it in a window, and lets you click points you know
the real in-game coordinates for (e.g. directly over known airports).
After each click it asks you to type in that point's real game X,Y.

Needs at least 3 points; 4-6 spread across the map gives a much more
accurate fit than the bare minimum.
"""

import sys
import cv2
import mss
import numpy as np

import config
from geometry import CoordinateTransform

clicked_points = []


def capture_minimap():
    with mss.mss() as sct:
        shot = sct.grab(config.MINIMAP_REGION)
        img = np.array(shot)  # BGRA
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)


def on_mouse(event, x, y, flags, param):
    if event == cv2.EVENT_LBUTTONDOWN:
        clicked_points.append((x, y))
        print(f"Clicked pixel ({x}, {y}). Marked on image — press any key "
              f"in the terminal after entering coordinates.")


def main():
    print("Capturing minimap region from config.MINIMAP_REGION...")
    frame = capture_minimap()

    window = "Calibration - click known points, ESC when done"
    cv2.namedWindow(window)
    cv2.setMouseCallback(window, on_mouse)

    game_points = []
    last_count = 0

    while True:
        display = frame.copy()
        for (px, py) in clicked_points:
            cv2.circle(display, (px, py), 4, (0, 0, 255), -1)
        cv2.imshow(window, display)
        key = cv2.waitKey(50) & 0xFF

        if len(clicked_points) > last_count:
            px, py = clicked_points[-1]
            gx = float(input(f"  Point {len(clicked_points)} pixel=({px},{py}) "
                              f"-> enter real in-game X: "))
            gy = float(input(f"  Point {len(clicked_points)} pixel=({px},{py}) "
                              f"-> enter real in-game Y: "))
            game_points.append((gx, gy))
            last_count = len(clicked_points)

        if key == 27:  # ESC
            break

    cv2.destroyAllWindows()

    if len(clicked_points) < 3:
        print("Need at least 3 points. Run again.")
        sys.exit(1)

    transform = CoordinateTransform.fit(clicked_points, game_points)
    transform.save("calibration.json")
    print(f"Saved calibration.json using {len(clicked_points)} points.")

    # Sanity check: re-project each pixel point and show the error
    print("\nCalibration check (should be close to your entered values):")
    for (px, py), (gx, gy) in zip(clicked_points, game_points):
        est_x, est_y = transform.pixel_to_game(px, py)
        print(f"  pixel=({px},{py})  entered=({gx:.1f},{gy:.1f})  "
              f"estimated=({est_x:.1f},{est_y:.1f})")


if __name__ == "__main__":
    main()
