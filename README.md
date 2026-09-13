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

## Using it

1. **Settings** - enter your callsign, the fleet's Monitor URL (and API key,
   if the monitor requires one), and how often to report (default 5s).
2. **Pick the game window** - refresh and click the PTFS window's thumbnail.
   This starts a live preview via Electron's `desktopCapturer` +
   `getUserMedia`.
3. **Define regions** (once per window size) - click "Select heading
   region" / "Select info-box region" / "Select minimap region", then drag
   a box on the video over the matching part of your HUD. These are saved
   to settings and don't need to be redone unless you resize the game
   window.
4. **Calibrate the map** - pick two airports you can currently see on your
   minimap from the two dropdowns, click "Calibrate", then click each
   airport's exact spot on the minimap in the order prompted. This gives
   the app a pixel-to-lat/lon transform for the current minimap view.
   Re-calibrate any time you pan or zoom the minimap.
5. **Set your position** - click "Set my position", then click your own
   aircraft marker on the minimap. This is also how you periodically
   correct dead-reckoning drift - do it again whenever convenient.
6. **Start tracking** - the app now ticks on the configured interval: OCR's
   the heading and info regions, integrates a new dead-reckoning position
   from the last fix, works out distance/bearing to the nearest known
   airport, and uploads that to the Monitor service. The log at the bottom
   shows what was read and uploaded, or why a tick was skipped.

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
- `main.js` / `preload.js` / `renderer/` - the Electron shell described
  above.

## Accuracy caveats

This is an estimate, not ground truth. It drifts between minimap
corrections, and OCR occasionally misreads a HUD frame (the app logs and
skips such ticks rather than uploading garbage). The ATC bot fleet (see the
main AutoATC repo) treats a stale fix (5+ minutes since the last minimap
correction) as unreliable and confirms with the pilot before vectoring off
of it.
