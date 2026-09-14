const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const { loadAirports } = require('./lib/airports');

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

const PRELOAD_WEB_PREFS = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  // Electron sandboxes preload scripts by default (since v20), which
  // restricts require() to a small built-in allowlist - our own lib/*.js
  // modules (and tesseract.js) fail to resolve under that. The preload
  // still only exposes specific functions via contextBridge, so the
  // renderer itself stays fully sandboxed regardless.
  sandbox: false,
};

let controlWindow = null;
let overlayWindow = null;

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 460,
    height: 780,
    alwaysOnTop: true,
    webPreferences: PRELOAD_WEB_PREFS,
  });
  controlWindow.loadFile(path.join(__dirname, 'renderer', 'control.html'));
  if (process.env.COMPANION_DEVTOOLS) controlWindow.webContents.openDevTools({ mode: 'detach' });
  controlWindow.on('closed', () => {
    controlWindow = null;
    if (overlayWindow) overlayWindow.close();
  });
}

// The overlay is a transparent, click-through-by-default window sized to
// exactly cover one monitor, so region boxes and calibration clicks land on
// real screen pixels directly over the game instead of a separate scaled
// preview - and so a single-monitor pilot doesn't need a second display to
// see both the game and the companion app's UI at once.
function createOverlayWindow(display) {
  if (overlayWindow) overlayWindow.close();
  overlayWindow = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: true,
    webPreferences: PRELOAD_WEB_PREFS,
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  return overlayWindow;
}

ipcMain.handle('get-displays', () =>
  screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    scaleFactor: d.scaleFactor,
    label: `${d.bounds.width}x${d.bounds.height} at (${d.bounds.x}, ${d.bounds.y})`,
  }))
);

ipcMain.handle('create-overlay', (event, displayId) => {
  const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  createOverlayWindow(display);
  return { id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor };
});

ipcMain.handle('close-overlay', () => {
  if (overlayWindow) overlayWindow.close();
});

ipcMain.handle('set-overlay-interactive', (event, interactive) => {
  if (overlayWindow) overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
});

// The overlay's top bar toggles this on every mousemove based on whether
// the cursor is over the bar, so the bar itself stays clickable while the
// rest of the screen stays click-through for flying - the standard pattern
// for a game-style HUD overlay.
ipcMain.handle('focus-control', () => {
  if (controlWindow) {
    controlWindow.show();
    controlWindow.focus();
  }
});

// Relays between the control window and the overlay window - they're
// separate renderer processes and can't reach each other directly.
ipcMain.on('control-to-overlay', (event, payload) => {
  if (overlayWindow) overlayWindow.webContents.send('overlay-command', payload);
});
ipcMain.on('overlay-to-control', (event, payload) => {
  if (controlWindow) controlWindow.webContents.send('overlay-result', payload);
});

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  return sources.map((s) => ({ id: s.id, name: s.name, display_id: s.display_id }));
});

ipcMain.handle('load-settings', () => loadSettings());
ipcMain.handle('save-settings', (event, settings) => {
  saveSettings(settings);
  return true;
});

ipcMain.handle('get-airports', () => loadAirports());

// tesseract.js's createWorker() spins up a real Node worker_threads Worker,
// which throws "The V8 platform used by this instance of Node does not
// support creating Worker" if called directly in this (Electron main)
// process - Electron's own V8 platform initialization doesn't support
// creating one, in main OR preload, unlike a genuine Node.js process. The
// fix is to run OCR in an actually-separate, non-Electron Node process:
// fork lib/ocrProcess.js with ELECTRON_RUN_AS_NODE=1, which makes
// Electron's own binary behave as real Node instead (Electron's own
// documented mechanism for exactly this situation), and relay each
// recognize-text call to it over the child process's own IPC channel.
let ocrProcess = null;
let ocrRequestId = 0;
const ocrPending = new Map();

function getOcrProcess() {
  if (ocrProcess) return ocrProcess;
  ocrProcess = fork(path.join(__dirname, 'lib', 'ocrProcess.js'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  ocrProcess.on('message', ({ id, text, error }) => {
    const pending = ocrPending.get(id);
    if (!pending) return;
    ocrPending.delete(id);
    if (error) pending.reject(new Error(error));
    else pending.resolve(text);
  });
  ocrProcess.on('exit', (code) => {
    console.error(`[companion] OCR process exited unexpectedly (code ${code}) - restarting on next call.`);
    ocrProcess = null;
    for (const pending of ocrPending.values()) pending.reject(new Error(`OCR process exited (code ${code})`));
    ocrPending.clear();
  });
  return ocrProcess;
}

// image is a data URL (tesseract.js also accepts a Buffer/canvas, but only
// a string survives structured-clone across contextBridge/IPC, and child
// process IPC serializes the same way).
ipcMain.handle('recognize-text', (event, image) => {
  const proc = getOcrProcess();
  const id = ocrRequestId++;
  return new Promise((resolve, reject) => {
    ocrPending.set(id, { resolve, reject });
    proc.send({ id, image });
  });
});

app.whenReady().then(() => {
  createControlWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createControlWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (ocrProcess) ocrProcess.kill();
});
