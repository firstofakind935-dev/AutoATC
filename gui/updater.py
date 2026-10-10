"""
Self-update mechanism, built around GitHub Releases.

How it works:
  1. On startup, apply_pending_update_and_maybe_restart() checks whether a
     previously-downloaded update is waiting next to the running exe. If so,
     it hands off to a small batch script that waits for this process to
     exit, swaps the files, and relaunches — this is necessary because
     Windows won't let a running .exe overwrite itself.
  2. check_for_update() asks the GitHub API for the latest release and
     compares its tag against CURRENT_VERSION.
  3. apply_update() downloads the new .exe asset and stores it as a
     "*_pending.exe" file next to the current one, ready for step 1 on the
     NEXT app launch (we deliberately don't force an immediate restart —
     the GUI just tells the user an update is ready).

SETUP REQUIRED: fill in GITHUB_REPO below with "owner/repo-name" once your
repo exists, and make sure your GitHub Releases include a built .exe as an
attached asset (see gui/BUILD.md for how to build + publish one).
"""

import os
import sys
import subprocess
import tempfile

import requests

# --- Fill this in ---
GITHUB_REPO = ""   # self-update is OFF in the ATC365 test build (it would replace this adapted build with the upstream one)
EXE_NAME = "PTFSTracker.exe"                       # must match your PyInstaller output name
# --------------------

APP_DIR = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else __file__)
VERSION_FILE = os.path.join(os.path.dirname(__file__), "version.txt")


def _read_local_version() -> str:
    try:
        with open(VERSION_FILE) as f:
            return f.read().strip()
    except FileNotFoundError:
        return "0.0.0"


CURRENT_VERSION = _read_local_version()


def _version_tuple(v: str):
    v = v.lstrip("v")
    parts = []
    for p in v.split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def check_for_update():
    """
    Returns None if already on the latest version, otherwise a dict:
      {"version": "1.1.0", "download_url": "...", "notes": "..."}
    """
    if not GITHUB_REPO or "YOUR-GITHUB-USERNAME" in GITHUB_REPO:
        # Not configured yet — skip silently rather than erroring on every launch.
        return None

    resp = requests.get(
        f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
        timeout=8,
    )
    resp.raise_for_status()
    release = resp.json()

    latest_version = release.get("tag_name", "0.0.0")
    if _version_tuple(latest_version) <= _version_tuple(CURRENT_VERSION):
        return None

    exe_asset = next(
        (a for a in release.get("assets", []) if a["name"] == EXE_NAME),
        None,
    )
    if exe_asset is None:
        return None  # release exists but no exe attached yet

    return {
        "version": latest_version,
        "download_url": exe_asset["browser_download_url"],
        "notes": release.get("body", ""),
    }


def apply_update(info: dict):
    """
    Downloads the new exe next to the current one, named "*_pending.exe".
    Does NOT swap it in immediately — that happens on next launch via
    apply_pending_update_and_maybe_restart().
    """
    pending_path = os.path.join(APP_DIR, EXE_NAME + "_pending.exe")
    resp = requests.get(info["download_url"], stream=True, timeout=30)
    resp.raise_for_status()
    with open(pending_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 16):
            f.write(chunk)


def apply_pending_update_and_maybe_restart():
    """
    Call this FIRST, before building the GUI. If a pending update is found,
    this spawns a helper batch script to perform the swap + relaunch, then
    exits the current process immediately (required so the swap can
    overwrite this exe's file, which is locked while running).

    If no pending update exists, this returns normally and startup continues.
    """
    if not getattr(sys, "frozen", False):
        return  # running as a plain .py script (dev mode) — nothing to swap

    current_exe = sys.executable
    pending_path = current_exe + "_pending.exe"

    if not os.path.exists(pending_path):
        return

    bat_path = os.path.join(tempfile.gettempdir(), "ptfs_tracker_update.bat")
    bat_contents = f"""@echo off
:wait_loop
tasklist /FI "PID eq {os.getpid()}" 2>NUL | find /I "{os.getpid()}" >NUL
if not errorlevel 1 (
    timeout /t 1 /nobreak >NUL
    goto wait_loop
)
del "{current_exe}"
move /Y "{pending_path}" "{current_exe}"
start "" "{current_exe}"
del "%~f0"
"""
    with open(bat_path, "w") as f:
        f.write(bat_contents)

    subprocess.Popen(
        ["cmd", "/c", bat_path],
        creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
    )
    sys.exit(0)
