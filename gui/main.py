"""
Main GUI shell for the PTFS tracker, styled after vPilot's layout.
"""

import sys
import os
from datetime import datetime

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QLabel, QListWidget, QListWidgetItem, QTabWidget,
    QTextEdit, QFrame, QSizePolicy, QLineEdit,
)
from PyQt6.QtCore import Qt
from PyQt6.QtGui import QFont, QIcon

from updater import check_for_update, CURRENT_VERSION, apply_pending_update_and_maybe_restart
from backend_worker import TrackerWorker, WebhookEventWorker
from reference_map_dialog import ReferenceMapDialog

APP_TITLE = f"PTFS Tracker v{CURRENT_VERSION}"

DEFAULT_POSITIONS = [
    "Center",
    "Approach/Departure",
    "Tower",
    "Ground",
    "Ramp",
    "Clearance Delivery",
    "ATIS",
    "Observers",
]


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_TITLE)
        self.resize(880, 420)
        self.connected = False
        self.worker = None
        self.webhook_event_workers = []

        self._build_ui()
        self._log(f"PTFS Tracker version {CURRENT_VERSION}")
        from backend_worker import config
        if not config.DISCORD_WEBHOOK_URL:
            self._log(
                "Discord is not configured. Add your webhook URL to "
                f"{config.SETTINGS_PATH} and restart the app."
            )

        self._check_updates_on_startup()

    # ---------- UI construction ----------

    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(8)

        root.addLayout(self._build_top_bar())
        root.addLayout(self._build_body(), stretch=1)

    def _build_top_bar(self):
        bar = QHBoxLayout()

        self.connect_btn = QPushButton("Connect")
        self.connect_btn.setObjectName("connectButton")
        self.connect_btn.setCheckable(True)
        self.connect_btn.clicked.connect(self.connect_toggled)
        bar.addWidget(self.connect_btn)

        self.disconnect_btn = QPushButton("X")
        self.disconnect_btn.setObjectName("disconnectButton")
        self.disconnect_btn.clicked.connect(self.force_disconnect)
        bar.addWidget(self.disconnect_btn)

        bar.addSpacing(12)

        self.calibrate_btn = QPushButton("Set Reference Map")
        self.calibrate_btn.clicked.connect(self.open_reference_map_setup)
        bar.addWidget(self.calibrate_btn)

        bar.addSpacing(12)

        self.callsign_input = QLineEdit()
        self.callsign_input.setPlaceholderText("Callsign")
        self.callsign_input.setFixedWidth(110)
        self.callsign_input.setMaxLength(12)
        bar.addWidget(self.callsign_input)

        self.aircraft_input = QLineEdit()
        self.aircraft_input.setPlaceholderText("Aircraft ICAO (e.g. B738)")
        self.aircraft_input.setFixedWidth(150)
        self.aircraft_input.setMaxLength(10)
        bar.addWidget(self.aircraft_input)

        bar.addSpacing(12)

        self.status_label = QLabel("Not connected")
        self.status_label.setObjectName("statusLabel")
        self.status_label.setProperty("state", "idle")
        bar.addWidget(self.status_label)

        bar.addStretch(1)

        freq_label = QLabel("POSITION:")
        bar.addWidget(freq_label)
        self.freq_value = QLabel("---.---")
        self.freq_value.setObjectName("freqLabel")
        bar.addWidget(self.freq_value)

        return bar

    def _build_body(self):
        body = QHBoxLayout()

        left = QVBoxLayout()
        left_title = QLabel("Controllers In Range:")
        left.addWidget(left_title)

        self.positions_list = QListWidget()
        self.positions_list.setObjectName("positionsList")
        for name in DEFAULT_POSITIONS:
            item = QListWidgetItem(name)
            self.positions_list.addItem(item)
        left.addWidget(self.positions_list)

        left_container = QWidget()
        left_container.setLayout(left)
        left_container.setFixedWidth(220)
        body.addWidget(left_container)

        self.tabs = QTabWidget()

        self.message_log = QTextEdit()
        self.message_log.setObjectName("messageLog")
        self.message_log.setReadOnly(True)
        self.tabs.addTab(self.message_log, "Messages")

        self.notes = QTextEdit()
        self.notes.setObjectName("messageLog")
        self.tabs.addTab(self.notes, "Notes")

        body.addWidget(self.tabs, stretch=1)

        return body

    # ---------- Behavior ----------

    def _log(self, text: str):
        timestamp = datetime.now().strftime("%H:%M:%S")
        self.message_log.append(f"[{timestamp}] {text}")

    def connect_toggled(self, checked: bool):
        if checked:
            callsign = self.callsign_input.text().strip().upper()
            aircraft_type = self.aircraft_input.text().strip().upper()

            if not callsign or not aircraft_type:
                self._log("Enter a callsign AND an aircraft type before connecting.")
                self.connect_btn.setChecked(False)
                return

            self.connected = True
            self.connect_btn.setText("Disconnect")
            self.connect_btn.setProperty("connected", "true")
            self.status_label.setText("Connected")
            self.status_label.setProperty("state", "connected")
            self.callsign_input.setEnabled(False)
            self.aircraft_input.setEnabled(False)
            self.calibrate_btn.setEnabled(False)

            self.worker = TrackerWorker(callsign, aircraft_type)
            self.worker.log.connect(self._log)
            self.worker.position.connect(self._on_position_update)
            self.worker.error.connect(self._on_worker_error)
            self.worker.session_started.connect(
                lambda cs, aircraft: self._send_session_event(
                    cs, aircraft, True
                )
            )
            self.worker.session_stopped.connect(
                lambda cs, aircraft: self._send_session_event(
                    cs, aircraft, False
                )
            )
            self.worker.start()
        else:
            self._do_disconnect()
        self._refresh_style()

    def force_disconnect(self):
        if self.connected:
            self.connect_btn.setChecked(False)
            self._do_disconnect()
            self._refresh_style()

    def _do_disconnect(self):
        self.connected = False
        self.connect_btn.setText("Connect")
        self.connect_btn.setProperty("connected", "false")
        self.status_label.setText("Not connected")
        self.status_label.setProperty("state", "idle")
        self.callsign_input.setEnabled(True)
        self.aircraft_input.setEnabled(True)
        self.calibrate_btn.setEnabled(True)

        if self.worker is not None:
            self.worker.stop()
            self.worker.wait(3000)
            self.worker = None

        self._log("Disconnected.")

    def _on_position_update(self, gx: float, gy: float):
        self.freq_value.setText(f"{gx:.0f}, {gy:.0f}")
        self._log(f"Position: ({gx:.1f}, {gy:.1f})")

    def _send_session_event(self, callsign: str, aircraft_type: str,
                            signed_in: bool):
        worker = WebhookEventWorker(callsign, aircraft_type, signed_in)
        self.webhook_event_workers.append(worker)
        worker.result.connect(self._log)
        worker.finished.connect(
            lambda current=worker: self.webhook_event_workers.remove(current)
            if current in self.webhook_event_workers else None
        )
        worker.start()

    def _on_worker_error(self, message: str):
        self._log(f"ERROR: {message}")
        self.connect_btn.setChecked(False)
        self._do_disconnect()
        self._refresh_style()

    def open_reference_map_setup(self):
        dialog = ReferenceMapDialog(self)
        if dialog.exec():
            self._log("Reference map saved.")
        else:
            self._log("Reference map setup cancelled.")

    def _refresh_style(self):
        for widget in (self.connect_btn, self.status_label):
            widget.style().unpolish(widget)
            widget.style().polish(widget)

    def _check_updates_on_startup(self):
        try:
            info = check_for_update()
        except Exception as e:
            self._log(f"Update check failed: {e}")
            return

        if info is None:
            self._log("You're on the latest version.")
            return

        self._log(f"Update available: v{info['version']} "
                   f"(you have v{CURRENT_VERSION}). Downloading...")
        try:
            from updater import apply_update
            apply_update(info)
            self._log("Update downloaded. Restart the app to apply it.")
        except Exception as e:
            self._log(f"Update download failed: {e}")

    def closeEvent(self, event):
        if self.worker is not None:
            self.worker.stop()
            self.worker.wait(3000)
        event.accept()


def resource_path(filename: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, filename)


def main():
    apply_pending_update_and_maybe_restart()

    if sys.platform == "win32":
        import ctypes
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
                "ptfstracker.app.1"
            )
        except Exception:
            pass

    app = QApplication(sys.argv)

    icon_path = resource_path("icon.ico")
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))

    style_path = resource_path("style.qss")
    if os.path.exists(style_path):
        with open(style_path) as f:
            app.setStyleSheet(f.read())

    window = MainWindow()
    if os.path.exists(icon_path):
        window.setWindowIcon(QIcon(icon_path))
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
