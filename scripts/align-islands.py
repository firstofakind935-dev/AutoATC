#!/usr/bin/env python3
"""Moves each island in 365Radar's world-map.png to where 24SPY draws it.

365Radar's world map is a screenshot of the PTFS world; 24SPY's tiles show the
same islands, but not at exactly the same places relative to its airports and
waypoints. The radar now uses 24SPY's airport/waypoint positions, so this
lines the island art up with them: for every island it finds the small shift
(+ slight scale/rotation) that best overlays its outline on the matching
outline in 24SPY's tiles, then redraws the map with the island moved.
Labels stay where they are.

Needs: pip install opencv-python-headless numpy pillow
Usage: python3 scripts/align-islands.py [path-to-24SPY-clone]
Reads  monitor/public/365radar/public/assets/world-map-original.png
       (a one-time copy of the unmodified map; created on first run)
Writes monitor/public/365radar/public/assets/world-map.png
24SPY is (c) Tiago Murteira (tiaguinho_2009), non-commercial licence, used
with permission; this output is a modified derivative of its map positions.
"""
import json, os, shutil, sys
import cv2, numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ASSETS = os.path.join(ROOT, 'monitor/public/365radar/public/assets')
TILES = os.path.join(ROOT, 'monitor/public/radar/tiles/tilesOP')  # the most detailed set: the coarser ones leave Grindavik out
PAIRS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'island-fit-pairs.json')
SPY_PX = 7 / 3  # working resolution: pixels per 24SPY map unit (each 560 px tile = 240 units)

orig = os.path.join(ASSETS, 'world-map-original.png')
if not os.path.exists(orig):
    shutil.copy(os.path.join(ASSETS, 'world-map.png'), orig)
wm = cv2.imread(orig)

# 24SPY land mask (1200x1200 units; background tile value is 19)
N_TILE = 560
spy = np.zeros((5 * N_TILE,) * 2, np.uint8)
n = N_TILE
for i in range(1, 26):
    c, r = (i - 1) // 5, (i - 1) % 5
    t = np.array(Image.open(os.path.join(TILES, f'{i}.png')).convert('L'))
    spy[r * n:(r + 1) * n, c * n:(c + 1) * n] = cv2.resize(t, (n, n), interpolation=cv2.INTER_AREA)
spy_land = (spy != 19).astype(np.uint8) * 255
spy_land = cv2.morphologyEx(spy_land, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

# Islands the clone's tiles leave out (Grindavik) come from outlines traced off
# 24SPY's own screen and registered to its waypoints: scripts/island-masks/*.json
MASKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'island-masks')
for name in sorted(os.listdir(MASKS)):
    if not name.endswith('.json'): continue
    meta = json.load(open(os.path.join(MASKS, name)))
    m = cv2.imread(os.path.join(MASKS, meta['file']), 0)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled = np.zeros_like(m); cv2.drawContours(filled, cnts, -1, 255, -1)   # fill the airfield hole
    k = SPY_PX / meta['pxPerUnit']
    ox, oy = meta['originUnits']
    A = np.float32([[k, 0, ox * SPY_PX], [0, k, oy * SPY_PX]])
    spy_land = np.maximum(spy_land, cv2.warpAffine(filled, A, spy_land.shape[::-1], flags=cv2.INTER_AREA))

# world-map land mask (ocean colour removed, yellow labels removed)
ocean = np.median(wm[:40, :40].reshape(-1, 3), axis=0)
diff = np.abs(wm.astype(int) - ocean).sum(2)
b, g, r_ = wm[:, :, 0].astype(int), wm[:, :, 1].astype(int), wm[:, :, 2].astype(int)
yellow = (r_ > 190) & (g > 140) & (b < 120)
solid = cv2.morphologyEx(yellow.astype(np.uint8), cv2.MORPH_OPEN, np.ones((9, 9), np.uint8)) > 0   # text strokes are thin
label = yellow & ~(cv2.dilate(solid.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0)
land = ((diff > 40) & ~label).astype(np.uint8) * 255
# labels have a dark outline too: treat the whole label (plus margin) as not-island
label_zone = cv2.dilate(label.astype(np.uint8), np.ones((11, 11), np.uint8)) > 0
land[label_zone] = 0
land = cv2.morphologyEx(land, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))

# global similarity: 24SPY units -> world-map px (1874 wide), from shared airports
pairs = json.load(open(PAIRS))
src = np.float32([p['spy'] for p in pairs])
# G: 24SPY units -> the NEW image's pixels (north-up; same positions import-24spy.js writes)
G = cv2.estimateAffinePartial2D(src, np.float32([p['newWm'] for p in pairs]) * 2, method=cv2.LMEDS)[0]
def h(m): return np.vstack([m, [0, 0, 1]])
S = np.diag([SPY_PX, SPY_PX, 1.0])
W2S = (S @ h(cv2.invertAffineTransform(G)))[:2]          # old image px -> spy px (the image itself is north-up)

# islands = connected blobs of land, merged with a generous dilation
blobs = cv2.dilate(land, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41)))
count, labels, stats, _ = cv2.connectedComponentsWithStats(blobs)
spy_blur = cv2.GaussianBlur(spy_land, (0, 0), 6).astype(np.float32) / 255

out = np.empty_like(wm); out[:] = ocean.astype(np.uint8)
# keep labels: copy label pixels from the original into the background
out[label_zone] = wm[label_zone]
report = []
for k in range(1, count):
    if stats[k, cv2.CC_STAT_AREA] < 600: continue
    mask = ((labels == k) & (land > 0)).astype(np.uint8) * 255
    if mask.sum() / 255 < 150: continue
    m_spy = cv2.warpAffine(mask, W2S, spy_land.shape[::-1], flags=cv2.INTER_AREA)
    m_blur = cv2.GaussianBlur(m_spy, (0, 0), 6).astype(np.float32) / 255
    ys, xs = np.nonzero(m_spy > 127)
    if len(xs) < 50:
        report.append((k, None, 'too small')); continue
    SEARCH = 80  # how far (spy px) an island may be from where the global fit puts it
    x0, x1, y0, y1 = xs.min() - 12, xs.max() + 13, ys.min() - 12, ys.max() + 13
    x0, y0 = max(x0, 0), max(y0, 0)
    tpl = m_blur[y0:y1, x0:x1]
    ax0, ay0 = max(x0 - SEARCH, 0), max(y0 - SEARCH, 0)
    area = spy_blur[ay0:y1 + SEARCH, ax0:x1 + SEARCH]
    res = cv2.matchTemplate(area, tpl, cv2.TM_CCOEFF_NORMED)
    _, peak, _, loc = cv2.minMaxLoc(res)
    dx, dy = ax0 + loc[0] - x0, ay0 + loc[1] - y0              # island must move by this in spy px
    if peak < 0.5:
        report.append((k, peak, f'at ({int(stats[k,0])},{int(stats[k,1])}) no confident match in 24SPY - left where it was')); new = None
    else:
        M = h(np.float32([[1, 0, dx], [0, 1, dy]]))               # move only; the island art is not rotated
        new = (h(G) @ np.diag([1 / SPY_PX, 1 / SPY_PX, 1.0]) @ M @ h(W2S))[:2]  # old world px -> new world px
        cx, cy = np.nonzero(mask)[1].mean(), np.nonzero(mask)[0].mean()
        nx, ny = new @ [cx, cy, 1]
        shift_nm = float(np.hypot(nx - cx, ny - cy) / 48)
        if shift_nm > 3:
            report.append((k, peak, f'implausible shift {shift_nm:.1f} nm - left where it was')); new = None
        else:
            report.append((k, peak, f'at ({int(stats[k,0])},{int(stats[k,1])}) moved {shift_nm:.2f} nm'))
    if new is None: new = np.eye(2, 3)
    # exactly the island (a hair of margin for the coast), never the yellow labels beside it
    grown = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    grown[label_zone] = 0
    patch = cv2.warpAffine(np.where(grown[..., None] > 0, wm, 0).astype(np.uint8), new, wm.shape[1::-1], flags=cv2.INTER_CUBIC)
    alpha = cv2.warpAffine(grown, new, wm.shape[1::-1], flags=cv2.INTER_LINEAR)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1)[..., None].astype(np.float32) / 255
    out = (out * (1 - alpha) + patch * alpha).astype(np.uint8)

cv2.imwrite(os.path.join(ASSETS, 'world-map.png'), out)

# For the /radar fork: islands the 24SPY tiles lack, as transparent pictures
# placed in 24SPY map units (see monitor/public/radar/assets/autoatc.js).
ISLAND_OUT = os.path.join(ROOT, 'monitor/public/radar/islands')
os.makedirs(ISLAND_OUT, exist_ok=True)
index = []
for name in sorted(os.listdir(MASKS)):
    if not name.endswith('.json'): continue
    meta = json.load(open(os.path.join(MASKS, name)))
    m = cv2.imread(os.path.join(MASKS, meta['file']), 0)
    ppu = meta['pxPerUnit']; ox, oy = meta['originUnits']
    dst_size = (m.shape[1], m.shape[0])
    k = ppu
    # dest px -> units -> new world px
    T = np.float64([[1 / k, 0, ox], [0, 1 / k, oy], [0, 0, 1]])
    to_src = (h(G) @ T)[:2]
    pic = cv2.warpAffine(out, to_src, dst_size, flags=cv2.INTER_AREA | cv2.WARP_INVERSE_MAP)
    dd = np.abs(pic.astype(int) - ocean).sum(2)
    alpha = np.clip((dd - 70) * 6, 0, 255).astype(np.uint8)
    alpha = cv2.erode(alpha, np.ones((3, 3), np.uint8))
    alpha = cv2.GaussianBlur(alpha, (0, 0), 1)
    rgba = np.dstack([pic, alpha])
    cv2.imwrite(os.path.join(ISLAND_OUT, meta['file']), rgba)
    index.append({'file': meta['file'], 'originUnits': meta['originUnits'], 'unitsWide': dst_size[0] / k, 'unitsHigh': dst_size[1] / k})
json.dump(index, open(os.path.join(ISLAND_OUT, 'index.json'), 'w'), indent=1)
for k, cc, msg in report: print(f'island {k}: corr={cc if cc is None else round(float(cc), 2)} {msg}')
