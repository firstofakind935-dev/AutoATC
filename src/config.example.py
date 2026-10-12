"""
Copy this file to config.py and fill in your real values.
config.py is git-ignored so your webhook URL never gets committed.
"""

# --- Screen capture ---
# "auto": the tracker finds the PTFS minimap on screen by itself (by its corner buttons).
# Only if that fails, put the box here instead: {"left": .., "top": .., "width": .., "height": ..}
# (tools\pick_region.py prints one).
MINIMAP_REGION = "auto"

# --- Marker detection ---
# Simplest approach: your player marker is a distinct solid color (many
# Roblox minimaps use a bright color like white/blue/red for "you").
# Give an RGB color and a tolerance. If that's not reliable, switch
# marker_finder.py to template matching instead (see comments there).
MARKER_COLOR_RGB = (161, 233, 93)    # the bright green aircraft marker
MARKER_COLOR_TOLERANCE = 45          # per-channel +/- tolerance
MARKER_MIN_PIXEL_AREA = 4            # ignore tiny noise blobs smaller than this

# --- Tracking loop ---
POLL_INTERVAL_SECONDS = 1.0   # how often to capture + process a frame

# --- Discord ---
DISCORD_WEBHOOK_URL = ""
DISCORD_POST_MIN_INTERVAL_SECONDS = 5  # avoid spamming the webhook every tick

# --- Local broadcast server (for the web map) ---
BROADCAST_HOST = "localhost"
BROADCAST_PORT = 8765

# --- Identity (shown in Discord + on the map) ---
CALLSIGN = "YOURCALLSIGN"

# --- ATC365 tracking system (the AutoATC monitor) ---
MONITOR_URL = "https://cpdlc.up.railway.app"
MONITOR_API_KEY = ""                 # only if the monitor has INGEST_API_KEY set
MONITOR_POST_MIN_INTERVAL_SECONDS = 2
MIN_MATCH_CONFIDENCE = 0.35
