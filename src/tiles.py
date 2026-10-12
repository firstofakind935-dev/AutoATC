"""
High-detail reference tiles (one per airport, from the game's own big map zoomed in).

The shipped world map is only 48 px per nm - an airport is ~50 px across, too little detail to match a minimap on, and
on an apron there is no coastline either. A tile is a screenshot of the game's big map zoomed in on one airport, lined
up once with the world map (tools/capture_tile.py) - so it carries its own transform from tile pixels to world-map
pixels. The minimap is matched on the tile's features (runways, taxiways, buildings), which is precise to a few metres,
and the result is carried to the world map through the tile's transform.

Files: src/tiles/<NAME>.png + src/tiles/<NAME>.json  {"toWorld": [[a, b, tx], [c, d, ty]], "score": 0.85}
"""

import json
import math
from pathlib import Path

import cv2
import numpy as np

TILES_DIR = Path(__file__).resolve().parent / "tiles"


class Tile:
    def __init__(self, name, image_bgr, to_world):
        self.name = name
        self.to_world = np.float64(to_world)  # 2x3: tile pixel -> world-map pixel
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        self.size = (gray.shape[1], gray.shape[0])
        orb = cv2.ORB_create(nfeatures=8000, scaleFactor=1.2, nlevels=8)
        self.kp, self.desc = orb.detectAndCompute(gray, None)
        # where the tile's middle sits on the world map, to try the nearest tile first
        self.center_world = self.to_world @ np.array([self.size[0] / 2, self.size[1] / 2, 1.0])


def load_tiles(directory=TILES_DIR):
    tiles = []
    if not Path(directory).exists():
        return tiles
    for meta_path in sorted(Path(directory).glob("*.json")):
        img = cv2.imread(str(meta_path.with_suffix(".png")), cv2.IMREAD_COLOR)
        if img is None:
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        tiles.append(Tile(meta_path.stem, img, meta["toWorld"]))
    return tiles


def compose(outer, inner):
    """2x3 affine `outer` after 2x3 affine `inner`."""
    o = np.vstack([outer, [0, 0, 1]])
    i = np.vstack([inner, [0, 0, 1]])
    return (o @ i)[:2]


def tiles_nearest_first(tiles, near_world_px):
    if near_world_px is None:
        return list(tiles)
    return sorted(tiles, key=lambda t: math.hypot(t.center_world[0] - near_world_px[0], t.center_world[1] - near_world_px[1]))
