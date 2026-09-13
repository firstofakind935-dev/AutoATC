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
const { recognizeText, parseFlightInfo, parseHeadingTape } = tryRequire('ocr', './lib/ocr');
const { uploadPosition } = tryRequire('uploader', './lib/uploader');

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
  getSources: () => ipcRenderer.invoke('get-sources'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getAirports: () => ipcRenderer.invoke('get-airports'),

  // Direct logic (runs here in the preload context, which has Node access)
  projectPixel,
  distanceBearing: distanceBearingNm,
  nearestAirport,
  integrate,
  findMarkerCentroid,
  recognizeText,
  parseFlightInfo,
  parseHeadingTape,
  uploadPosition,
});
