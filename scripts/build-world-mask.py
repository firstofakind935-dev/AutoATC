#!/usr/bin/env python3
"""Builds data/worldMask.json (land/water mask of the radar's world map) for the companion's map fix.
Needs opencv-python and numpy. Run from the repo root: python3 scripts/build-world-mask.py"""
import base64, json
import cv2
import numpy as np

w = cv2.imread('monitor/public/365radar/public/assets/world-map.png')
b, g, r = [w[..., i].astype(int) for i in range(3)]
water = (abs(r - 59) < 18) & (abs(g - 90) < 18) & (abs(b - 125) < 22)
yellow = (r > 170) & (g > 130) & (b < 110) & (r - b > 80)  # map labels
white = (r > 185) & (g > 185) & (b > 185) & (np.maximum(np.maximum(r, g), b) - np.minimum(np.minimum(r, g), b) < 40)  # track lines
m = (~(water | yellow | white)).astype(np.float32)
m = cv2.resize(m, (937, 706), interpolation=cv2.INTER_AREA) > 0.5
bits = np.packbits(m.reshape(-1))
json.dump({'note': 'Land (1) / water (0) mask of the radar world map at 937x706; 24 px per nm. Row-major, MSB first, base64. Built by scripts/build-world-mask.py.',
           'width': 937, 'height': 706, 'pxPerNm': 24, 'bits': base64.b64encode(bits.tobytes()).decode()}, open('data/worldMask.json', 'w'))
