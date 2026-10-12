#!/usr/bin/env python3
"""
Writes data/featureRefs/: the reference pictures the companion matches the minimap against by FEATURES
(companion/lib/featureLocator.js) - the same ones the tracker (test-pim-vpilot) uses:
  world.gray.gz   the radar's world map (monitor/public/365radar/public/assets/world-map.png, 48 px per nm)
  <ICAO>.gray.gz  airport tiles: the game's own big map zoomed in on one airport, lined up with the world map
                  (made with the tracker's tools/capture_tile.py; read from --tiles, default the tracker's src/tiles)
  index.json      sizes and each tile's 2x3 transform tile px -> world-map px
Greyscale, raw bytes, gzip - so the companion needs no image decoder.

Usage: python3 scripts/build-feature-refs.py [--tiles path/to/tracker/src/tiles]
"""
import argparse, gzip, json, os
import cv2

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
OUT = os.path.join(ROOT, 'data', 'featureRefs')
ap = argparse.ArgumentParser()
ap.add_argument('--tiles', default=None)
args = ap.parse_args()
os.makedirs(OUT, exist_ok=True)

def write(name, gray):
    with gzip.open(os.path.join(OUT, f'{name}.gray.gz'), 'wb', compresslevel=9) as f:
        f.write(gray.tobytes())
    return {'width': int(gray.shape[1]), 'height': int(gray.shape[0])}

world = cv2.imread(os.path.join(ROOT, 'monitor/public/365radar/public/assets/world-map.png'), cv2.IMREAD_GRAYSCALE)
index = {'note': 'Built by scripts/build-feature-refs.py. world: px -> nm is / pxPerNm. tiles: toWorld maps tile px to world px.',
         'world': {**write('world', world), 'pxPerNm': 48}, 'tiles': {}}
if args.tiles and os.path.isdir(args.tiles):
    for name in sorted(os.listdir(args.tiles)):
        if not name.endswith('.json'):
            continue
        icao = name[:-5]
        img = cv2.imread(os.path.join(args.tiles, icao + '.png'), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        meta = json.load(open(os.path.join(args.tiles, name)))
        index['tiles'][icao] = {**write(icao, img), 'toWorld': meta['toWorld']}
json.dump(index, open(os.path.join(OUT, 'index.json'), 'w'), indent=1)
print(f"world {index['world']['width']}x{index['world']['height']}, tiles: {', '.join(index['tiles']) or 'none'}")
