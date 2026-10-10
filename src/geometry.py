"""
Converts pixel coordinates (from the captured minimap image) into
in-game/world coordinates, using a calibration built from >=3 known
pixel <-> game coordinate point pairs.

This assumes the minimap is a fixed-scale, non-rotating (north-up) map.
If PTFS's minimap rotates with your heading, this transform alone isn't
enough — you'd also need your live heading to "un-rotate" each frame
before applying it. Flag that and we can extend this.
"""

import json
import numpy as np


class CoordinateTransform:
    def __init__(self, matrix: np.ndarray):
        # matrix is a 2x3 affine transform: [game_x, game_y] = M @ [px, py, 1]
        self.matrix = matrix

    @classmethod
    def fit(cls, pixel_points, game_points):
        """
        pixel_points: list of (px, py)
        game_points:  list of (gx, gy) — the real in-game coords for each point
        Requires at least 3 non-collinear point pairs. More points = more
        accurate (least-squares) fit, especially if your clicks are a bit off.
        """
        if len(pixel_points) < 3:
            raise ValueError("Need at least 3 calibration points")

        # Build the linear system for an affine fit: solve for M in
        # [gx, gy] = M @ [px, py, 1] for every point, via least squares.
        A = []
        bx = []
        by = []
        for (px, py), (gx, gy) in zip(pixel_points, game_points):
            A.append([px, py, 1])
            bx.append(gx)
            by.append(gy)
        A = np.array(A)
        bx = np.array(bx)
        by = np.array(by)

        row_x, _, _, _ = np.linalg.lstsq(A, bx, rcond=None)
        row_y, _, _, _ = np.linalg.lstsq(A, by, rcond=None)
        matrix = np.vstack([row_x, row_y])  # shape (2, 3)
        return cls(matrix)

    def pixel_to_game(self, px, py):
        vec = np.array([px, py, 1.0])
        gx, gy = self.matrix @ vec
        return float(gx), float(gy)

    def save(self, path):
        with open(path, "w") as f:
            json.dump({"matrix": self.matrix.tolist()}, f)

    @classmethod
    def load(cls, path):
        with open(path) as f:
            data = json.load(f)
        return cls(np.array(data["matrix"]))
