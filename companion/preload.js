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
const { uploadPosition } = tryRequire('uploader', './lib/uploader');
const { pollCpdlc } = tryRequire('datalink', './lib/datalink');

// contextBridge can only pass plain, structured-cloneable data across to the
// renderer - not functions/class instances - so calibration.project() gets
// wrapped as a plain (refPoints, pixel) -> {lat, lon} call instead of
// exposing the calibration object itself.
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
  getAirports: () => ipcRenderer.invoke('get-airports'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  createOverlay: (displayId) => ipcRenderer.invoke('create-overlay', displayId),
  closeOverlay: () => ipcRenderer.invoke('close-overlay'),
  setOverlayInteractive: (interactive) => ipcRenderer.invoke('set-overlay-interactive', interactive),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  focusControlWindow: () => ipcRenderer.invoke('focus-control'),

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
  // Runs in the main process (see main.js's 'recognize-text' handler) -
  // not called directly here, unlike the other lib/*.js functions above.
  recognizeText: (image) => ipcRenderer.invoke('recognize-text', image),
  // Digit-only OCR pass for the heading tape - see lib/ocr.js's getHeadingWorker().
  recognizeHeadingText: (image) => ipcRenderer.invoke('recognize-heading-text', image),
  parseFlightInfo,
  parseHeadingTape,
  uploadPosition,
  pollCpdlc,
});
