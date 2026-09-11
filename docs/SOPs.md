# AutoATC Standard Operating Procedures

Living reference document for how the AI ATC fleet should behave at each
airport. This is the human-readable source of truth behind what's actually
encoded in the code (`src/ai/systemPrompt.js`, `data/frequencies.json`,
`data/charts/*.json`, `data/scenarios.json`) — when the two disagree, the
code is what the bots actually run on, but this document should be kept in
sync with it and is the place to work out new rules before they're coded.

**This is a living document.** The user is uploading additional custom
charts over time to further outline controller roles and control-area
boundaries — sections below marked *(unconfirmed)* or *(partial)* should be
filled in / corrected as that happens, not treated as final.

## General position responsibilities

These apply at every airport unless a specific override is noted below
(see "Carrier operations"). Matches `POSITION_RESPONSIBILITIES` in
`src/ai/systemPrompt.js` — keep this section in sync with that file.

| Position | Handles | Does NOT handle | Redirect to |
|---|---|---|---|
| **Ground** | Taxi instructions, pushback, ramp/apron movement | Takeoff/landing clearances, runway crossings, radar services | Tower / Approach |
| **Clearance Delivery** | IFR/VFR clearance readout: route, altitude, departure frequency, squawk | Taxi instructions, takeoff clearances | Ground / Tower |
| **Tower** | Takeoff/landing clearances, pattern entry and sequencing, runway crossings | Taxi routing, pushback, engine start (Ground's job); radar vectors/traffic advisories (Approach's/Departure's job) | Ground / Approach / Departure |
| **Departure** | Radar vectors, altitude/heading instructions, traffic advisories for aircraft that just departed; hands off to Center | Taxi or takeoff clearances | Ground / Tower |
| **Approach** | Radar vectors, sequencing, altitude/heading for arriving aircraft; hands off to Tower for landing | Landing clearances (Tower's job once close enough) | Tower |
| **Center** | En-route radar control between departure and arrival airspace — altitude assignments, routing, handoffs to next facility | Airport-specific taxi, takeoff, or landing services | The relevant airport's own frequency |

Whenever a bot redirects a pilot to another position, it must state that
position's **real frequency** from `data/frequencies.json` — never invent
one, never state one for a station that isn't in the list. This is already
enforced in the system prompt as of the "Instruct the model to actually use
real frequencies when redirecting" change.

## Carrier operations (USS, HMS) — confirmed

Carriers do **not** follow the general position table above. Confirmed two
independent ways: (1) neither carrier has an APP/DEP or GND entry in
`data/frequencies.json` — only TWR and APRON; (2) the airspace chart the
user provided (`image.svg`, added 2026-09-10) shows no Approach/Departure
ring drawn around either carrier, unlike every island airport.

- **No separate Ground** — pushback/engine start/deck movement goes through
  **Apron** control instead.
- **No Approach/Departure at all** — Tower hands departing traffic
  **directly to the covering Center**.
- **No named taxiways on the deck.** The user uploaded custom deck charts
  for both carriers (`HMS Queen.svg`, `USS Gerald.svg`, added
  2026-09-10) showing simple linear deck layouts with hand-marked taxi
  routes - decided against extracting named-route chart data from these
  (deleted from the repo) in favor of Apron giving simple relative
  directions ("turn right", "turn left") to an aircraft's departure point
  or parking spot instead.
- Both Tower's and Apron's guidance are overridden for these two airports
  specifically - `getCarrierTowerGuidance()` and `getCarrierApronGuidance()`
  (`src/ai/systemPrompt.js`), triggered when `persona.airport` is `USS` or
  `HMS`.

| Carrier | Callsign | Frequencies |
|---|---|---|
| USS | Carrier Tower / Carrier Apron | TWR 127.500, APRON 127.750 |
| HMS | Carrier Tower / Carrier Apron | TWR 120.500, APRON 120.750 |

## Per-airport reference

Runways from `data/charts/<ICAO>.json` (SVG chart extraction, CC BY-SA 4.0
from the community PTFS charts repo). Frequencies from
`data/frequencies.json` (hand-compiled sheet — see "Known discrepancies"
below for where these two sources have disagreed before).

| ICAO | Name | Runways | Stations (freq) |
|---|---|---|---|
| IBAR | Barra Airport | *(none extracted)* | TWR 118.750 |
| IBLT | Boltic Airfield | 1/19 | TWR 120.250 |
| IBRD | Bird Island Airfield | 8/26 | TWR 118.350 |
| IBTH | Saint Barthélemy | 27/09 | TWR 118.700, VFR TWR 118.450, GND 118.475, DEL 118.705 |
| IDCS | Saba Airport | 25/7 | TWR 118.250 |
| IGAR | Air Base Garry | 4/22 | TWR 125.600 |
| IHEN | Henstridge Airfield | 35/17 | TWR 130.250 |
| IIAB | McConnell AFB | 9L/9R/27R/27L | TWR 127.250 |
| IJAF | Al Najaf | 7/25 | TWR 121.100 |
| IKFL | Keflavik Intl. | 16/7/34/25 | APP 119.300, TWR 121.750, GND 118.300, DEL 121.300 |
| ILAR | Larnaca Intl. | 6/24 | APP 119.425, TWR 121.200, GND 119.400 |
| ILKL | Lukla Airport | 9/27 | TWR 120.150 |
| IMLR | Mellor Intl. | 25/7 | APP 125.650, TWR 133.850, GND 121.920, DEL 121.925 |
| IPAP | Paphos Intl. | 35/17 | TWR 119.900 |
| IPPH | Perth Intl. | 29/33/11/15 | ARR 127.440, TWR 127.400, GND 121.700, DEL 118.850 |
| IRFD | Greater Rockford | 25C/25R/25L/7L/7C/7R | APP 120.400, DEP 120.425, TWR 121.000, GND 118.100, DEL 119.250 |
| ISAU | Sauthemptona Airport | 8/26 | TWR 118.200, GND 130.880, APRON 130.885 |
| ISCM | RAF Scampton | 13/31 | TWR 119.300 |
| ISKP | Skopelos Airfield | 23/5 | VFR TWR 134.520 |
| ITEY | Pingeyri Airport | 31/13 | TWR 119.425 |
| ITKO | Tokyo Intl. | 2/20/31/13 | APP 118.225, DEP 118.230, TWR 119.100, GND 118.800, DEL 121.825 |
| ITRC / IRTC *(name mismatch, see below)* | Training Centre / Training Control | 36/18 | 119.150 |
| IUFO | UFO Base | 8/26 | *(none in frequency sheet)* |
| IZOL | Izolirani Intl. | 10/28 | TWR 118.700, GND 118.900, DEL 123.000 |
| SHV | Sea Haven Seaplane Base | 4 | *(none in frequency sheet)* |
| TVO | Tavaro Seabase | *(none extracted)* | *(none in frequency sheet)* |

Notes on individual airports:
- **IPPH (Perth)** uses **ARR** (Arrivals) instead of a separate Approach —
  one combined frequency handles arrival sequencing.
- **ISAU (Sauthemptona)** has *both* GND and APRON frequencies, now
  confirmed via a custom ground chart the user annotated (`ISAU_Ground_Chart.svg`,
  added 2026-09-10): two distinct physical apron zones exist (the
  terminal/gate ramp area near stands 1-4, and the hangar/control-tower
  area) — Ground (130.880) covers taxi between the runway and those apron
  boundaries; Apron (130.885) covers movement within them. ISAU now has a
  dedicated Apron bot type in `config/bots.example.json`, and
  `POSITION_RESPONSIBILITIES` in `src/ai/systemPrompt.js` has a matching
  "apron" entry, with Ground's own guidance updated to hand off apron-zone
  movement instead of handling it itself. This is the first airport (other
  than the carriers) confirmed to need this split — worth checking whether
  any other airport's chart shows the same pattern once more are uploaded.
  Separately, ISAU's original (non-custom) chart also shows a
  **"SAUTHEMPTONA Radar" frequency (122.730)** not present in
  `data/frequencies.json` at all — unconfirmed whether that's active/real,
  not yet added anywhere.
- Most single-runway/general-aviation fields (IBAR, IBLT, IBRD, IDCS, IGAR,
  IHEN, IIAB, IJAF, ILKL, IPAP, ISCM, ITEY) only have a **TWR** frequency —
  no Ground/Delivery/Approach exist there at all. A bot at one of these
  fields should treat Tower as covering the entire operation, similar in
  spirit to the carrier exception but without the Apron/Center specifics
  (this hasn't been explicitly confirmed with a chart yet — flag if a
  redirect-to-Ground scenario ever fires at one of these and shouldn't).
- **ISKP (Skopelos)** only lists a VFR TWR — same caveat as above.

## Known discrepancies between chart data and the frequency sheet

- **IZOL**: chart-extracted frequencies (Ground 121.900, Delivery 128.200)
  disagreed with the frequency sheet (Ground 118.900 as of the 2026-09-10
  correction, Delivery 123.000). Resolved by treating the frequency sheet
  as authoritative fleet-wide — `formatChart()` in `src/charts/store.js` no
  longer includes frequencies at all, to avoid ever presenting the model
  with two conflicting numbers for the same station.
- **ITRC vs IRTC**: the chart file is named `ITRC.json` ("Training
  Centre"), the frequency sheet has `IRTC` ("Training Control") — likely a
  transposition typo in one of the two sources. Not yet resolved; needs a
  decision on which is correct (or if they're genuinely two different
  things).

## Center sector coverage

### Confirmed from the airspace chart (`image.svg`, added 2026-09-10)

The chart is a **partial regional crop**, not the whole map — it shows
Orenji, USS Carrier, Grindavik, Saint Barthélemy, Perth, Izolirani,
Skopelos, Oil Rig, Sauthemptona, Greater Rockford, HMS Carrier, and Cyprus,
divided by white sector-boundary lines. Other Centers listed in the
frequency sheet (Rockford, Tokyo, Mellor, Keflavik, Larnaca, etc. — see
full list below) aren't visible in this particular image and need a wider
or additional chart to confirm.

General pattern confirmed by this chart: **red outlines ring the
immediate Approach/Departure zone around each individual airport**; the
larger area between those red zones, out to the white sector boundary, is
that sector's Center. This matches the general-position-table description
of Approach/Departure vs. Center above.

Precise tracing of which landmass falls on which side of every white line
in this image is not reliable enough to state as fact from a single
hand-drawn chart — needs either a cleaner/labeled chart or explicit
confirmation per boundary as more charts come in.

### All known Centers (from `data/frequencies.json`)

| Center code | Callsign |
|---|---|
| IRCC | Rockford Center |
| IOCC | Tokyo Center |
| IPCC | Perth Center |
| IGCC | Grindavik Center |
| ICCC | Cyprus Center |
| IZCC | Izolirani Center |
| EGCC | Sauthemptona Center |
| IBCC | Barths Center |
| ISCC | Skopelos Center |

### Best-guess grouping *(unconfirmed — inferred only from row-ordering in the frequency sheet, NOT from chart data)*

The frequency sheet appears to list stations grouped by region (each
Center's rows followed by the airports it likely covers), but this is an
inference from list order, not a stated fact — **do not encode this into
bot behavior until confirmed**:

- IRCC (Rockford) → IRFD
- IOCC (Tokyo) → ITKO, IDCS, IBRD
- IPCC (Perth) → IPPH, ILKL
- IGCC (Grindavik) → IKFL, ITEY
- ICCC (Cyprus) → ILAR, IIAB, IPAP, IBAR, IHEN
- IZCC (Izolirani) → IZOL, IJAF, ISCM
- EGCC (Sauthemptona) → ISAU
- IBCC (Barths) → IBTH
- ISCC (Skopelos) → ISKP

Not yet placed anywhere: IMLR (Mellor), IGAR (Garry), IBLT (Boltic), ITRC/
IRTC (Training), IUFO, SHV, TVO, and both carriers (USS/HMS — confirmed to
have no Center-sector membership at all in the normal sense, see "Carrier
operations" above).

## Open items

- [ ] Confirm ITRC vs IRTC naming
- [ ] Confirm which Center covers Mellor, Garry, Boltic, and the
      single-runway GA fields not yet grouped above
- [ ] Confirm precise Center sector boundaries against additional charts
      as they're uploaded
- [ ] Confirm whether single-TWR-only fields (IBAR, IBLT, etc.) need their
      own carrier-style Tower override, or whether the generic Tower
      guidance is fine since there's nothing to redirect to anyway
- [x] ~~Confirm ISAU's GND vs APRON split in practice~~ — confirmed via
      custom chart 2026-09-10, dedicated Apron position added
- [ ] Confirm whether the "SAUTHEMPTONA Radar" frequency (122.730, from
      ISAU's original chart) is real/active - not in the frequency sheet
- [ ] Check other airports' charts for the same Ground/Apron split now
      that ISAU has confirmed it happens at least once
