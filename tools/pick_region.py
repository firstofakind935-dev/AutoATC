"""
Pick your minimap box by dragging it, and check the marker can be seen in it.

1. Put the game on screen with the minimap visible (borderless/windowed, not exclusive fullscreen).
2. From the repo root, with the venv active:   python tools\\pick_region.py
3. A screenshot of your whole screen opens: drag a box around the MINIMAP only, press ENTER (or SPACE).
4. It prints the MINIMAP_REGION to paste into src\\config.py, saves region_check.png (what the tracker
   will see), and says how many bright-green marker pixels it found and what colour they are.
Press C (or close the window) to cancel.
"""

import sys

import cv2
import mss
import numpy as np

MARKER_RGB = (161, 233, 93)  # the default marker colour in the config


def main():
    with mss.mss() as sct:
        monitor = sct.monitors[1]  # primary screen
        shot = np.array(sct.grab(monitor))
    full = cv2.cvtColor(shot, cv2.COLOR_BGRA2BGR)

    # Fit the screenshot on the screen for picking, then scale the box back up.
    scale = min(1.0, 1500 / full.shape[1], 850 / full.shape[0])
    shown = cv2.resize(full, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else full
    x, y, w, h = cv2.selectROI("Drag a box around the MINIMAP, then press ENTER", shown, showCrosshair=False)
    cv2.destroyAllWindows()
    if w == 0 or h == 0:
        print("Cancelled.")
        sys.exit(1)

    left, top, width, height = (int(round(v / scale)) for v in (x, y, w, h))
    crop = full[top:top + height, left:left + width]
    cv2.imwrite("region_check.png", crop)

    print("\nPaste this into src\\config.py (replace the MINIMAP_REGION block):\n")
    print("MINIMAP_REGION = {")
    print(f'    "left": {left + monitor["left"]},')
    print(f'    "top": {top + monitor["top"]},')
    print(f'    "width": {width},')
    print(f'    "height": {height},')
    print("}\n")
    print(f"Screen is {full.shape[1]}x{full.shape[0]}; saved region_check.png ({width}x{height}) - open it to see what the tracker sees.")

    # Is the marker visible in there?
    b, g, r = (crop[..., i].astype(int) for i in range(3))
    bright_green = (g >= 170) & (g - r >= 40) & (g - b >= 70)
    count = int(bright_green.sum())
    if count == 0:
        print("\nNo bright-green marker pixels in this box. Is your aircraft marker inside it, and is the map showing?")
        return
    colour = tuple(int(v) for v in np.median(crop[bright_green][:, ::-1], axis=0))
    print(f"\nFound {count} bright-green pixels. Their typical colour is RGB {colour}.")
    if max(abs(colour[i] - MARKER_RGB[i]) for i in range(3)) > 40:
        print(f"That is not close to the config's MARKER_COLOR_RGB {MARKER_RGB}. Set:")
        print(f"MARKER_COLOR_RGB = {colour}")
    else:
        print("That matches the config's marker colour - good.")


if __name__ == "__main__":
    main()
