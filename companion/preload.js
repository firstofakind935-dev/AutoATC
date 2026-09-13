const { contextBridge, ipcRenderer } = require('electron');

const { buildCalibration } = require('./lib/calibration');
const { distanceBearingNm } = require('./lib/coords');
const { nearestAirport } = require('./lib/airports');
const { integrate } = require('./lib/deadReckoning');
const { findMarkerCentroid } = require('./lib/marker');
const { recognizeText, parseFlightInfo, parseHeadingTape } = require('./lib/ocr');
const { uploadPosition } = require('./lib/uploader');

// contextBridge can only pass plain, structured-cloneable data across to the
// renderer - not functions/class instances - so calibration.project() gets
// wrapped as a plain (refPoints, pixel) -> {lat, lon} call instead of
// exposing the calibration object itself.
function projectPixel(refPoints, pixel) {
  return buildCalibration(refPoints).project(pixel);
}

contextBridge.exposeInMainWorld('companion', {
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
