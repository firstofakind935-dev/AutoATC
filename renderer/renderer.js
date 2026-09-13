// Renderer process - no Node/require here (contextIsolation is on); all
// app logic is reached through window.companion, exposed by preload.js.

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const octx = overlay.getContext('2d');

let settings = { callsign: '', monitorUrl: '', monitorApiKey: '', intervalSec: 5, regions: {} };
let airports = [];
let selectedSourceId = null;

// One of: null, 'select-heading', 'select-info', 'select-minimap',
// 'calib-a', 'calib-b', 'set-position'. Determines what a click/drag on the
// overlay canvas means right now.
let mode = null;
let dragStart = null;

let pendingCalibAirport = null; // the airport chosen for the calibration point currently being clicked
let calibration = null; // { refPoints: [{pixel, world}, {pixel, world}] }
let currentFix = null; // { world: {lat, lon}, atMs }
let lastCorrectionAtMs = null;
let trackingTimer = null;

// ---------- Settings ----------

async function loadSettings() {
  const saved = await window.companion.loadSettings();
  settings = { ...settings, ...saved };
  document.getElementById('callsign').value = settings.callsign || '';
  document.getElementById('monitorUrl').value = settings.monitorUrl || '';
  document.getElementById('monitorApiKey').value = settings.monitorApiKey || '';
  document.getElementById('intervalSec').value = settings.intervalSec || 5;
}

async function saveSettingsFromForm() {
  settings.callsign = document.getElementById('callsign').value.trim();
  settings.monitorUrl = document.getElementById('monitorUrl').value.trim();
  settings.monitorApiKey = document.getElementById('monitorApiKey').value.trim();
  settings.intervalSec = Number(document.getElementById('intervalSec').value) || 5;
  await window.companion.saveSettings(settings);
  document.getElementById('settingsStatus').textContent = 'Saved.';
  setTimeout(() => (document.getElementById('settingsStatus').textContent = ''), 2000);
}

document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);

// ---------- Source picker ----------

async function refreshSources() {
  const list = document.getElementById('sourceList');
  list.innerHTML = '<div class="name">Loading windows...</div>';
  let sources;
  try {
    sources = await window.companion.getSources();
  } catch (err) {
    list.innerHTML = `<div class="name">Could not list windows: ${err.message}</div>`;
    return;
  }
  list.innerHTML = '';
  if (sources.length === 0) {
    list.innerHTML = '<div class="name">No windows found. Make sure Roblox/PTFS is running (not minimized), then click Refresh windows again.</div>';
    return;
  }
  for (const source of sources) {
    const item = document.createElement('div');
    item.className = 'source-item' + (source.id === selectedSourceId ? ' selected' : '');
    item.innerHTML = `<img src="${source.thumbnailDataUrl}"><div class="name">${source.name}</div>`;
    item.addEventListener('click', () => selectSource(source.id));
    list.appendChild(item);
  }
}

async function selectSource(id) {
  selectedSourceId = id;
  refreshSources();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: id,
        },
      },
    });
  } catch (err) {
    document.getElementById('regionStatus').textContent = `Could not capture that window: ${err.message}`;
    return;
  }
  video.srcObject = stream;
  await video.play();

  overlay.width = video.clientWidth;
  overlay.height = video.clientHeight;
  document.getElementById('preview').hidden = false;
  document.getElementById('calibration').hidden = false;
  document.getElementById('tracking').hidden = false;
  drawSavedRegions();
}

document.getElementById('refreshSourcesBtn').addEventListener('click', refreshSources);

// ---------- Coordinate scaling (displayed canvas px -> native video px) ----------

function toNativePixel(displayX, displayY) {
  const scaleX = video.videoWidth / overlay.clientWidth;
  const scaleY = video.videoHeight / overlay.clientHeight;
  return { x: displayX * scaleX, y: displayY * scaleY };
}

function toDisplayRect(nativeRect) {
  const scaleX = overlay.clientWidth / video.videoWidth;
  const scaleY = overlay.clientHeight / video.videoHeight;
  return {
    x: nativeRect.x * scaleX,
    y: nativeRect.y * scaleY,
    w: nativeRect.w * scaleX,
    h: nativeRect.h * scaleY,
  };
}

function drawSavedRegions() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  octx.lineWidth = 2;
  const labels = [
    ['heading', '#e11d48'],
    ['info', '#2563eb'],
    ['minimap', '#16a34a'],
  ];
  for (const [key, color] of labels) {
    const region = settings.regions && settings.regions[key];
    if (!region) continue;
    const d = toDisplayRect(region);
    octx.strokeStyle = color;
    octx.strokeRect(d.x, d.y, d.w, d.h);
  }
}

// ---------- Region selection (drag) + calibration/position clicks (single click) ----------

overlay.addEventListener('mousedown', (e) => {
  if (!mode || !mode.startsWith('select-')) return;
  const rect = overlay.getBoundingClientRect();
  dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
});

overlay.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  const rect = overlay.getBoundingClientRect();
  const current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  drawSavedRegions();
  octx.strokeStyle = '#f59e0b';
  octx.lineWidth = 2;
  octx.strokeRect(dragStart.x, dragStart.y, current.x - dragStart.x, current.y - dragStart.y);
});

overlay.addEventListener('mouseup', async (e) => {
  const rect = overlay.getBoundingClientRect();
  const displayPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };

  if (mode && mode.startsWith('select-') && dragStart) {
    const x0 = Math.min(dragStart.x, displayPoint.x);
    const y0 = Math.min(dragStart.y, displayPoint.y);
    const w = Math.abs(displayPoint.x - dragStart.x);
    const h = Math.abs(displayPoint.y - dragStart.y);
    dragStart = null;

    if (w < 5 || h < 5) return; // treat as an accidental click, not a real region

    const topLeft = toNativePixel(x0, y0);
    const bottomRight = toNativePixel(x0 + w, y0 + h);
    const key = mode.replace('select-', '');
    settings.regions = settings.regions || {};
    settings.regions[key] = {
      x: topLeft.x,
      y: topLeft.y,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y,
    };
    await window.companion.saveSettings(settings);
    document.getElementById('regionStatus').textContent = `${key} region saved.`;
    mode = null;
    drawSavedRegions();
    return;
  }

  if (mode === 'calib-a' || mode === 'calib-b') {
    const pixel = toNativePixel(displayPoint.x, displayPoint.y);
    const point = { pixel, world: pendingCalibAirport.world };
    if (mode === 'calib-a') {
      calibration = { refPoints: [point, null] };
      mode = 'calib-b';
      pendingCalibAirport = airports.find((a) => a.icao === document.getElementById('airportB').value);
      document.getElementById('calibrationStatus').textContent = 'Now click Airport B on the minimap.';
    } else {
      calibration.refPoints[1] = point;
      mode = null;
      document.getElementById('calibrationStatus').textContent = 'Calibrated.';
      document.getElementById('setPositionBtn').disabled = false;
    }
    return;
  }

  if (mode === 'set-position') {
    const pixel = toNativePixel(displayPoint.x, displayPoint.y);
    const world = await window.companion.projectPixel(calibration.refPoints, pixel);
    const nearest = await window.companion.nearestAirport(airports, world);
    currentFix = { world, atMs: Date.now() };
    lastCorrectionAtMs = Date.now();
    document.getElementById('fixStatus').textContent =
      `Fix set: ~${nearest.distanceNm.toFixed(1)}nm bearing ${Math.round(nearest.bearingDeg)}° from ${nearest.icao}`;
    mode = null;
  }
});

document.getElementById('selectHeadingBtn').addEventListener('click', () => {
  mode = 'select-heading';
  document.getElementById('regionStatus').textContent = 'Drag a box over the heading/compass readout...';
});
document.getElementById('selectInfoBtn').addEventListener('click', () => {
  mode = 'select-info';
  document.getElementById('regionStatus').textContent = 'Drag a box over the aircraft type/speed/altitude box...';
});
document.getElementById('selectMinimapBtn').addEventListener('click', () => {
  mode = 'select-minimap';
  document.getElementById('regionStatus').textContent = 'Drag a box over the minimap...';
});

document.getElementById('calibrateBtn').addEventListener('click', () => {
  const icaoA = document.getElementById('airportA').value;
  const icaoB = document.getElementById('airportB').value;
  if (!icaoA || !icaoB || icaoA === icaoB) {
    document.getElementById('calibrationStatus').textContent = 'Pick two different airports first.';
    return;
  }
  pendingCalibAirport = airports.find((a) => a.icao === icaoA);
  mode = 'calib-a';
  document.getElementById('calibrationStatus').textContent = 'Click Airport A on the minimap.';
});

document.getElementById('setPositionBtn').addEventListener('click', () => {
  if (!calibration) return;
  mode = 'set-position';
  document.getElementById('fixStatus').textContent = 'Click your aircraft marker on the minimap...';
});

// ---------- Airports dropdowns ----------

async function populateAirportDropdowns() {
  airports = await window.companion.getAirports();
  for (const selectId of ['airportA', 'airportB']) {
    const select = document.getElementById(selectId);
    select.innerHTML = '<option value="">-- select --</option>';
    for (const airport of airports) {
      const opt = document.createElement('option');
      opt.value = airport.icao;
      opt.textContent = `${airport.icao} - ${airport.name}`;
      select.appendChild(opt);
    }
  }
}

// ---------- Tracking loop ----------

function log(message) {
  const el = document.getElementById('trackingStatus');
  const line = `${new Date().toLocaleTimeString()}  ${message}`;
  el.textContent = `${line}\n${el.textContent}`.slice(0, 8000);
}

async function ocrRegion(sourceCanvas, region) {
  if (!region) return '';
  const cropped = document.createElement('canvas');
  cropped.width = Math.max(1, Math.round(region.w));
  cropped.height = Math.max(1, Math.round(region.h));
  cropped
    .getContext('2d')
    .drawImage(sourceCanvas, region.x, region.y, region.w, region.h, 0, 0, cropped.width, cropped.height);
  return window.companion.recognizeText(cropped.toDataURL('image/png'));
}

async function trackTick() {
  if (!settings.regions || !settings.regions.heading || !settings.regions.info) {
    log('Skipping - heading/info regions not set yet.');
    return;
  }
  if (!currentFix) {
    log('Skipping - no position fix yet. Click "Set my position" first.');
    return;
  }
  if (!settings.monitorUrl) {
    log('Skipping - no Monitor URL set in settings.');
    return;
  }

  const frame = document.createElement('canvas');
  frame.width = video.videoWidth;
  frame.height = video.videoHeight;
  frame.getContext('2d').drawImage(video, 0, 0);

  const [headingText, infoText] = await Promise.all([
    ocrRegion(frame, settings.regions.heading),
    ocrRegion(frame, settings.regions.info),
  ]);

  const heading = window.companion.parseHeadingTape(headingText);
  const info = window.companion.parseFlightInfo(infoText);

  if (heading == null || info.speedKts == null) {
    log(`Could not read heading/speed cleanly (heading OCR: "${headingText.replace(/\n/g, ' ')}", info OCR: "${infoText.replace(/\n/g, ' ')}") - skipping tick.`);
    return;
  }

  const now = Date.now();
  currentFix = await window.companion.integrate(currentFix, { headingDeg: heading, speedKts: info.speedKts, atMs: now });

  const nearest = await window.companion.nearestAirport(airports, currentFix.world);
  const fixAgeSec = (now - lastCorrectionAtMs) / 1000;

  try {
    await window.companion.uploadPosition({
      monitorUrl: settings.monitorUrl,
      apiKey: settings.monitorApiKey || null,
      callsign: settings.callsign,
      aircraftType: info.aircraftType,
      speed: info.speedKts,
      distanceNm: nearest.distanceNm,
      bearingDeg: nearest.bearingDeg,
      referenceAirport: nearest.icao,
      altitudeFt: info.altitudeFt,
      headingDeg: heading,
      fixAgeSec,
    });
    log(
      `Uploaded: ${nearest.distanceNm.toFixed(1)}nm brg ${Math.round(nearest.bearingDeg)}° from ${nearest.icao}, ` +
        `${info.altitudeFt}ft, hdg ${heading}°, ${info.speedKts}kts, ${info.aircraftType || '?'} (fix age ${Math.round(fixAgeSec)}s)`
    );
  } catch (err) {
    log(`Upload failed: ${err.message}`);
  }
}

document.getElementById('startTrackingBtn').addEventListener('click', () => {
  if (trackingTimer) return;
  trackingTimer = setInterval(trackTick, Math.max(2, settings.intervalSec || 5) * 1000);
  trackTick();
  document.getElementById('startTrackingBtn').disabled = true;
  document.getElementById('stopTrackingBtn').disabled = false;
  log('Tracking started.');
});

document.getElementById('stopTrackingBtn').addEventListener('click', () => {
  clearInterval(trackingTimer);
  trackingTimer = null;
  document.getElementById('startTrackingBtn').disabled = false;
  document.getElementById('stopTrackingBtn').disabled = true;
  log('Tracking stopped.');
});

// ---------- Init ----------

function showLoadErrors() {
  const errors = window.companion && window.companion.loadErrors;
  if (!errors || Object.keys(errors).length === 0) return;
  const banner = document.createElement('pre');
  banner.style.cssText = 'background:#fee2e2;color:#991b1b;padding:10px;border-radius:6px;white-space:pre-wrap;';
  banner.textContent =
    'Some companion app modules failed to load - the features below that depend on them won\'t work:\n\n' +
    Object.entries(errors)
      .map(([name, err]) => `[${name}]\n${err}`)
      .join('\n\n');
  document.body.insertBefore(banner, document.body.firstChild.nextSibling);
}

(async function init() {
  if (!window.companion) {
    const banner = document.createElement('pre');
    banner.style.cssText = 'background:#fee2e2;color:#991b1b;padding:10px;border-radius:6px;white-space:pre-wrap;';
    banner.textContent =
      'The companion app failed to initialize (window.companion is missing) - ' +
      'the preload script did not run. Check the terminal you ran "npm start" ' +
      'from for an error, or run with COMPANION_DEVTOOLS=1 and check the DevTools console.';
    document.body.insertBefore(banner, document.body.firstChild.nextSibling);
    return;
  }
  showLoadErrors();
  await loadSettings();
  await populateAirportDropdowns();
  await refreshSources();
})();
