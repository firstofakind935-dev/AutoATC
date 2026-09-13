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
  let origin = null; // { lat, lon } - centroid of all airports, NM offsets are relative to this
  let selectedAirport = null; // one entry from `airports`, or null for the fleet-wide overview
  let view = null; // { centerNorth, centerEast, radiusNm } - current viewport in NM space
  let aircraft = [];

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
  function recomputeView() {
    if (selectedAirport) {
      // This whole game world only spans ~30nm across, so a station's own
      // scope needs to be tight to actually read as "zoomed in" rather
      // than just re-centering on roughly the same view as the overview.
      const c = toNm(selectedAirport);
      view = { centerNorth: c.north, centerEast: c.east, radiusNm: 10 };
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
    const res = await fetch('airports.json');
    airports = await res.json();
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
    const rwyText = selectedAirport.runways.length > 0 ? `RWY ${selectedAirport.runways.join('/')}` : 'no runway data';
    stationInfo.textContent = `${selectedAirport.name} — ${rwyText}${freqText ? ' — ' + freqText : ''}`;
  }

  airportSelect.addEventListener('change', () => {
    selectedAirport = airports.find((a) => a.icao === airportSelect.value) || null;
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

  function draw() {
    if (!origin || !view) return;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

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
        opt.value = rwy;
        opt.textContent = rwy;
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
