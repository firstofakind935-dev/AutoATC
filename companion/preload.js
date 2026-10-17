const { contextBridge, ipcRenderer } = require('electron');

// Each require is isolated so a broken/missing dependency in one module
// (e.g. tesseract.js failing to load) can't take contextBridge.exposeInMainWorld
// down entirely - that used to leave window.companion undefined altogether,
// breaking even unrelated calls like getSources().
const loadErrors = {};
function tryRequire(name, modulePath) {
  try {
    return require(modulePath);
  } catch (err) {
    loadErrors[name] = err.stack || String(err);
    return {};
  }
}

const { buildCalibration } = tryRequire('calibration', './lib/calibration');
const { distanceBearingNm } = tryRequire('coords', './lib/coords');
const { nearestAirport } = tryRequire('airports', './lib/airports');
const { integrate } = tryRequire('deadReckoning', './lib/deadReckoning');
const { findMarkerCentroid } = tryRequire('marker', './lib/marker');
// parseFlightInfo/parseHeadingTape are pure regex parsing - safe to run
// directly here. recognizeText is NOT required directly (see below) - the
// actual tesseract.js call has to run in the main process instead, since
// preload's V8 context can't create the worker_threads Worker it needs.
const { parseFlightInfo, parseHeadingTape } = tryRequire('ocr', './lib/ocr');
const { uploadPosition, tuneFrequency } = tryRequire('uploader', './lib/uploader');
const { pollCpdlc, pollAnchors } = tryRequire('datalink', './lib/datalink');
const { runwayFix, listRunways } = tryRequire('runways', './lib/runways');
const { fixFromMap, fixFromMinimap } = tryRequire('mapFix', './lib/mapFix');
const { findMinimap, blankButtons } = tryRequire('minimapFinder', './lib/minimapFinder');
const { createLocator } = tryRequire('featureLocator', './lib/featureLocator');
const { createPositionFilter } = tryRequire('positionFilter', './lib/positionFilter');
const { standFix, listStands, shippedOffsets } = tryRequire('stands', './lib/stands');
const { pictureToGame } = tryRequire('frames', './lib/frames');

// contextBridge can only pass plain, structured-cloneable data across to the
// renderer - not functions/class instances - so calibration.project() gets
// wrapped as a plain (refPoints, pixel) -> {lat, lon} call instead of
// exposing the calibration object itself.
// One feature locator (it remembers the last place and scale) and one position filter for the tracking window.
// contextBridge can't hand objects with state across, so they live here behind plain calls.
const minimapLocator = createLocator ? createLocator() : null;
const positionFilter = createPositionFilter ? createPositionFilter() : null;

function projectPixel(refPoints, pixel) {
  return buildCalibration(refPoints).project(pixel);
}

contextBridge.exposeInMainWorld('companion', {
  // Non-empty only if a lib/*.js module above failed to load - the renderer
  // shows this instead of silently breaking whatever depends on it.
  loadErrors,

  // IPC (main process)
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  // In-app radio push-to-talk (main.js, lib/pttKey.js): the key held down while the game has focus.
  onPtt: (callback) => ipcRenderer.on('ptt', (event, down) => callback(down)),
  setPttKey: (name) => ipcRenderer.invoke('ptt-set-key', name),
  pttSupported: () => ipcRenderer.invoke('ptt-supported'),
  pttKeys: () => Object.keys(require('./lib/pttKey').PTT_KEYS),
  getAirports: () => ipcRenderer.invoke('get-airports'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  createOverlay: (displayId) => ipcRenderer.invoke('create-overlay', displayId),
  closeOverlay: () => ipcRenderer.invoke('close-overlay'),
  setOverlayInteractive: (interactive) => ipcRenderer.invoke('set-overlay-interactive', interactive),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  focusControlWindow: () => ipcRenderer.invoke('focus-control'),

  // FMS / autopilot window (renderer/fms.html)
  openFms: () => ipcRenderer.invoke('open-fms'),
  isPilot: () => ipcRenderer.invoke('is-pilot'),
  getAtcState: () => ipcRenderer.invoke('get-atc-state'),
  atcAction: (action) => ipcRenderer.send('atc-action', action),
  onAtcState: (callback) => ipcRenderer.on('atc-state', (event, state) => callback(state)),
  sendTelemetry: (sample) => ipcRenderer.send('telemetry', sample),
  onTelemetry: (callback) => ipcRenderer.on('telemetry', (event, sample) => callback(sample)),
  feedStart: (options) => ipcRenderer.invoke('feed-start', options),
  feedStop: () => ipcRenderer.invoke('feed-stop'),
  feedSetCallsign: (callsign) => ipcRenderer.invoke('feed-set-callsign', callsign),
  onFeedSample: (callback) => ipcRenderer.on('feed-sample', (event, sample) => callback(sample)),
  onFeedStatus: (callback) => ipcRenderer.on('feed-status', (event, status) => callback(status)),
  loadFmsSettings: () => ipcRenderer.invoke('load-fms-settings'),
  saveFmsSettings: (settings) => ipcRenderer.invoke('save-fms-settings', settings),
  autopilotKeyNames: () => ipcRenderer.invoke('autopilot-key-names'),
  autopilotPress: (key, ms) => ipcRenderer.invoke('autopilot-press', { key, ms }),
  autopilotReleaseAll: () => ipcRenderer.invoke('autopilot-release-all'),
  autopilotSteer: (command) => ipcRenderer.invoke('autopilot-steer', command),
  autopilotRecenter: (center) => ipcRenderer.invoke('autopilot-recenter', center),
  autopilotCursor: () => ipcRenderer.invoke('autopilot-cursor'),
  // Phone / tablet remote control (lib/remoteServer.js)
  publishFmsView: (view) => ipcRenderer.send('fms-view', view),
  onRemoteInput: (callback) => ipcRenderer.on('remote-input', (event, message) => callback(message)),
  onRemoteClients: (callback) => ipcRenderer.on('remote-clients', (event, count) => callback(count)),
  remoteStart: (options) => ipcRenderer.invoke('remote-start', options),
  remoteStop: () => ipcRenderer.invoke('remote-stop'),
  remoteSetCode: (code) => ipcRenderer.invoke('remote-set-code', code),
  remoteNewCode: () => ipcRenderer.invoke('remote-new-code'),
  // ...and from anywhere, through the flight planner's relay (lib/relayClient.js)
  relayStart: (options) => ipcRenderer.invoke('relay-start', options),
  relayStop: () => ipcRenderer.invoke('relay-stop'),
  relayNewCredentials: () => ipcRenderer.invoke('relay-new-credentials'),
  onRelayStatus: (callback) => ipcRenderer.on('relay-status', (event, status) => callback(status)),
  setFmsPassthrough: (on) => ipcRenderer.invoke('fms-set-passthrough', on),

  // Control window <-> overlay window messaging, relayed through main
  // (they're separate renderer processes and can't reach each other
  // directly).
  sendToOverlay: (payload) => ipcRenderer.send('control-to-overlay', payload),
  onOverlayResult: (callback) => ipcRenderer.on('overlay-result', (event, payload) => callback(payload)),
  sendToControl: (payload) => ipcRenderer.send('overlay-to-control', payload),
  onOverlayCommand: (callback) => ipcRenderer.on('overlay-command', (event, payload) => callback(payload)),

  // Direct logic (runs here in the preload context, which has Node access)
  projectPixel,
  distanceBearing: distanceBearingNm,
  nearestAirport,
  integrate,
  findMarkerCentroid,
  // Position from a screenshot of the in-game big map (lib/mapFix.js).
  fixFromMap: (image, options) => fixFromMap(image, options),
  // The minimap: found on screen by its corner buttons; a fix by features (lib/minimapFinder.js, featureLocator.js).
  findMinimap: (image) => findMinimap(image),
  fixFromMinimap: (image, hint) => fixFromMinimap(blankButtons(image), { locator: minimapLocator, hint }),
  // Which fixes to believe, and where we are between them (lib/positionFilter.js). Times in seconds.
  filterAccept: (xNm, yNm, score, nowS) => positionFilter.accept(xNm, yNm, score, nowS),
  filterAnchor: (xNm, yNm, nowS) => positionFilter.anchor(xNm, yNm, nowS),
  filterSet: (xNm, yNm, nowS) => positionFilter.set(xNm, yNm, nowS),
  filterPositionAt: (nowS) => positionFilter.positionAt(nowS),
  filterState: () => ({ hasPosition: positionFilter.hasPosition, speedKt: positionFilter.speedKt, trackDeg: positionFilter.trackDeg() }),
  // Position from a stand number (lib/stands.js).
  standFix,
  listStands,
  shippedStandOffsets: () => shippedOffsets(),
  // POS INIT: the FMS asks the tracking window to put the aircraft on a stand (see main.js 'pos-init').
  posInit: (icao, stand) => ipcRenderer.invoke('pos-init', { icao, stand }),
  onPosInitRequest: (callback) => ipcRenderer.on('pos-init-request', (event, request) => callback(request)),
  posInitReply: (result) => ipcRenderer.send('pos-init-reply', result),
  // Picture-frame fix -> the radar / ground-chart frame (lib/frames.js).
  pictureToGame,
  onMapFixHotkey: (callback) => ipcRenderer.on('map-fix-hotkey', () => callback()),
  // Runs in the main process (see main.js's 'recognize-text' handler) -
  // not called directly here, unlike the other lib/*.js functions above.
  recognizeText: (image) => ipcRenderer.invoke('recognize-text', image),
  // Digit-only OCR pass for the heading tape - see lib/ocr.js's getHeadingWorker().
  recognizeHeadingText: (image) => ipcRenderer.invoke('recognize-heading-text', image),
  parseFlightInfo,
  parseHeadingTape,
  uploadPosition,
  tuneFrequency,
  pollCpdlc,
  pollAnchors,
  runwayFix,
  listRunways,
});
