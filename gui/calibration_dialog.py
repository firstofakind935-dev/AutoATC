"""
In-app replacement for the old terminal-based calibrate.py.

Click a point on the captured minimap image, a small popup asks for that
point's real in-game X and Y, and a marker is drawn on the image so you can
see what you've already covered. Once you have 3+ points spread across the
map, click "Save calibration" to write calibration.json.
"""

import os
import sys

import mss
from PyQt6.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QLabel, QPushButton,
    QInputDialog, QMessageBox,
)
from PyQt6.QtGui import QImage, QPixmap, QPainter, QPen, QColor
from PyQt6.QtCore import Qt, QPoint

SRC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"
)
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

import config  # noqa: E402
from geometry import CoordinateTransform  # noqa: E402

CALIBRATION_PATH = os.path.join(SRC_DIR, "calibration.json")


class ClickableImageLabel(QLabel):
    def __init__(self, dialog):
        super().__init__()
        self.dialog = dialog
        self.setCursor(Qt.CursorShape.CrossCursor)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            pos = event.position().toPoint()
            self.dialog.handle_click(pos.x(), pos.y())


class CalibrationDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Calibrate minimap")
        self.pixel_points = []
        self.game_points = []
        self.base_pixmap = None

        layout = QVBoxLayout(self)

        instructions = QLabel(
            "Click a point on the minimap below where you know the real "
            "in-game coordinates, then enter them when asked. Repeat for "
            "at least 3 points spread across different areas of the map, "
            "then click Save."
        )
        instructions.setWordWrap(True)
        layout.addWidget(instructions)

        self.image_label = ClickableImageLabel(self)
        layout.addWidget(self.image_label)

        self.points_label = QLabel("Points collected: 0")
        layout.addWidget(self.points_label)

        btn_row = QHBoxLayout()

        self.recapture_btn = QPushButton("Recapture")
        self.recapture_btn.clicked.connect(self.recapture)
        btn_row.addWidget(self.recapture_btn)

        self.undo_btn = QPushButton("Undo last point")
        self.undo_btn.clicked.connect(self.undo_point)
        btn_row.addWidget(self.undo_btn)

        btn_row.addStretch(1)

        cancel_btn = QPushButton("Cancel")
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        self.save_btn = QPushButton("Save calibration")
        self.save_btn.setObjectName("connectButton")
        self.save_btn.clicked.connect(self.save_calibration)
        btn_row.addWidget(self.save_btn)

        layout.addLayout(btn_row)

        self.recapture()

    def recapture(self):
        """Grabs a fresh screenshot of config.MINIMAP_REGION and resets points."""
        with mss.mss() as sct:
            shot = sct.grab(config.MINIMAP_REGION)
        # mss returns BGRA bytes; Format_RGB32 expects that same byte order
        # in memory (0xffRRGGBB little-endian == B,G,R,0xff per pixel).
        image = QImage(shot.bgra, shot.width, shot.height, QImage.Format.Format_RGB32)
        self.base_pixmap = QPixmap.fromImage(image.copy())
        self.pixel_points = []
        self.game_points = []
        self.points_label.setText("Points collected: 0")
        self._redraw()

    def _redraw(self):
        pixmap = self.base_pixmap.copy()
        painter = QPainter(pixmap)
        pen = QPen(QColor(255, 60, 60))
        pen.setWidth(3)
        painter.setPen(pen)
        for i, (px, py) in enumerate(self.pixel_points):
            painter.drawEllipse(QPoint(int(px), int(py)), 4, 4)
            painter.drawText(int(px) + 6, int(py) - 6, str(i + 1))
        painter.end()
        self.image_label.setPixmap(pixmap)

    def handle_click(self, x, y):
        gx, ok1 = QInputDialog.getDouble(
            self, "Point coordinates",
            f"Point {len(self.pixel_points) + 1} — real in-game X:",
            decimals=2,
        )
        if not ok1:
            return
        gy, ok2 = QInputDialog.getDouble(
            self, "Point coordinates",
            f"Point {len(self.pixel_points) + 1} — real in-game Y:",
            decimals=2,
        )
        if not ok2:
            return

        self.pixel_points.append((x, y))
        self.game_points.append((gx, gy))
        self.points_label.setText(f"Points collected: {len(self.pixel_points)}")
        self._redraw()

    def undo_point(self):
        if self.pixel_points:
            self.pixel_points.pop()
            self.game_points.pop()
            self.points_label.setText(f"Points collected: {len(self.pixel_points)}")
            self._redraw()

    def save_calibration(self):
        if len(self.pixel_points) < 3:
            QMessageBox.warning(
                self, "Not enough points",
                "Click at least 3 points (spread across the map) before saving."
            )
            return

        transform = CoordinateTransform.fit(self.pixel_points, self.game_points)
        transform.save(CALIBRATION_PATH)
        QMessageBox.information(
            self, "Calibration saved",
            f"Saved calibration.json using {len(self.pixel_points)} points."
        )
        self.accept()
