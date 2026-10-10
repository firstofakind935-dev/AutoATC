# Building, Packaging, and Releasing PTFS Tracker

## 1. Run it in dev mode first (no building needed)

Use Python 3.12 for the pinned dependencies. From the repository root in
PowerShell:

```
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r gui/requirements-gui.txt
cd gui
python main.py
```

You should see the vPilot-style window. The Connect button just toggles
state and logs messages for now — backend wiring comes next.

Packaged installs create a per-user settings file at
`%APPDATA%\PTFS Tracker\settings.json`. Each user must add their own Discord
webhook URL and configure their minimap region there. The reference map is
saved in the same per-user folder. Do not distribute this settings file; it
contains the user's webhook credential.

## 2. Configure self-update

In `gui/updater.py`, set:
```python
GITHUB_REPO = "your-username/vptfstrack"   # your actual GitHub repo
```
Self-update checks your repo's GitHub Releases for a newer version tag and
an attached `PTFSTracker.exe` asset. Until this is set, update checks are
silently skipped (no error shown to users).

## 3. Build the .exe

```
pip install pyinstaller
cd gui
pyinstaller build.spec
```
Output: `gui/dist/PTFSTracker.exe` — a single-file, no-console-window exe.

## 4. Build the installer

1. Install [Inno Setup](https://jrsoftware.org/isinfo.php) (free, Windows-only).
2. Open `gui/installer.iss` in the Inno Setup Compiler.
3. Build → Compile.
4. Output: `gui/installer_output/PTFSTracker_Setup.exe` — this is what you
   give to other people to install. It creates a Start Menu entry, optional
   desktop icon, and a proper uninstaller.

## 5. Releasing an update

Whenever you want to push an update to everyone who has the app installed:

1. Bump the version number in `gui/version.txt` (e.g. `1.0.0` -> `1.1.0`).
2. Rebuild the exe: `pyinstaller build.spec`.
3. On GitHub: Releases -> Draft a new release.
   - Tag it with the SAME version number, e.g. `1.1.0`.
   - Attach `dist/PTFSTracker.exe` as a release asset (drag and drop it in).
   - Publish the release.
4. That's it — the next time each installed copy launches, it checks GitHub,
   sees the newer tag, downloads the new exe in the background, and applies
   it (with a relaunch) the time after that.

Users never need to visit GitHub or run the installer again for routine
updates — only the very first install needs `PTFSTracker_Setup.exe`.

## Notes / things to revisit later

- Add a real `.ico` file and point both `build.spec` and `installer.iss` at
  it for a proper taskbar/installer icon instead of the default.
- Right now the update check runs every launch and silently downloads in
  the background — consider adding a "Check for updates" menu item and a
  visible progress indicator once this feels stable.
- Code-signing the exe (a paid certificate) will stop Windows SmartScreen
  from warning installers about an "unknown publisher" — not required to
  function, but worth it if you're distributing to more than a handful of
  people.
