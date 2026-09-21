// Runs in the small control window - no Node/require here (contextIsolation
// is on); all app logic is reached through window.companion, exposed by
// preload.js. The actual region/calibration clicks happen in the separate
// overlay window (renderer/overlay.js); this file arms/disarms it and
// reacts to what it reports back over IPC.

let settings = { callsign: '', monitorUrl: '', monitorApiKey: '', intervalSec: 5, regions: {} };
let airports = [];
let displays = [];
let overlayInfo = null; // { id, bounds, scaleFactor } for the currently-shown overlay

let pendingCalibAirport = null; // the airport for the calibration point currently being clicked
let calibration = null; // { refPoints: [{pixel, world}, {pixel, world}] }
let currentFix = null; // { world: {lat, lon}, atMs }
let lastCorrectionAtMs = null;
let trackingTimer = null;
let lastFixSummary = null;
let lastCpdlcId = 0;
const CPDLC_POLL_MS = 3000;

// Hidden video element used purely as a frame source for OCR - there's no
// visible preview anymore, since the real screen showing through the
// transparent overlay already is the preview.
const captureVideo = document.createElement('video');
captureVideo.muted = true;

// ---------- Status helpers (status pills + the sidebar status rail) ----------

function setStatus(id, text, tone) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.remove('ok', 'warn', 'bad');
  if (tone) el.classList.add(tone);
}

function setSidebar(dotId, textId, text, tone) {
  document.getElementById(textId).textContent = text;
  const dot = document.getElementById(dotId);
  dot.classList.remove('good', 'warn', 'bad');
  if (tone) dot.classList.add(tone);
}

// Mirrors current tracking/fix state into the overlay's top bar, so it
// stays useful as a quick glance while actually flying, without needing
// the control window in focus.
function syncBar() {
  window.companion.sendToOverlay({
    type: 'set-bar-status',
    tracking: Boolean(trackingTimer),
    fixSummary: lastFixSummary,
  });
}

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
  setStatus('settingsStatus', 'Saved.', 'ok');
  setTimeout(() => setStatus('settingsStatus', '', null), 2000);
}

document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsFromForm);

// ---------- Display picker + overlay ----------

async function populateDisplays() {
  displays = await window.companion.getDisplays();
  const select = document.getElementById('displaySelect');
  select.innerHTML = '';
  for (const display of displays) {
    const opt = document.createElement('option');
    opt.value = String(display.id);
    opt.textContent = display.label;
    select.appendChild(opt);
  }
}

async function showOverlay() {
  const displayId = Number(document.getElementById('displaySelect').value);
  overlayInfo = await window.companion.createOverlay(displayId);

  const screenSources = await window.companion.getScreenSources();
  const match = screenSources.find((s) => String(s.display_id) === String(displayId)) || screenSources[0];
  if (!match) {
    setStatus('overlayStatus', 'Overlay shown, but could not find a matching screen capture source.', 'bad');
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: match.id,
      },
    },
  });
  captureVideo.srcObject = stream;
  await captureVideo.play();

  setStatus('overlayStatus', `Overlay shown on ${overlayInfo.bounds.width}x${overlayInfo.bounds.height}.`, 'ok');
  setSidebar('dotOverlay', 'sidebarOverlayText', `${overlayInfo.bounds.width}x${overlayInfo.bounds.height}`, 'good');
  document.getElementById('hideOverlayBtn').disabled = false;
  document.getElementById('regions').hidden = false;
  document.getElementById('calibration').hidden = false;
  document.getElementById('tracking').hidden = false;

  sendRegionsToOverlay();
  syncBar();
  pushRadioStateToOverlay();
}

async function hideOverlay() {
  await window.companion.closeOverlay();
  overlayInfo = null;
  setStatus('overlayStatus', 'Overlay not shown', null);
  setSidebar('dotOverlay', 'sidebarOverlayText', 'Not shown', null);
  document.getElementById('hideOverlayBtn').disabled = true;
}

document.getElementById('showOverlayBtn').addEventListener('click', () => {
  showOverlay().catch((err) => {
    setStatus('overlayStatus', `Could not show overlay: ${err.message}`, 'bad');
    setSidebar('dotOverlay', 'sidebarOverlayText', 'Error', 'bad');
  });
});
document.getElementById('hideOverlayBtn').addEventListener('click', hideOverlay);

function sendRegionsToOverlay() {
  window.companion.sendToOverlay({ type: 'draw-regions', regions: settings.regions || {} });
}

document.getElementById('showHudCheckbox').addEventListener('change', (e) => {
  window.companion.sendToOverlay({ type: 'set-hud-visible', visible: e.target.checked });
});

// ---------- Region selection (arms the overlay for one drag) ----------

document.getElementById('selectHeadingBtn').addEventListener('click', () => {
  setStatus('regionStatus', 'Drag a box on your game over the heading/compass readout...', 'warn');
  window.companion.sendToOverlay({ type: 'arm', kind: 'drag', tag: 'heading' });
});
document.getElementById('selectInfoBtn').addEventListener('click', () => {
  setStatus('regionStatus', 'Drag a box on your game over the aircraft type/speed/altitude box...', 'warn');
  window.companion.sendToOverlay({ type: 'arm', kind: 'drag', tag: 'info' });
});
document.getElementById('selectMinimapBtn').addEventListener('click', () => {
  setStatus('regionStatus', 'Drag a box on your game over the minimap...', 'warn');
  window.companion.sendToOverlay({ type: 'arm', kind: 'drag', tag: 'minimap' });
});

// ---------- Calibration + position (arms the overlay for one click each) ----------

document.getElementById('calibrateBtn').addEventListener('click', () => {
  const icaoA = document.getElementById('airportA').value;
  const icaoB = document.getElementById('airportB').value;
  if (!icaoA || !icaoB || icaoA === icaoB) {
    setStatus('calibrationStatus', 'Pick two different airports first.', 'bad');
    return;
  }
  pendingCalibAirport = airports.find((a) => a.icao === icaoA);
  setStatus('calibrationStatus', 'Click Airport A on your minimap...', 'warn');
  window.companion.sendToOverlay({
    type: 'arm',
    kind: 'click',
    tag: 'calibA',
    label: `Click ${icaoA} on your minimap...`,
    meta: { world: pendingCalibAirport.world },
  });
});

document.getElementById('setPositionBtn').addEventListener('click', () => {
  if (!calibration) return;
  setStatus('fixStatus', 'Click your aircraft marker on the minimap...', 'warn');
  window.companion.sendToOverlay({ type: 'arm', kind: 'click', tag: 'position', label: 'Click your aircraft marker on the minimap...' });
});

window.companion.onOverlayResult(async (result) => {
  if (result.cancelled) {
    log(`Cancelled (${result.tag}).`);
    return;
  }

  if (result.tag === 'heading' || result.tag === 'info' || result.tag === 'minimap') {
    settings.regions = settings.regions || {};
    settings.regions[result.tag] = result.rect;
    await window.companion.saveSettings(settings);
    setStatus('regionStatus', `${result.tag} region saved.`, 'ok');
    sendRegionsToOverlay();
    return;
  }

  if (result.tag === 'calibA') {
    calibration = { refPoints: [{ pixel: result.point, world: result.meta.world }, null] };
    const icaoB = document.getElementById('airportB').value;
    pendingCalibAirport = airports.find((a) => a.icao === icaoB);
    setStatus('calibrationStatus', `Now click ${icaoB} on your minimap...`, 'warn');
    window.companion.sendToOverlay({
      type: 'arm',
      kind: 'click',
      tag: 'calibB',
      label: `Click ${icaoB} on your minimap...`,
      meta: { world: pendingCalibAirport.world },
    });
    return;
  }

  if (result.tag === 'calibB') {
    calibration.refPoints[1] = { pixel: result.point, world: result.meta.world };
    setStatus('calibrationStatus', 'Calibrated.', 'ok');
    document.getElementById('setPositionBtn').disabled = false;
    return;
  }

  if (result.tag === 'position') {
    const world = await window.companion.projectPixel(calibration.refPoints, result.point);
    const nearest = await window.companion.nearestAirport(airports, world);
    currentFix = { world, atMs: Date.now() };
    lastCorrectionAtMs = Date.now();
    const summary = `${nearest.distanceNm.toFixed(1)}nm bearing ${Math.round(nearest.bearingDeg)}° from ${nearest.icao}`;
    lastFixSummary = summary;
    setStatus('fixStatus', `Fix set: ~${summary}`, 'ok');
    setSidebar('dotFix', 'sidebarFixText', summary, 'good');
    syncBar();
    return;
  }

  if (result.tag === 'bar-toggle-tracking') {
    if (trackingTimer) stopTracking();
    else startTracking();
    return;
  }

  if (result.tag === 'radio-action') {
    const { action, radio, value } = result;
    if (action === 'step') stepRadio(radio, value);
    else if (action === 'setStandby') setRadioStandby(radio, value);
    else if (action === 'swap') swapRadio(radio);
    else if (action === 'power') toggleRadioPower(radio);
    else if (action === 'squawkStep') stepSquawk(value);
    else if (action === 'squawkSet') setSquawk(value);
    else if (action === 'ident') pressIdent();
  }
});

// ---------- CPDLC/PDC datalink polling ----------
// Independent of the tracking loop above - a "contact me" or PDC message
// should reach the pilot whether or not tracking has been started yet, as
// long as a callsign and Monitor URL are configured.

async function pollCpdlcTick() {
  if (!settings.callsign || !settings.monitorUrl) return;
  let messages;
  try {
    messages = await window.companion.pollCpdlc({
      monitorUrl: settings.monitorUrl,
      apiKey: settings.monitorApiKey || null,
      callsign: settings.callsign,
      sinceId: lastCpdlcId,
    });
  } catch (err) {
    log(`CPDLC poll failed: ${err.message}`);
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) return;

  for (const message of messages) {
    if (message.id > lastCpdlcId) lastCpdlcId = message.id;
  }
  window.companion.sendToOverlay({ type: 'cpdlc-messages', messages });
  log(`Received ${messages.length} datalink message(s).`);
}

setInterval(pollCpdlcTick, CPDLC_POLL_MS);

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

// UPSCALE: a tightly-drawn region (e.g. just the heading tape's boxed
// number) can be a tiny handful of pixels tall, and Tesseract confuses
// similarly-shaped digits (9/7 confirmed via a real capture: a correct
// "194" read at one tick, then "174" moments later at the same real
// heading) more often the fewer pixels there are to define each glyph's
// shape. Drawing into a larger canvas lets the browser's own image
// smoothing do the upscaling before OCR sees it.
const UPSCALE = 3;

// Forces the crop to pure black/white before handing it to Tesseract, which
// is tuned for dark text on a light background - the heading tape is the
// opposite (a light boxed number on a dark pill), and leaving that
// anti-aliased gradient in place was still producing a misread (194 read as
// 174, consistently, even with a digit-only whitelist, upscaling, and a
// single-line page-segmentation mode) so it's the glyph edges themselves,
// not just resolution or character-class ambiguity, that needed cleaning
// up. Auto-detects polarity from the crop's own average brightness rather
// than assuming light-on-dark, so it isn't a guess.
function binarize(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;

  const pixelCount = width * height;
  const gray = new Float32Array(pixelCount);
  let sum = 0;
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const luminance = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    gray[i] = luminance;
    sum += luminance;
  }
  const mean = sum / pixelCount;
  const backgroundIsDark = mean < 128;

  for (let i = 0; i < pixelCount; i++) {
    const isForeground = backgroundIsDark ? gray[i] > mean : gray[i] < mean;
    const v = isForeground ? 0 : 255;
    const o = i * 4;
    data[o] = v;
    data[o + 1] = v;
    data[o + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
}

async function ocrRegion(sourceCanvas, region, { heading = false } = {}) {
  if (!region) return '';
  const cropped = document.createElement('canvas');
  cropped.width = Math.max(1, Math.round(region.w * UPSCALE));
  cropped.height = Math.max(1, Math.round(region.h * UPSCALE));
  cropped
    .getContext('2d')
    .drawImage(sourceCanvas, region.x, region.y, region.w, region.h, 0, 0, cropped.width, cropped.height);
  if (heading) binarize(cropped);
  const dataUrl = cropped.toDataURL('image/png');
  return heading ? window.companion.recognizeHeadingText(dataUrl) : window.companion.recognizeText(dataUrl);
}

// The overlay's boxes are in the display's logical (CSS) pixel space; the
// captured screen video is in native/physical pixels (HiDPI scaling makes
// these differ). This maps a saved region into the video's own pixel space
// at OCR time, computed fresh each tick so it never needs a hardcoded
// scale factor.
function toVideoRect(region) {
  if (!region || !overlayInfo || !captureVideo.videoWidth) return null;
  const scaleX = captureVideo.videoWidth / overlayInfo.bounds.width;
  const scaleY = captureVideo.videoHeight / overlayInfo.bounds.height;
  return { x: region.x * scaleX, y: region.y * scaleY, w: region.w * scaleX, h: region.h * scaleY };
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
  if (!captureVideo.videoWidth) {
    log('Skipping - screen capture not ready yet.');
    return;
  }

  const frame = document.createElement('canvas');
  frame.width = captureVideo.videoWidth;
  frame.height = captureVideo.videoHeight;
  frame.getContext('2d').drawImage(captureVideo, 0, 0);

  const [headingText, infoText] = await Promise.all([
    ocrRegion(frame, toVideoRect(settings.regions.heading), { heading: true }),
    ocrRegion(frame, toVideoRect(settings.regions.info)),
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
      squawk,
      identing: identUntilMs > Date.now(),
    });
    log(
      `Uploaded: ${nearest.distanceNm.toFixed(1)}nm brg ${Math.round(nearest.bearingDeg)}° from ${nearest.icao}, ` +
        `${info.altitudeFt != null ? `${info.altitudeFt}ft` : 'alt ?'}, hdg ${heading}°, ${info.speedKts}kts, ${info.aircraftType || '?'} (fix age ${Math.round(fixAgeSec)}s)` +
        // Temporary diagnostic (see companion/lib/ocr.js's parseHeadingTape) -
        // a "successful" parse can still read the wrong number if the raw OCR
        // text isn't what's expected, and that raw text was previously only
        // logged on an outright failed parse. Remove once heading-reading
        // accuracy is confirmed solid.
        ` [heading OCR: "${headingText.replace(/\n/g, ' ')}"]`
    );
  } catch (err) {
    log(`Upload failed: ${err.message}`);
  }
}

function startTracking() {
  if (trackingTimer) return;
  trackingTimer = setInterval(trackTick, Math.max(2, settings.intervalSec || 5) * 1000);
  trackTick();
  document.getElementById('startTrackingBtn').disabled = true;
  document.getElementById('stopTrackingBtn').disabled = false;
  setSidebar('dotTracking', 'sidebarTrackingText', 'Running', 'good');
  syncBar();
  log('Tracking started.');
}

function stopTracking() {
  clearInterval(trackingTimer);
  trackingTimer = null;
  document.getElementById('startTrackingBtn').disabled = false;
  document.getElementById('stopTrackingBtn').disabled = true;
  setSidebar('dotTracking', 'sidebarTrackingText', 'Stopped', null);
  syncBar();
  log('Tracking stopped.');
}

document.getElementById('startTrackingBtn').addEventListener('click', startTracking);
document.getElementById('stopTrackingBtn').addEventListener('click', stopTracking);

// ---------- Radio panel (VHF1/2/3 + squawk) ----------
// The actual panel UI now lives on the overlay window (its "Radios" bar
// button - see overlay.js), since that's what stays up while flying; this
// window just owns the state and the logic, same as it always has -
// pushRadioStateToOverlay() below sends a fresh snapshot for the overlay to
// render, and the onOverlayResult 'radio-action' case (see further down)
// receives back whatever the pilot did to a knob/swap/power/ident control.

// Fresh defaults every launch, matching a real aircraft's radios coming up
// on standby rather than remembering last session's frequencies:
//  - VHF1: the default primary radio, both active/standby default to
//    122.800, starts switched on.
//  - VHF2: same defaults, but starts inop until the pilot switches it on.
//  - VHF3: dedicated to DATA, defaults to guard 121.500 on both sides.
// All three are switchable (VHF1/VHF3 just default to on, VHF2 to off). A
// switchable radio's knob stays turnable even while inop (same as a real
// radio lets you dial in a standby frequency before powering it on) - only
// its swap button is gated by inop, since that's what actually puts a
// frequency into use. Only the current "primary" radio's active frequency
// (see primaryRadioKey() below - VHF1 by default, VHF2 once it's switched
// on) actually moves you on swap; VHF3 never takes that role.
const FREQ_MIN = 118.0;
const FREQ_MAX = 136.975;
const FREQ_STEP = 0.025;

const radios = {
  vhf1: { label: 'VHF1', active: 122.8, standby: 122.8, inop: false, switchable: true },
  vhf2: { label: 'VHF2', active: 122.8, standby: 122.8, inop: true, switchable: true },
  vhf3: { label: 'VHF3 (DATA)', active: 121.5, standby: 121.5, inop: false, switchable: true },
};

// Real transponder codes are 4 octal digits (0-7 only, no 8/9) - 2000
// matches this fleet's VFR conspicuity default (see IZOL/Rockford's own
// real-world-style ICAO conventions elsewhere in this repo).
let squawk = '2000';

// Real-world "squawk ident" (a transponder button that makes an aircraft's
// blip flash on radar for positive identification, held for ~18s) - see
// systemPrompt.js for when ATC is expected to ask for it. There's no radar
// here to actually flash, so this just rides along on the next upload(s) as
// position.identing (see positions.js's formatRow) for the LLM to see.
const IDENT_DURATION_MS = 18_000;
let identUntilMs = 0;

function formatFreq(value) {
  return value.toFixed(3);
}

function clampFreq(value) {
  return Math.min(FREQ_MAX, Math.max(FREQ_MIN, Math.round(value / FREQ_STEP) * FREQ_STEP));
}

function pushRadioStateToOverlay() {
  window.companion.sendToOverlay({
    type: 'radio-state',
    radios,
    squawk,
    identing: identUntilMs > Date.now(),
  });
}

function stepRadio(key, direction) {
  const radio = radios[key];
  radio.standby = clampFreq(radio.standby + direction * FREQ_STEP);
  pushRadioStateToOverlay();
}

function setRadioStandby(key, value) {
  if (!Number.isFinite(value)) return;
  radios[key].standby = clampFreq(value);
  pushRadioStateToOverlay();
}

function toggleRadioPower(key) {
  radios[key].inop = !radios[key].inop;
  pushRadioStateToOverlay();
}

/**
 * Which radio is "what you're currently listening/talking to" - the one
 * whose swap actually fires a tune request to Bot Manager (see the class
 * comment on BotManagerBot's Job 2). Defaults to VHF1, but switching VHF2
 * on hands that role to VHF2 instead, same as a pilot choosing to work a
 * second radio - switching VHF2 back off hands it back to VHF1. This
 * doesn't check VHF1's own inop state: if VHF1 is switched off (and VHF2
 * isn't on), it stays "primary" in name, it just can't actually be swapped
 * until switched back on (its swap button is disabled while inop, same as
 * any switchable radio) - turning your primary off doesn't silently
 * promote a backup, same as a real pilot has to deliberately choose to
 * work a second radio. VHF3 (DATA) never takes this role at all.
 */
function primaryRadioKey() {
  return radios.vhf2.inop ? 'vhf1' : 'vhf2';
}

/**
 * Flips standby into active - the classic flip-flop swap. Only the current
 * primary radio (see primaryRadioKey() above) also fires an actual tune
 * request to Bot Manager.
 */
async function swapRadio(key) {
  const radio = radios[key];
  [radio.active, radio.standby] = [radio.standby, radio.active];
  pushRadioStateToOverlay();

  if (key !== primaryRadioKey()) return;

  if (!settings.monitorUrl || !settings.callsign) {
    log('Cannot tune - set your callsign and Monitor URL first.');
    return;
  }

  const frequency = formatFreq(radio.active);
  try {
    await window.companion.tuneFrequency({
      monitorUrl: settings.monitorUrl,
      apiKey: settings.monitorApiKey || null,
      callsign: settings.callsign,
      frequency,
    });
    log(`Tuned ${frequency}.`);
  } catch (err) {
    log(`Tune to ${frequency} failed: ${err.message}`);
  }
}

function stepSquawk(direction) {
  // Treated as a plain base-8 number for stepping (0000 <-> 7777 wraps),
  // simpler than modeling the two physical dual-concentric knobs a real
  // transponder has for the digit pairs.
  const asOctal = parseInt(squawk, 8);
  const next = (asOctal + direction + 0o10000) % 0o10000;
  squawk = next.toString(8).padStart(4, '0');
  pushRadioStateToOverlay();
}

function setSquawk(value) {
  if (!/^[0-7]{4}$/.test(value)) return;
  squawk = value;
  pushRadioStateToOverlay();
}

function pressIdent() {
  identUntilMs = Date.now() + IDENT_DURATION_MS;
  log('Squawked ident.');
  pushRadioStateToOverlay();
  setTimeout(pushRadioStateToOverlay, IDENT_DURATION_MS + 100);
}

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
  await populateDisplays();
})();
