# AutoATC Companion App

A small Electron app pilots run locally, alongside PTFS, to estimate their
own aircraft's position and report it to the fleet's monitor service. ATC
bots (Approach/Departure/Center) use that estimate to vector traffic
realistically instead of flying blind.

It only ever reads the pilot's own game window - never anyone else's - and
never talks to Discord directly. It just POSTs a position estimate to the
Monitor service's `/api/position` endpoint (see the main README's Monitor
section).

## Why dead reckoning, not just minimap tracking

The game's HUD shows heading, speed and altitude as clean, easily-OCR'd
text, and a minimap with a green marker for the player's own aircraft. The
obvious design is to just track that green marker's pixel position and
project it to lat/lon every frame.

The catch: it isn't confirmed whether that minimap recenters on the player
(so the marker pixel never moves, but what's *around* it scrolls) or stays
fixed on the world (so the marker itself moves and the same one-time pixel
calibration keeps working). Those two behaviors need different tracking
logic, and guessing wrong silently produces a stale or wrong position.

So the app sidesteps the question: **dead reckoning is the primary
estimator.** Every tracking tick reads heading + speed off the HUD and
integrates them from the last known fix - that math doesn't care what the
minimap is doing. The minimap is only used for periodic manual correction:
you click your marker on it now and then to reset the dead-reckoning error
back to zero. If the minimap turns out to be static, automated marker
tracking (already built in `lib/marker.js`, just not wired into the
renderer) can be added later as a nice-to-have; it was never required for
this to work.

## Setup

```
npm install
npm start
```

(`electron` is a devDependency; `npm install` pulls it down. Nothing here
is published - it's meant to be run from a checkout or packaged later with
`electron-builder`/`electron-forge` if the fleet wants a one-click
installer.)

## Two windows: control + overlay

The app is two Electron windows working together:

- **Control window** - a normal small window: settings, monitor picker,
  region/calibration buttons, and the tracking log. Nothing here overlaps
  the game.
- **Overlay window** - transparent, borderless, and sized to exactly cover
  one monitor. It's click-through by default (clicks pass straight through
  to the game beneath it), so it never gets in the way of actually flying.
  It only becomes clickable for the instant you're dragging out a region
  box or clicking a calibration point - the control window "arms" it for
  one action, it captures that one drag/click, reports it back, and
  immediately goes click-through again.

  The overlay also carries a **top bar** - a slim strip docked to the top
  of the screen, like a game overlay HUD (Discord/Xbox Game Bar style).
  Unlike the rest of the overlay, it's always clickable: moving the cursor
  over it toggles the window briefly interactive, moving off it hands
  control back to the game. It shows your current fix and whether tracking
  is running, with a one-click Start/Stop, and a "Setup" button that brings
  the control window back to front - so once you're calibrated, you can
  fly with only the bar visible and never touch the control window again.

This is what makes a single monitor workable: you're not alt-tabbing
between a video preview and the real game to line things up, and you're
not eyeballing a scaled-down copy of your HUD. You drag/click directly on
the real game through the overlay, so a region box is exactly where you
drew it, in real screen pixels - no separate preview coordinate system to
get slightly wrong.

**A game running in exclusive fullscreen can't be overlaid** - Windows
(and most OSes) won't composite anything on top of an exclusive-fullscreen
surface. Run PTFS in windowed or borderless-windowed mode.

## Using it

1. **Settings** - enter your callsign, the fleet's Monitor URL (and API key,
   if the monitor requires one), and how often to report (default 5s).
2. **Show the overlay** - pick the monitor your game is on and click "Show
   overlay". You'll see a banner appear on your screen whenever it's armed
   for an action; otherwise it's invisible and click-through.
3. **Define regions** (once per game window size/position) - click "Select
   heading region" / "Select info-box region" / "Select minimap region",
   then drag a box directly on your game over the matching HUD element.
   These are saved and don't need to be redone unless you move or resize
   the game window. A checkbox lets you toggle whether the saved boxes are
   drawn on the overlay as a passive reference.
4. **Calibrate the map** - pick two airports you can currently see on your
   minimap from the two dropdowns, click "Calibrate", then click each
   airport's exact spot on your minimap in the order prompted (the overlay
   arms itself for each click automatically). This gives the app a
   pixel-to-lat/lon transform for the current minimap view. Re-calibrate
   any time you pan or zoom the minimap.
5. **Set your position** - click "Set my position", then click your own
   aircraft marker on the minimap. This is also how you periodically
   correct dead-reckoning drift - do it again whenever convenient.
6. **Start tracking** - the app now ticks on the configured interval: OCR's
   the heading and info regions (from a background screen capture of the
   same monitor, not the overlay itself), integrates a new dead-reckoning
   position from the last fix, works out distance/bearing to the nearest
   known airport, and uploads that to the Monitor service. The log in the
   control window shows what was read and uploaded, or why a tick was
   skipped.

Pressing **Escape** while the overlay is armed cancels that one action
(the banner disappears and the overlay goes back to click-through) without
saving anything.

## Module layout

- `lib/coords.js` - lat/lon parsing, flat-earth distance/bearing math.
- `lib/calibration.js` - two-point pixel-to-lat/lon similarity transform.
- `lib/deadReckoning.js` - heading/speed/time integration.
- `lib/ocr.js` - `tesseract.js` wrapper + HUD text parsing.
- `lib/marker.js` - green-pixel centroid detection (built, not currently
  wired into the renderer - see "Why dead reckoning" above).
- `lib/airports.js` - loads airport coordinates from `data/charts/*.json`,
  finds the nearest one to a given position.
- `lib/uploader.js` - POSTs a position estimate to the Monitor service.
- `main.js` - creates both windows, relays messages between them, and
  hosts the desktop-capture/settings/airports IPC handlers.
- `preload.js` - exposes IPC calls and direct `lib/` logic to both
  renderers via `contextBridge`.
- `renderer/control.html` / `control.js` - the control window described
  above.
- `renderer/overlay.html` / `overlay.js` - the transparent overlay window
  described above.

## Accuracy caveats

This is an estimate, not ground truth. It drifts between minimap
corrections, and OCR occasionally misreads a HUD frame (the app logs and
skips such ticks rather than uploading garbage). The ATC bot fleet (see the
main AutoATC repo) treats a stale fix (5+ minutes since the last minimap
correction) as unreliable and confirms with the pilot before vectoring off
of it.
