"""
Make a high-detail airport tile from the game's big map (see src/tiles.py for why).

1. In the game, open the big map and zoom in on ONE airport so the whole airport and some coastline are on screen.
2. From the repo root, with the venv active:
       python tools\\capture_tile.py IRFD                 (takes a screenshot now, after a 3 s countdown)
       python tools\\capture_tile.py IRFD shot.png        (or uses a screenshot you already have)
3. Drag a box around the map picture only (no buttons), press ENTER.
4. It lines the picture up with the radar world map and saves src\\tiles\\IRFD.png + IRFD.json. The tracker uses it
   from the next Connect. It refuses a picture it can't line up confidently.
"""

import json
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from map_locator import MapLocator  # noqa: E402
import monitor_client  # noqa: E402

MIN_SCORE = 0.6


def grab_screen():
    import mss
    for i in (3, 2, 1):
        print(f"Screenshot in {i}... (switch to the game with the big map open)")
        time.sleep(1)
    with mss.mss() as sct:
        return cv2.cvtColor(np.array(sct.grab(sct.monitors[1])), cv2.COLOR_BGRA2BGR)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    name = sys.argv[1].upper()
    img = cv2.imread(sys.argv[2]) if len(sys.argv) > 2 else grab_screen()
    if img is None:
        print("Could not read the image.")
        sys.exit(1)

    if "--whole" not in sys.argv:
        scale = min(1.0, 1500 / img.shape[1], 850 / img.shape[0])
        shown = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else img
        x, y, w, h = cv2.selectROI("Drag a box around the MAP picture only, then ENTER", shown, showCrosshair=False)
        cv2.destroyAllWindows()
        if w == 0 or h == 0:
            print("Cancelled.")
            sys.exit(1)
        x, y, w, h = (int(round(v / scale)) for v in (x, y, w, h))
        img = img[y:y + h, x:x + w]

    loc = MapLocator(str(ROOT / "src" / "reference_map.png"), use_tiles=False)
    result = loc.locate_crop(img)
    if result is None or result[3] < MIN_SCORE:
        why = loc.last_reason or (f"match only {result[3] * 100:.0f}%" if result else "no match")
        print(f"Could not line this picture up with the world map ({why}). Zoom out a little so some coastline shows, and retry.")
        sys.exit(1)
    M = loc.last_transform
    cx, cy = M @ np.array([img.shape[1] / 2, img.shape[0] / 2, 1.0])
    icao, dist, brg = monitor_client.nearest_airport(monitor_client.load_airports(), cx / 48.0, cy / 48.0)
    out = ROOT / "src" / "tiles"
    out.mkdir(exist_ok=True)
    cv2.imwrite(str(out / f"{name}.png"), img)
    (out / f"{name}.json").write_text(json.dumps({
        "toWorld": M.tolist(),
        "score": round(float(result[3]), 3),
        "method": loc.last_method,
        "sizePx": [img.shape[1], img.shape[0]],
        "centerNearest": f"{dist:.2f} nm brg {brg:.0f} from {icao}",
    }, indent=1) + "\n", encoding="utf-8")
    print(f"Saved src/tiles/{name}.png ({img.shape[1]}x{img.shape[0]}): lined up {result[3] * 100:.0f}% "
          f"({loc.last_method}), centre {dist:.2f} nm from {icao}. {1 / np.sqrt(abs(np.linalg.det(M[:, :2]))) * 48:.0f} px per nm.")


if __name__ == "__main__":
    main()
