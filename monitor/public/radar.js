(function () {
  // Controller workstation: live traffic map, a Flight Strips table, a
  // Notepad, an ATIS generator, and a vectoring tool - so watching the
  // board doesn't require actually being in the game. Airports are fixed
  // reference points (loaded once from airports.json, generated from this
  // repo's chart data); aircraft are plotted from the same distance/
  // bearing/referenceAirport shape the bot fleet already consumes
  // (src/atc/positions.js), converted back to an absolute offset with the
  // same flat-earth math used everywhere else in this project.

  const NM_PER_DEG_LAT = 60;
  function nmPerDegLon(atLat) {
    return NM_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180);
  }

  const canvas = document.getElementById('radar-canvas');
  const ctx = canvas.getContext('2d');
  const radarCount = document.getElementById('radar-count');
  const airportSelect = document.getElementById('radar-airport-select');
  const stationInfo = document.getElementById('radar-station-info');
  const timeEl = document.getElementById('radar-time');

  let airports = [];
  let groundLayouts = {}; // icao -> real chart-derived runway/taxiway layout, see groundlayouts.json
  let origin = null; // { lat, lon } - centroid of all airports, NM offsets are relative to this
  let selectedAirport = null; // one entry from `airports`, or null for the fleet-wide overview
  let view = null; // { centerNorth, centerEast, radiusNm } - current viewport in NM space
  let aircraft = [];
  let groundZoom = false; // tight zoom for reading runway/taxiway labels, vs. the normal approach-scope

  // Colored world-map background (water/islands) for the fleet-wide
  // overview only - see worldmap.json's comment in
  // scripts/build-worldmap.js for how it's calibrated. Only sensible at
  // the overview scale: the source chart is explicitly "NOT TO SCALE",
  // so at a station's tight zoom the few-NM fit error would dwarf the
  // whole visible viewport.
  let worldMapImage = null;
  let worldMapTransform = null; // { a, b, c, d, e, f } - see build-worldmap.js

  const groundZoomBtn = document.getElementById('ground-zoom-btn');
  groundZoomBtn.addEventListener('click', () => {
    groundZoom = !groundZoom;
    groundZoomBtn.classList.toggle('active', groundZoom);
    recomputeView();
  });

  function toNm(point) {
    return {
      north: (point.lat - origin.lat) * NM_PER_DEG_LAT,
      east: (point.lon - origin.lon) * nmPerDegLon(origin.lat),
    };
  }

  // A per-station scope (like a real TRACON display for one field) when a
  // station is selected, or the whole known world fit to the canvas
  // otherwise. Both are expressed the same way - a center + radius in NM -
  // so project()/unproject() don't need to know which mode is active.
  //
  // The station scope itself has two zoom levels: the normal 10nm approach
  // scope (this whole game world only spans ~30nm across, so even that
  // needs to be tight to read as "zoomed in" rather than a token re-center)
  // and a much tighter "GND" zoom for actually reading runway/taxiway
  // layout - the whole schematic ground diagram is only ~1.2nm across, so
  // at 10nm radius it's a barely-visible smudge.
  const STATION_RADIUS_NM = 10;
  const GROUND_ZOOM_RADIUS_NM = 2;

  function recomputeView() {
    if (selectedAirport) {
      const c = toNm(selectedAirport);
      view = { centerNorth: c.north, centerEast: c.east, radiusNm: groundZoom ? GROUND_ZOOM_RADIUS_NM : STATION_RADIUS_NM };
    } else {
      const nmPoints = airports.map(toNm);
      const minNorth = Math.min(...nmPoints.map((p) => p.north));
      const maxNorth = Math.max(...nmPoints.map((p) => p.north));
      const minEast = Math.min(...nmPoints.map((p) => p.east));
      const maxEast = Math.max(...nmPoints.map((p) => p.east));
      const pad = 8;
      view = {
        centerNorth: (minNorth + maxNorth) / 2,
        centerEast: (minEast + maxEast) / 2,
        radiusNm: Math.max(maxNorth - minNorth, maxEast - minEast) / 2 + pad,
      };
    }
    draw();
  }

  // Free zoom on top of the preset scopes above - scroll/pinch to zoom in
  // past the GND preset for a single gate, or out past the overview to
  // see the whole map smaller. Zooms toward the cursor (the NM point under
  // the pointer stays under the pointer) rather than re-centering on the
  // station, since that's what every other map UI does and re-centering
  // on every scroll tick would make it impossible to pan by zooming.
  const MIN_RADIUS_NM = 0.05;
  const MAX_RADIUS_NM = 60;

  function zoomAt(pixel, factor) {
    if (!view) return;
    const pivot = unproject(pixel);
    const newRadius = Math.min(MAX_RADIUS_NM, Math.max(MIN_RADIUS_NM, view.radiusNm * factor));
    const ratio = newRadius / view.radiusNm;
    view.centerNorth = pivot.north - (pivot.north - view.centerNorth) * ratio;
    view.centerEast = pivot.east - (pivot.east - view.centerEast) * ratio;
    view.radiusNm = newRadius;
    groundZoomBtn.classList.remove('active'); // no longer necessarily at the GND preset
    draw();
  }

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!view) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const pixel = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // deltaY > 0 (scrolling down / pinching out) zooms out.
      const factor = Math.exp(e.deltaY * 0.0015);
      zoomAt(pixel, factor);
    },
    { passive: false }
  );

  // Square viewport (equal NM per pixel in both directions, so bearings
  // aren't distorted) centered on `view`.
  function project(nm) {
    const scale = Math.min(canvas.clientWidth, canvas.clientHeight) / (view.radiusNm * 2);
    return {
      x: canvas.clientWidth / 2 + (nm.east - view.centerEast) * scale,
      y: canvas.clientHeight / 2 - (nm.north - view.centerNorth) * scale,
    };
  }

  function unproject(pixel) {
    const scale = Math.min(canvas.clientWidth, canvas.clientHeight) / (view.radiusNm * 2);
    return {
      east: view.centerEast + (pixel.x - canvas.clientWidth / 2) / scale,
      north: view.centerNorth - (pixel.y - canvas.clientHeight / 2) / scale,
    };
  }

  async function loadAirports() {
    const [airportsRes, groundLayoutsRes, worldMapRes] = await Promise.all([
      fetch('airports.json'),
      fetch('groundlayouts.json'),
      fetch('worldmap.json'),
    ]);
    airports = await airportsRes.json();
    groundLayouts = groundLayoutsRes.ok ? await groundLayoutsRes.json() : {};
    if (worldMapRes.ok) {
      const worldMap = await worldMapRes.json();
      worldMapTransform = worldMap.transform;
      worldMapImage = new Image();
      worldMapImage.onload = draw;
      worldMapImage.src = 'worldmap.png';
    }
    if (airports.length === 0) return;

    origin = {
      lat: airports.reduce((sum, a) => sum + a.lat, 0) / airports.length,
      lon: airports.reduce((sum, a) => sum + a.lon, 0) / airports.length,
    };

    airportSelect.innerHTML = '<option value="">ALL (overview)</option>';
    for (const airport of airports) {
      const opt = document.createElement('option');
      opt.value = airport.icao;
      opt.textContent = airport.icao;
      airportSelect.appendChild(opt);
    }

    recomputeView();
  }

  function updateStationInfo() {
    if (!selectedAirport) {
      stationInfo.textContent = '';
      return;
    }
    const freqText = selectedAirport.frequencies.map((f) => `${f.facility} ${f.frequency}`).join(' · ');
    const rwyText =
      selectedAirport.runways.length > 0
        ? `RWY ${selectedAirport.runways.map((r) => r.designator).join('/')}`
        : 'no runway data';
    stationInfo.textContent = `${selectedAirport.name} — ${rwyText}${freqText ? ' — ' + freqText : ''}`;
  }

  airportSelect.addEventListener('change', () => {
    selectedAirport = airports.find((a) => a.icao === airportSelect.value) || null;
    groundZoomBtn.disabled = !selectedAirport;
    groundZoom = false;
    groundZoomBtn.classList.remove('active');
    updateStationInfo();
    populateAtisRunways();
    recomputeView();
  });

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  // Runway/taxiway rendering for the selected station only - at the
  // whole-world overview scale these would be sub-pixel anyway.
  //
  // Two tiers, depending on what groundlayouts.json has for this airport
  // (built by scripts/build-ground-layouts.js from the real chart SVGs):
  //
  // 1. Calibrated: real threshold-to-threshold runway lines and real,
  //    correctly-lettered/numbered taxiway polylines, positioned from the
  //    actual chart artwork and rotated to true north using that airport's
  //    own real runway heading as the calibration anchor. Still uniformly
  //    rescaled (not survey-accurate scale/distance) so a small strip's
  //    taxiways aren't sub-pixel next to a mile-long runway.
  // 2. Fallback (no chart source resolved cleanly - e.g. IBAR/SHV/TVO/IUFO):
  //    a fixed-length schematic line through the airport's single reference
  //    point along the runway's real heading - correct direction, but
  //    illustrative position/length, and no taxiways.
  const RUNWAY_HALF_LENGTH_NM = 0.6;

  function drawGroundLayout() {
    if (!selectedAirport) return;
    const layout = groundLayouts[selectedAirport.icao];
    if (layout && layout.calibrated) {
      drawCalibratedLayout(selectedAirport, layout);
    } else {
      drawSchematicRunways(selectedAirport);
    }
  }

  function toScreen(center, offset) {
    return project({ north: center.north + offset.north, east: center.east + offset.east });
  }

  function drawCalibratedLayout(airport, layout) {
    const center = toNm(airport);

    // The chart's own real line art - taxiway centerlines, apron/pavement
    // outlines, buildings, hold markings, the runway's own drawn shape -
    // traced directly from the source SVG and rotated/scaled into this
    // view by scripts/build-ground-layouts.js. Stroke-only (no fill), so
    // what were solid black/gray chart fills come out as outlines - close
    // to how a real ATC ground radar overlay looks.
    ctx.strokeStyle = '#5a6270';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const sub of layout.tracedPaths || []) {
      if (sub.length < 2) continue;
      const p0 = toScreen(center, sub[0]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < sub.length; i++) {
        const p = toScreen(center, sub[i]);
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();

    // Taxiway letter/connector labels, read straight off the chart at
    // their real position (every real occurrence, not deduplicated - a
    // taxiway's letter repeats along its length on the real chart too).
    ctx.font = '9px -apple-system, sans-serif';
    ctx.fillStyle = '#9aa3b2';
    for (const label of layout.taxiwayLabels || []) {
      const p = toScreen(center, label);
      ctx.fillText(label.text, p.x + 3, p.y - 3);
    }

    ctx.strokeStyle = '#e4e7ec';
    ctx.lineWidth = 2;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillStyle = '#e4e7ec';
    for (const [designatorA, designatorB] of layout.runwayLines) {
      const a = layout.points[`RWY_${designatorA}`];
      const b = layout.points[`RWY_${designatorB}`];
      if (!a || !b) continue;
      const pa = toScreen(center, a);
      const pb = toScreen(center, b);
      ctx.fillText(designatorA, pa.x + 5, pa.y + 3);
      ctx.fillText(designatorB, pb.x + 5, pb.y + 3);
    }
  }

  function drawSchematicRunways(airport) {
    const center = toNm(airport);

    for (const rwy of airport.runways) {
      if (typeof rwy.headingDeg !== 'number' || Number.isNaN(rwy.headingDeg)) continue;
      const rad = (rwy.headingDeg * Math.PI) / 180;
      const dNorth = RUNWAY_HALF_LENGTH_NM * Math.cos(rad);
      const dEast = RUNWAY_HALF_LENGTH_NM * Math.sin(rad);
      const farEnd = project({ north: center.north + dNorth, east: center.east + dEast });
      const nearEnd = project({ north: center.north - dNorth, east: center.east - dEast });

      ctx.strokeStyle = '#e4e7ec';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(nearEnd.x, nearEnd.y);
      ctx.lineTo(farEnd.x, farEnd.y);
      ctx.stroke();

      ctx.font = '10px -apple-system, sans-serif';
      ctx.fillStyle = '#e4e7ec';
      ctx.fillText(rwy.designator, farEnd.x + 5, farEnd.y + 3);
    }
  }

  // Draws the calibrated world-map PNG under everything else, only for
  // the fleet-wide overview (see the `worldMapImage` comment above for
  // why not at a station's tight zoom). The composed transform maps the
  // image's own pixel space directly to canvas pixels in one step: the
  // fitted (pixel -> NM) affine from build-worldmap.js, chained with
  // project()'s (NM -> canvas pixel) similarity transform, worked out
  // algebraically so this is a single ctx.transform() call rather than
  // per-pixel math.
  function drawWorldMap() {
    if (selectedAirport || !worldMapImage || !worldMapImage.complete || !worldMapTransform) return;
    const t = worldMapTransform;
    const scale = Math.min(canvas.clientWidth, canvas.clientHeight) / (view.radiusNm * 2);
    ctx.save();
    ctx.transform(
      scale * t.c, -scale * t.a,
      scale * t.d, -scale * t.b,
      canvas.clientWidth / 2 + scale * (t.f - view.centerEast),
      canvas.clientHeight / 2 + scale * (view.centerNorth - t.e)
    );
    ctx.drawImage(worldMapImage, 0, 0);
    ctx.restore();
  }

  function draw() {
    if (!origin || !view) return;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    drawWorldMap();

    ctx.font = '11px -apple-system, sans-serif';
    for (const airport of airports) {
      const p = project(toNm(airport));
      const isSelected = selectedAirport && airport.icao === selectedAirport.icao;
      ctx.fillStyle = isSelected ? '#4f8cff' : '#565d6b';
      ctx.beginPath();
      ctx.arc(p.x, p.y, isSelected ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = isSelected ? '#4f8cff' : '#8b94a3';
      ctx.fillText(airport.icao, p.x + 6, p.y + 4);
    }

    drawGroundLayout();

    for (const ac of aircraft) {
      const airport = airports.find((a) => a.icao === ac.position.referenceAirport);
      if (!airport || typeof ac.position.distanceNm !== 'number' || typeof ac.position.bearingDeg !== 'number') continue;

      const bearingRad = (ac.position.bearingDeg * Math.PI) / 180;
      const airportNm = toNm(airport);
      const acNm = {
        north: airportNm.north + ac.position.distanceNm * Math.cos(bearingRad),
        east: airportNm.east + ac.position.distanceNm * Math.sin(bearingRad),
      };
      const p = project(acNm);

      const stale = typeof ac.position.fixAgeSec === 'number' && ac.position.fixAgeSec >= 120;
      const color = stale ? '#565d6b' : '#4f8cff';

      ctx.save();
      ctx.translate(p.x, p.y);
      if (typeof ac.position.headingDeg === 'number') ctx.rotate((ac.position.headingDeg * Math.PI) / 180);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4, 5);
      ctx.lineTo(-4, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = color;
      const altText = typeof ac.position.altitudeFt === 'number' ? `${ac.position.altitudeFt}ft` : '';
      ctx.fillText(`${ac.callsign} ${altText}`.trim(), p.x + 8, p.y - 8);
    }

    drawVectors();
  }

  async function pollAircraft() {
    try {
      const res = await fetch('/api/dashboard/positions');
      if (!res.ok) return;
      aircraft = (await res.json()).filter((ac) => ac.position);
      radarCount.textContent = `${aircraft.length} tracked`;
      draw();
    } catch {
      // radar just goes stale until the next successful poll - non-fatal
    }
  }

  // ---------- Generic overlay open/close ----------

  function openOverlay(id) {
    document.getElementById(id).classList.add('show');
  }
  document.querySelectorAll('.overlay .close-btn').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('.overlay').classList.remove('show'));
  });

  // ---------- Notepad (per-device scratch pad, not shared) ----------

  const notepadInput = document.getElementById('notepad-input');
  notepadInput.value = localStorage.getItem('autoatc-notepad') || '';
  notepadInput.addEventListener('input', () => localStorage.setItem('autoatc-notepad', notepadInput.value));
  document.getElementById('notepad-btn').addEventListener('click', () => openOverlay('notepad-overlay'));

  // ---------- Vectoring tool ----------
  // Vectors are stored in NM space (not pixels), so they stay correctly
  // placed as the view pans/zooms between stations.

  let vectors = []; // { a: {north, east}, b: {north, east}, color }
  let vectorDrawing = false;
  let vectorPendingPoint = null; // the first click of the current in-progress vector

  function drawVectors() {
    const showDistance = document.getElementById('vector-show-distance').checked;
    const directionOnly = document.getElementById('vector-direction-only').checked;

    for (const v of vectors) {
      const a = project(v.a);
      const b = project(v.b);
      ctx.strokeStyle = v.color;
      ctx.fillStyle = v.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      const dNorth = v.b.north - v.a.north;
      const dEast = v.b.east - v.a.east;
      const distanceNm = Math.sqrt(dNorth * dNorth + dEast * dEast);
      let headingDeg = (Math.atan2(dEast, dNorth) * 180) / Math.PI;
      if (headingDeg < 0) headingDeg += 360;

      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate((headingDeg * Math.PI) / 180);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-4, -8);
      ctx.lineTo(4, -8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      if (!directionOnly) {
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const label = showDistance ? `${Math.round(headingDeg)}° ${distanceNm.toFixed(1)}nm` : `${Math.round(headingDeg)}°`;
        ctx.font = '11px -apple-system, sans-serif';
        ctx.fillText(label, midX + 4, midY - 4);
      }
    }
  }

  canvas.addEventListener('click', (e) => {
    if (!vectorDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const point = unproject({ x: e.clientX - rect.left, y: e.clientY - rect.top });

    if (!vectorPendingPoint) {
      vectorPendingPoint = point;
    } else {
      vectors.push({ a: vectorPendingPoint, b: point, color: document.getElementById('vector-color').value });
      vectorPendingPoint = null;
      draw();
    }
  });

  document.getElementById('vector-btn').addEventListener('click', () => openOverlay('vector-overlay'));
  document.getElementById('vector-start-btn').addEventListener('click', (e) => {
    vectorDrawing = !vectorDrawing;
    vectorPendingPoint = null;
    e.target.textContent = vectorDrawing ? 'Stop drawing' : 'Start drawing';
  });
  document.getElementById('vector-clear-btn').addEventListener('click', () => {
    vectors = [];
    draw();
  });
  document.getElementById('vector-show-distance').addEventListener('change', draw);
  document.getElementById('vector-direction-only').addEventListener('change', draw);
  document.getElementById('vector-export-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(vectors));
    } catch {
      // clipboard access can be denied by the browser - nothing more to do here
    }
  });
  document.getElementById('vector-import-btn').addEventListener('click', () => {
    const raw = prompt('Paste exported vector JSON:');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        vectors = parsed;
        draw();
      }
    } catch {
      alert('That was not valid vector JSON.');
    }
  });

  // ---------- ATIS generator ----------
  // Purely a text-composition tool - QNH/runway/remarks in, a formatted
  // ATIS string out, copied to the clipboard. Mirrors the phraseology
  // src/bot/AtisBot.js uses for the real spoken ATIS, so a manually
  // generated one reads the same way.

  const atisLetterSelect = document.getElementById('atis-letter');
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const opt = document.createElement('option');
    opt.value = letter;
    opt.textContent = letter;
    atisLetterSelect.appendChild(opt);
  }

  function populateAtisRunways() {
    const runways = selectedAirport ? selectedAirport.runways : [];
    for (const id of ['atis-arr-rwy', 'atis-dep-rwy']) {
      const select = document.getElementById(id);
      select.innerHTML = '';
      for (const rwy of runways) {
        const opt = document.createElement('option');
        opt.value = rwy.designator;
        opt.textContent = rwy.designator;
        select.appendChild(opt);
      }
    }
  }

  function selectedOptions(select) {
    return [...select.selectedOptions].map((o) => o.value);
  }

  document.getElementById('atis-btn').addEventListener('click', () => openOverlay('atis-overlay'));
  document.getElementById('atis-copy-btn').addEventListener('click', async () => {
    const letter = atisLetterSelect.value;
    const qnh = document.getElementById('atis-qnh').value;
    const arrRwy = selectedOptions(document.getElementById('atis-arr-rwy'));
    const depRwy = selectedOptions(document.getElementById('atis-dep-rwy'));
    const remarks = document.getElementById('atis-remarks').value.trim();

    const parts = [`Information ${letter}.`];
    if (qnh) parts.push(`QNH ${qnh}.`);
    if (arrRwy.length > 0) parts.push(`Landing runway ${arrRwy.join(' and ')}.`);
    if (depRwy.length > 0) parts.push(`Departing runway ${depRwy.join(' and ')}.`);
    if (remarks) parts.push(remarks);
    parts.push(`Advise on initial contact you have information ${letter}.`);

    const text = parts.join(' ');
    document.getElementById('atis-output').textContent = text;

    const copiedHint = document.getElementById('atis-copied');
    try {
      await navigator.clipboard.writeText(text);
      copiedHint.textContent = 'Copied!';
    } catch {
      copiedHint.textContent = 'Could not copy automatically - select the text above.';
    }
    setTimeout(() => (copiedHint.textContent = ''), 3000);
  });

  // ---------- Flight strips ----------

  let stripsPollTimer = null;

  async function refreshStrips() {
    try {
      const res = await fetch('/api/dashboard/flightstrips');
      if (!res.ok) return;
      const strips = await res.json();
      const tbody = document.getElementById('strips-tbody');
      tbody.innerHTML = '';
      for (const s of strips) {
        const c = s.clearance || {};
        const row = document.createElement('tr');
        const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : '';
        row.innerHTML = [
          s.callsign,
          s.aircraftType || '',
          s.currentPosition || '',
          c.destination || '',
          c.initialClimbAltitude || '',
          c.squawk || '',
          c.departureFreq || '',
          updated,
        ]
          .map((v) => `<td>${String(v).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]))}</td>`)
          .join('');
        tbody.appendChild(row);
      }
    } catch {
      // table just goes stale until the next successful poll - non-fatal
    }
  }

  document.getElementById('strips-btn').addEventListener('click', () => {
    openOverlay('strips-overlay');
    refreshStrips();
    clearInterval(stripsPollTimer);
    stripsPollTimer = setInterval(refreshStrips, 5000);
  });
  document.querySelector('#strips-overlay .close-btn').addEventListener('click', () => clearInterval(stripsPollTimer));

  // ---------- Clock ----------

  function updateClock() {
    timeEl.textContent = `${new Date().toISOString().slice(11, 19)}Z`;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ---------- Tab switching ----------

  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `${tab.dataset.view}-panel`));
      if (tab.dataset.view === 'radar') resizeCanvas(); // canvas has no size while its panel was display:none
    });
  });

  loadAirports().then(() => {
    populateAtisRunways();
    draw();
    setInterval(pollAircraft, 3000);
    pollAircraft();
  });
})();
