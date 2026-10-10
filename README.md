# vPTFS Track - ATC365 test build (`test-pim-vpilot`)

> **Test branch.** This is PimPlaying's [vptfstrack](https://github.com/pimplaying/vptfstrack) (MIT, (c) 2026 PimPlaying), used and
> adapted here with his OK for closed testing with the ATC365 / AutoATC system. His license is kept in `LICENSE`.

## What was changed from the original

| Area | Change |
|---|---|
| **Position reports** | New `src/monitor_client.py`: every fix is sent to the ATC365 tracking system (`POST /api/position` on the AutoATC monitor, `MONITOR_URL` / `MONITOR_API_KEY` in settings). The reference-map pixel becomes distance and bearing from the nearest airport, measured from the same airport points the radar draws. Heading and speed (this app doesn't read them off the screen) are worked out from the track. The Discord webhook still works as before. |
| **Reference map** | The shipped `src/reference_map.png` is now the ATC365 radar's own world map, so every pilot reports in the same frame. **Set Reference Map still works** (your own capture of the expanded game map, saved separately - the shipped map is never overwritten): the app lines your capture up with the radar map automatically and carries every fix across. If it can't (too little coastline), it says so and uses the radar map. (`src/world_anchors.json` holds the airport points.) |
| **Map matching** | `src/map_locator.py` now matches land/sea masks instead of raw grayscale. A crisp zoomed-in minimap and the blurry world map only share the coastline, and the plain grayscale match picked the wrong island on a test screenshot (with a passing 0.40 confidence). Windows with nothing to correlate (all sea) are discarded. The scale search is wider and geometric. |
| **Marker** | Default marker colour is the bright green aircraft marker (161, 233, 93). |
| **Updater** | Self-update is switched off (it would replace this adapted build with the upstream one). |
| **Not included** | The prebuilt `PTFSTracker.exe`, `gui/build/` output and the committed `.venv`: build from source (`gui/BUILD.md`). |
| **Tests** | `python -m unittest discover -s tests -v` (needs `opencv-python`, `numpy`, `requests`). |

### Settings (`settings.json` or `src/config.py`)
```
MONITOR_URL = "https://cpdlc.up.railway.app"
MONITOR_API_KEY = ""          # only if the monitor has INGEST_API_KEY set
MONITOR_POST_MIN_INTERVAL_SECONDS = 2
MIN_MATCH_CONFIDENCE = 0.35   # try 0.45+ if you see jumps
MINIMAP_REGION = {...}        # the box on your screen with the minimap
```
**Setting the minimap box:** with the venv active, run `python tools\pick_region.py` from the repo root, drag a box around the minimap, and paste the `MINIMAP_REGION` it prints into `src\config.py`. It also saves `region_check.png` (what the tracker sees) and tells you the marker colour it found.

Assumes the minimap is a north-up crop of the same game map (as the original does) and that the marker is the only large bright-green shape in `MINIMAP_REGION`.

---

# Original README

# vPTFS Track

### ATC365 Flight Tracking Client

vPTFS Track is a dedicated flight tracking application made for **ATC365**. It provides a simple desktop interface for tracking aircraft and viewing nearby ATC positions.


## ✈️ Features

- **Aircraft Tracking** — Track an aircraft using its callsign and aircraft type.
- **ATC Range** — View controllers currently within range.
- **Reference Map** — Set a reference map for tracking operations.
- **Controller Information** — See nearby ATC positions, including:
  - Center
  - Approach / Departure
  - Tower
  - Ground
  - Ramp
  - Clearance Delivery
  - ATIS
  - Observers
- **Messages** — View tracker and connection messages in real time.
- **Notes** — Dedicated notes panel for operational information.
- **Discord Integration** — Automatically sends tracker status messages through Discord.
- **Connection Status** — Clearly shows whether vPTFS Track is connected.

## 🖥️ Interface

The application is designed around a straightforward control layout:

| Area | Description |
|---|---|
| Connection | Connect/disconnect from the ATC365 tracking service |
| Aircraft | Enter the aircraft callsign and type |
| Controllers In Range | Displays nearby ATC positions |
| Messages | Displays tracker and connection activity |
| Notes | Provides a dedicated space for notes |
| Status | Shows the current connection status |

## 🚀 Getting Started

1. Download the latest release from the **Releases** section.
2. Launch `vPTFS Track`.
3. Connect to the ATC365 tracking service.
4. Enter the aircraft callsign.
5. Enter the aircraft type.
6. Begin tracking.

## 📋 Example

A typical tracking session can display information such as:

```text
Tracker started for KLM43AK (B738).
Discord signed on message sent.
