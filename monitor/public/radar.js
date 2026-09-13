(function () {
  // Live traffic map for controllers - so watching the board doesn't
  // require actually being in the game. Airports are fixed reference
  // points (loaded once from airports.json, generated from this repo's
  // chart data); aircraft are plotted from the same distance/bearing/
  // referenceAirport shape the bot fleet already consumes (src/atc/
  // positions.js), converted back to an absolute offset with the same
  // flat-earth math used everywhere else in this project.

  const NM_PER_DEG_LAT = 60;
  function nmPerDegLon(atLat) {
    return NM_PER_DEG_LAT * Math.cos((atLat * Math.PI) / 180);
  }

  const canvas = document.getElementById('radar-canvas');
  const ctx = canvas.getContext('2d');
  const radarCount = document.getElementById('radar-count');

  let airports = [];
  let origin = null; // { lat, lon } - centroid of all airports, NM offsets are relative to this
  let bounds = null; // { minNorth, maxNorth, minEast, maxEast } across all airports, with padding
  let aircraft = [];

  function toNm(point) {
    return {
      north: (point.lat - origin.lat) * NM_PER_DEG_LAT,
      east: (point.lon - origin.lon) * nmPerDegLon(origin.lat),
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

    const nmPoints = airports.map((a) => toNm(a));
    const pad = 8; // nm of breathing room around the outermost airports
    bounds = {
      minNorth: Math.min(...nmPoints.map((p) => p.north)) - pad,
      maxNorth: Math.max(...nmPoints.map((p) => p.north)) + pad,
      minEast: Math.min(...nmPoints.map((p) => p.east)) - pad,
      maxEast: Math.max(...nmPoints.map((p) => p.east)) + pad,
    };
  }

  // Maps an NM offset to canvas pixel coordinates, fit to the current
  // canvas size while preserving aspect ratio (letterboxed, not stretched -
  // this is real distance in both directions, distorting it would make
  // bearings look wrong).
  function project(nm) {
    const spanNorth = bounds.maxNorth - bounds.minNorth;
    const spanEast = bounds.maxEast - bounds.minEast;
    const scale = Math.min(canvas.clientWidth / spanEast, canvas.clientHeight / spanNorth);
    const offsetX = (canvas.clientWidth - spanEast * scale) / 2;
    const offsetY = (canvas.clientHeight - spanNorth * scale) / 2;
    return {
      x: offsetX + (nm.east - bounds.minEast) * scale,
      // North is "up" on a map, but canvas y grows downward.
      y: canvas.clientHeight - offsetY - (nm.north - bounds.minNorth) * scale,
    };
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  window.addEventListener('resize', resizeCanvas);

  function draw() {
    if (!origin || !bounds) return;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    ctx.font = '11px -apple-system, sans-serif';
    for (const airport of airports) {
      const p = project(toNm(airport));
      ctx.fillStyle = '#565d6b';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8b94a3';
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

  // ---------- Tab switching ----------

  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.view-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `${tab.dataset.view}-panel`));
      if (tab.dataset.view === 'radar') resizeCanvas(); // canvas has no size while its panel was display:none
    });
  });

  loadAirports().then(() => {
    draw();
    setInterval(pollAircraft, 3000);
    pollAircraft();
  });
})();
