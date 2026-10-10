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
cd companion
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

## Datalink messages (CPDLC/PDC)

Once a callsign and Monitor URL are set, the control window polls the
monitor every few seconds for text messages an ATC bot has sent your
callsign - comparable to real-world CPDLC/PDC datalink. Three kinds show up
today: a "contact" instruction (an ATC position that can't reach you by
voice, e.g. right after departing an uncontrolled field, asking you to
switch to a frequency), a PDC (a full IFR clearance sent as text instead of
read aloud, typically during heavy voice traffic), and a fleet-wide
moderator broadcast (server news/updates, not addressed to you
specifically - shown with a 📢 and a distinct color so it's clearly not a
personal ATC instruction). A new message pops up as a toast on the overlay
and is added to the message list behind the "Messages" button in the top
bar, which also shows an unread count. This is one-directional for now -
there's no way to type a reply back to ATC yet.

## FMS and autopilot

Click **FMS / Autopilot** in the control window's sidebar to open a third
window: an MCDU/FMS with the matching autopilot panel above it, which can
fly the aircraft along a route made in the [flight planner](../planner/).

**The FMS style follows your aircraft** (from the HUD's aircraft name, or
the plan), or pick one at the top:

| Style | Aircraft | Autopilot panel | Route import |
|---|---|---|---|
| Airbus MCDU | A320, A330 (and MRTT), A340, Beluga | FCU: SPD/HDG/ALT/V/S knobs (push = managed, pull = selected), AP1/AP2, A/THR | INIT page, type plan ID or callsign, press **1L** (CO RTE) |
| A350/A380 MFD | A350, A380 | Same FCU as the Airbus MCDU | INIT key, click the **CO RTE** field, type the ID on the KCCU, press **ENT** |
| Boeing CDU | 707-777, MD-11/90, P-8, E-3 | MCP: A/T ARM, SPEED, LNAV, VNAV, HDG SEL, ALT HOLD, V/S, CMD A | RTE page, type it, press **2L** (CO ROUTE), then **EXEC** |
| Boeing 787 CDU | 787 | Same MCP as the Boeing CDU | Same as the Boeing CDU |
| A220 FMS | A220 | Guidance panel: HDG, NAV, FLC, VS, VNAV, ALT, AP, YD, A/T | ROUTE tab, click **CO ROUTE**, type the ID on the MKP, press **ENTER**, then **EXEC** |
| Embraer MCDU | E190 | Guidance panel, same buttons (FLCH, VS/FPA) | RTE page, **2L** (LOAD RTE) - no EXEC, as on the real unit |
| Default FMS | Everything else - CRJ700, Q400, Learjet, An-225, C-130, fighters, light aircraft, helicopters... | Guidance panel: HDG, NAV, FLC, VS, VNAV, ALT, AP, A/T | ROUTE page, **2L** (PLAN ID), then **EXEC** |

The Airbus, A350/A380, A220, Boeing, 787 and Embraer units are drawn
from photos of the real ones: the A320-family MCDU, the A350's FMS pages
on the MFD with the KCCU keyboard, the A220's Pro Line Fusion FMS pages
with its MKP keyboard, the 777-style CDU (also used for the 737-777), the
787's CDU, which is drawn on the lower display with a keypad panel beside
it, and the E-Jet MCDU.

The A220 works like the A350 below, with two tab rows (ACT / DBASE / POS /
FPLN / PERF / ROUTE, then that page's own tabs), and like the real
aircraft its changes need **EXEC** (**CNCL** cancels them).

The A350/A380 has no line select keys, like the real aircraft: each line's
left and right halves are fields you click. Click a field and type, then
press ENT - or type first, then click the field. The tabs across the top
(ACTIVE, POSITION, DATA) and the KCCU keys (DIR, PERF, INIT, F-PLN...)
change pages; CLEAR INFO clears a message.

Pages, in each style's own names: route/INIT, LEGS/F-PLN (scroll with the
arrows or PREV/NEXT), PROGRESS, PERF/VNAV/CRZ (type an altitude and press
the CRZ ALT line to change cruise) and DIRECT TO. Direct-to works like the
real units: Airbus DIR page then **INSERT\***; Boeing, 787 and Default
type the waypoint onto the first LEGS line (or the DIR page) then
**EXEC**; Embraer the same on FPL, then **INSERT\***; A350/A380 and A220
type it and click the first waypoint (A220 then **EXEC**).
You can type on the on-screen keypad or your keyboard.

**How it flies.** Every tracking update (heading, altitude and speed off
the HUD, plus the dead-reckoned position), the FMS works out the heading to
fly to stay on the route (LNAV), the altitude/vertical speed for the
climb, cruise and descent profile (VNAV), and the speed for the phase of
flight. The autopilot compares how fast heading, altitude and speed are
*actually* changing with how fast they *should* be, and nudges the
controls to close the gap - longer the bigger the gap:

- **Pitch and bank: the mouse.** PTFS steers toward the cursor, so the
  autopilot moves the cursor off the straight-and-level center point
  (right to bank right, up for nose up) for a moment, then back.
- **Throttle: W / S.** A short tap.

Nudges, never held inputs, so between tracking updates the cursor rests at
center and the aircraft isn't left rolling, and one bad HUD reading can
only cause one small input. The autopilot disconnects itself after 30
seconds without tracking data, and **as soon as you move the mouse
yourself** - like a real autopilot when the pilot moves the controls.

**Before you fly with it:**

1. Open **Settings** in the FMS window and set the **Flight planner URL**
   (your planner service, e.g. `https://your-planner.up.railway.app`).
2. Under **Game controls**, click **Capture center**, then within 3 seconds
   hold your mouse over PTFS where the aircraft flies straight and level
   (usually the middle of the game view). Use **Test bank right** / **Test
   nose up** (3 seconds later, so click into PTFS) to check the direction;
   tick **Invert pitch** if nose up goes the wrong way, and change **Nudge
   distance** if the response is too weak or too strong. Throttle is W/S by
   default - **Test** checks those too. (Pitch & bank control can be
   switched to **Keys** for setups that fly by keyboard.)
3. Set the control window's **Report interval** to 2 seconds while the
   autopilot flies - it only gets new information that often, so 5 seconds
   makes it slow to react.
4. The FMS window starts in **DRY RUN**: the autopilot shows what it would
   press but presses nothing. Switch to **LIVE** to let it press keys. Keys
   go to whichever window has keyboard focus, so keep PTFS focused - while
   LIVE and engaged, the FMS window stops taking keyboard focus (its
   buttons still work with the mouse) so clicking it doesn't steal focus
   from the game. Hands off the mouse while it flies - touching it
   disconnects the autopilot.

macOS needs Accessibility permission for the app (System Settings >
Privacy & Security > Accessibility). Linux needs `xdotool` installed.
Windows needs nothing extra: the app calls Windows' own `SendInput`
directly (through [koffi](https://koffi.dev), installed with the app's
other dependencies), with no helper process or PowerShell - so antivirus
has nothing that looks like malware to flag. If PTFS is ever run as
administrator, Windows blocks input from non-administrator apps; run both
the same way. (If you package the app with electron-builder, add koffi to
`asarUnpack` so its native file stays loadable.)

**Risk:** Roblox's rules can treat outside software that automates gameplay
as a violation. LIVE mode is that, and using it is at each player's own
risk to their account.

**Untested in the real game.** The control logic is tested against a
simple simulated aircraft (see `test/fms-autopilot.test.js` at the repo
root) but has not flown PTFS itself - expect to tune `DEFAULT_TUNING` in
`lib/autopilot.js` (pulse lengths, dead bands) once it does.

## Phone / tablet control

Work the MCDU and autopilot panel from a phone or tablet instead of the PC -
so your hand never touches the PC's mouse, which PTFS steers with (and
which disconnects the autopilot when moved). In the FMS window's
**Settings**, set **Allow control from** to:

- **Anywhere (through the flight planner)** - the phone can be on any
  network (mobile data, another Wi-Fi). The PC connects out to your flight
  planner service, which relays between them, so there's nothing to set up
  on your router. Needs the **Flight planner URL** set. On the phone, open
  `https://<your planner>/remote/` and type the 12-character code shown
  (e.g. `K7Q2-9XMP-4HDA` - dashes and case don't matter).
- **This Wi-Fi only** - no internet involved: the companion app serves the
  page itself at an address like `http://192.168.1.23:8765`, with a 6-digit
  code. The phone must be on the same Wi-Fi. The first time, Windows may
  ask whether to let the app through the firewall - allow it on
  **private** networks. If port 8765 is taken, the settings say so.

The phone remembers the code. To use it like an app, add the page to your
home screen (Share > Add to Home Screen on iPhone; menu > Add to Home
screen on Android). It shows the same MCDU, autopilot panel and mode
annunciator as the PC window, live - tabs on a phone, everything at once
on a tablet - and either can be used at any time. If the PC goes offline
(app closed, PC asleep), the phone shows **PC OFFLINE** and reconnects by
itself when it's back.

Safety:
- Off until you turn it on. Codes are saved, so a paired phone keeps
  working after a restart; **New code** cuts off every device.
- Anywhere mode: the 12-character code has about a quintillion
  combinations and wrong guesses get the guesser locked out, so it can't
  be guessed. The PC also holds a separate secret (never shown) so nobody
  who learns a code can impersonate your PC. The relay stores nothing; a
  session exists only while your companion app is connected.
- This Wi-Fi mode: ten wrong codes from one device lock it out for a minute.
- Either way, a phone can switch the autopilot to DRY RUN but never to
  LIVE - going LIVE is only possible at the PC, behind its warning.

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
- `lib/fms.js` - flight plan state, leg sequencing, direct-to, and
  LNAV/VNAV/speed guidance (also loaded directly by the FMS window).
- `lib/autopilot.js` - autopilot modes and the rate-based controller that
  turns targets into key taps (also loaded directly by the FMS window).
- `lib/inputSender.js` - presses keys and moves the mouse cursor (Windows
  SendInput called directly via koffi, macOS System Events/CoreGraphics,
  Linux xdotool).
- `lib/mouseSteer.js` - pitch/bank nudges via the cursor, and the
  "pilot moved the mouse" override.
- `lib/remoteServer.js` - the phone/tablet remote-control web server for
  this Wi-Fi (pairing code, live view updates, inputs).
- `lib/relayClient.js` - remote control from anywhere: the PC's outbound
  connection to the flight planner's relay (`planner/lib/relay.js`).
- `remote/` - the page phones and tablets open (plus its manifest/icon for
  Add to Home Screen). The planner serves a copy at `/remote/` for
  anywhere mode - after editing these files (or `renderer/fms.css` /
  `fmsView.js`), run `node scripts/sync-remote-page.js`; `npm test` fails
  if the copy is stale.
- `main.js` - creates both windows, relays messages between them, and
  hosts the desktop-capture/settings/airports IPC handlers.
- `preload.js` - exposes IPC calls and direct `lib/` logic to both
  renderers via `contextBridge`.
- `renderer/control.html` / `control.js` - the control window described
  above.
- `renderer/overlay.html` / `overlay.js` - the transparent overlay window
  described above.
- `renderer/fms.html` / `fms.js` / `fms.css` - the FMS / autopilot window:
  the four MCDU styles, autopilot panels and flight mode annunciator.
  `fms.js` builds a plain view of the cockpit and handles every input in
  one place; `renderer/fmsView.js` draws that view - used by both the FMS
  window and the remote page, so they always match.

## Accuracy caveats

This is an estimate, not ground truth. It drifts between minimap
corrections, and OCR occasionally misreads a HUD frame (the app logs and
skips such ticks rather than uploading garbage). ATC bots are told to treat
a stale fix (5+ minutes since the last minimap correction) as unreliable
and confirm with the pilot before vectoring off of it - see
`stalenessNote()` in `src/atc/positions.js`.

## Live feed + A/D yoke steering

In FMS Settings choose **Position source -> AutoATC monitor**, enter your callsign and your monitor address (https://...), and set **Steering -> Yoke (A/D)**. Position and heading come
from the game's data feed (no screen reading); lateral steering pulses A/D by heading error (adapted from 24Flight, see THIRD_PARTY.md).
Regenerate planner plans once so they carry world positions, and run `npm install` for the `ws` dependency.

## AutoATC Pilot (the autopilot app)

The FMS / autopilot is no longer in the plain companion. Run **`npm run pilot`** instead of `npm start`: it is the same app
(tracking, overlay, radios, datalink) with the FMS / MCDU opening alongside it. In the MCDU:

- **ATC COM** (the ATC / ATC COMM / DLK key on your MCDU, or MENU -> ATC COM): the latest messages from ATC (contact, PDC, text), the
  active/standby radio. Enter a frequency + `L4` for standby, `SWAP>` to use it; open a CONTACT message and `TUNE>` loads its frequency.
- **SURV** (SURV key on the A350, or `SURV>` on ATC COM): your squawk, `IDENT>`, enter a 4-digit code on `L2`, and the code ATC assigned
  (picked out of their message) with `SET>` to load it.

Callsign and monitor address are taken from the companion's own settings.

## PFD + MFD for iPads (and other big screens)

The phone/tablet remote now has a second page, **displays.html** (the "PFD / MFD" button on the remote page's top bar, or
`<address>/displays.html` / `<planner>/remote/displays.html`). Pair on the MCDU page once; the displays reuse the same code.
- **PFD:** speed and altitude tapes with the autopilot's target bugs, heading tape, V/S, FMA (modes), and an artificial horizon.
  The game sends no pitch/bank, so the horizon is estimated from turn rate and climb rate.
- **MFD:** route map (heading-up or north-up, range 5-160 NM) with the active leg in magenta, waypoint names and altitude
  restrictions, next-waypoint distance, destination ETE, plus a vertical profile strip with your altitude against the restrictions.
Landscape iPad shows them side by side, portrait stacked.

**Install it as a web app:** open `displays.html` in Safari on the iPad, Share -> Add to Home Screen. It then opens full-screen
like an app (no browser bars), and the page itself is cached so it starts instantly.

## Position fix from the big map (replaces calibrating on two airports)

1. Show the overlay, then in step 3 click **Select big-map region** and drag a box over the big map picture in the game (open it first).
2. Open the big map and press **F8** (or **Fix from big map**). The companion finds your bright-green aircraft marker, and works out
   where the map is looking by matching its coastlines against the radar's world map (`data/worldMask.json`) - at any zoom or pan.
   No airports to click. It prints the match percentage; a good one is 60% or more.
3. While tracking, it re-fixes by itself every few seconds whenever the big map is open, so the radar position stays right (also while
   taxiing, when the speed readout can't be trusted). Close the map and it carries on by dead reckoning from the last fix.

Keep some coastline in view - a map zoomed in on the middle of an island, with only land, can't be matched. Rebuild the mask with
`python3 scripts/build-world-mask.py` if the radar's world map image changes.
