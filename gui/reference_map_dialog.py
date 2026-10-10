"""
One-time setup, replacing the old point-by-point calibration entirely.

Open PTFS's expandable full map view, zoomed out to show the whole play
area, then run this. It grabs a full screenshot, you drag a rectangle
around just the map content, and that crop gets saved as the reference
image that map_locator.py matches the live minimap against forever after.
"""

import os
import sys

import mss
import numpy as np
import cv2
from PyQt6.QtWidgets import QDialog, QVBoxLayout, QLabel, QPushButton, QHBoxLayout, QMessageBox
from PyQt6.QtGui import QImage, QPixmap, QPainter, QPen, QColor
from PyQt6.QtCore import Qt, QRect, QPoint

SRC_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"
)
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

import app_config  # noqa: E402

REFERENCE_MAP_PATH = str(app_config.REFERENCE_MAP_PATH)

MAX_DISPLAY_WIDTH = 1100
MAX_DISPLAY_HEIGHT = 700


class DragSelectLabel(QLabel):
    def __init__(self, dialog):
        super().__init__()
        self.dialog = dialog
        self.setCursor(Qt.CursorShape.CrossCursor)
        self.dragging = False
        self.start_pos = QPoint()
        self.end_pos = QPoint()

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.dragging = True
            self.start_pos = event.position().toPoint()
            self.end_pos = self.start_pos

    def mouseMoveEvent(self, event):
        if self.dragging:
            self.end_pos = event.position().toPoint()
            self.dialog.update_selection(self.start_pos, self.end_pos)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton and self.dragging:
            self.dragging = False
            self.end_pos = event.position().toPoint()
            self.dialog.finalize_selection(self.start_pos, self.end_pos)


class ReferenceMapDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Set reference map")
        self.resize(1150, 800)

        self.native_image = None   # full-resolution numpy BGR array
        self.scale = 1.0           # display size / native size
        self.selection_native = None  # QRect in native image coordinates

        layout = QVBoxLayout(self)

        instructions = QLabel(
            "Make sure PTFS's expandable map is open and zoomed to show the "
            "whole play area, then click Recapture. Drag a rectangle around "
            "just the map content (avoid buttons/UI chrome), then Save."
        )
        instructions.setWordWrap(True)
        layout.addWidget(instructions)

        self.image_label = DragSelectLabel(self)
        layout.addWidget(self.image_label)

        btn_row = QHBoxLayout()
        self.recapture_btn = QPushButton("Recapture full screen")
        self.recapture_btn.clicked.connect(self.recapture)
        btn_row.addWidget(self.recapture_btn)

        btn_row.addStretch(1)

        cancel_btn = QPushButton("Cancel")
        cancel_btn.clicked.connect(self.reject)
        btn_row.addWidget(cancel_btn)

        self.save_btn = QPushButton("Save reference map")
        self.save_btn.setObjectName("connectButton")
        self.save_btn.clicked.connect(self.save_reference)
        self.save_btn.setEnabled(False)
        btn_row.addWidget(self.save_btn)

        layout.addLayout(btn_row)

        self.recapture()

    def recapture(self):
        with mss.mss() as sct:
            shot = sct.grab(sct.monitors[1])  # primary monitor
        img = np.array(shot)  # BGRA
        self.native_image = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
        self.selection_native = None
        self.save_btn.setEnabled(False)
        self._render_base()

    def _render_base(self):
        h, w = self.native_image.shape[:2]
        self.scale = min(MAX_DISPLAY_WIDTH / w, MAX_DISPLAY_HEIGHT / h, 1.0)
        disp_w, disp_h = int(w * self.scale), int(h * self.scale)

        display_bgr = cv2.resize(self.native_image, (disp_w, disp_h))
        rgb = cv2.cvtColor(display_bgr, cv2.COLOR_BGR2RGB)
        qimage = QImage(rgb.data, disp_w, disp_h, rgb.strides[0], QImage.Format.Format_RGB888)
        self.base_pixmap = QPixmap.fromImage(qimage.copy())
        self.image_label.setPixmap(self.base_pixmap)
        self.image_label.setFixedSize(disp_w, disp_h)

    def update_selection(self, start: QPoint, end: QPoint):
        pixmap = self.base_pixmap.copy()
        painter = QPainter(pixmap)
        pen = QPen(QColor(79, 176, 227))
        pen.setWidth(2)
        painter.setPen(pen)
        painter.drawRect(QRect(start, end))
        painter.end()
        self.image_label.setPixmap(pixmap)

    def finalize_selection(self, start: QPoint, end: QPoint):
        x1, y1 = min(start.x(), end.x()), min(start.y(), end.y())
        x2, y2 = max(start.x(), end.x()), max(start.y(), end.y())

        if x2 - x1 < 20 or y2 - y1 < 20:
            self.save_btn.setEnabled(False)
            return

        # Convert display coords back to native image coords
        nx1, ny1 = int(x1 / self.scale), int(y1 / self.scale)
        nx2, ny2 = int(x2 / self.scale), int(y2 / self.scale)
        self.selection_native = (nx1, ny1, nx2, ny2)
        self.save_btn.setEnabled(True)

    def save_reference(self):
        if self.selection_native is None:
            return
        x1, y1, x2, y2 = self.selection_native
        crop = self.native_image[y1:y2, x1:x2]
        os.makedirs(os.path.dirname(REFERENCE_MAP_PATH), exist_ok=True)
        cv2.imwrite(REFERENCE_MAP_PATH, crop)
        QMessageBox.information(
            self, "Reference map saved",
            f"Saved {(x2 - x1)}x{(y2 - y1)} reference map to:\n{REFERENCE_MAP_PATH}"
        )
        self.accept()
