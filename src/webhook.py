"""
Posts position updates to a Discord webhook as a formatted embed.
"""

import time
import requests

import app_config as config

_last_post_time = 0.0


def post_session_event(callsign, aircraft_type, signed_in):
    action = "signed on" if signed_in else "signed off"
    if not config.DISCORD_WEBHOOK_URL:
        return "Discord webhook is not configured; edit the user's settings.json."

    payload = {
        "embeds": [
            {
                "title": f"{callsign} {action}",
                "fields": [
                    {"name": "Callsign", "value": callsign, "inline": True},
                    {"name": "Aircraft", "value": aircraft_type, "inline": True},
                ],
                "color": 0x2ECC71 if signed_in else 0xE74C3C,
            }
        ]
    }

    try:
        resp = requests.post(config.DISCORD_WEBHOOK_URL, json=payload, timeout=5)
        if resp.status_code >= 300:
            detail = resp.text.strip()
            if detail:
                detail = f" {detail[:300]}"
            return f"Discord returned HTTP {resp.status_code} for {action}.{detail}"
    except (requests.RequestException, ValueError) as e:
        return f"Failed to post {action} message to Discord: {e}"

    return f"Discord {action} message sent (HTTP {resp.status_code})."


def post_position(game_x, game_y, callsign=None, aircraft_type=None):
    """
    Posts to Discord, throttled to DISCORD_POST_MIN_INTERVAL_SECONDS so
    you don't spam the webhook on every tracking tick.

    callsign / aircraft_type: passed in from the GUI (the user enters these
    before connecting). Falls back to config.CALLSIGN if not provided, and
    leaves aircraft type blank if none was given.
    """
    global _last_post_time
    if not config.DISCORD_WEBHOOK_URL:
        return None

    now = time.time()
    if now - _last_post_time < config.DISCORD_POST_MIN_INTERVAL_SECONDS:
        return None

    callsign = callsign or getattr(config, "CALLSIGN", "UNKNOWN")
    aircraft_type = aircraft_type or "-"

    payload = {
        "embeds": [
            {
                "title": f"{callsign} - position update",
                "fields": [
                    {"name": "Aircraft", "value": aircraft_type, "inline": True},
                    {"name": "X", "value": f"{game_x:.1f}", "inline": True},
                    {"name": "Y", "value": f"{game_y:.1f}", "inline": True},
                ],
                "color": 0x3498DB,
            }
        ]
    }

    _last_post_time = now
    try:
        resp = requests.post(config.DISCORD_WEBHOOK_URL, json=payload, timeout=5)
        if resp.status_code >= 300:
            return f"Discord returned HTTP {resp.status_code}."
    except requests.RequestException as e:
        return f"Failed to post to Discord: {e}"

    return "Position sent to Discord."
