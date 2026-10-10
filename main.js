const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

const { loadAirports } = require('./lib/airports');
const { createInputSender, KEY_NAMES } = require('./lib/inputSender');
const { createMouseSteer } = require('./lib/mouseSteer');
const { createRemoteServer, newPairingCode } = require('./lib/remoteServer');
const { createRelayClient, newRelayCredentials } = require('./lib/relayClient');

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
// The FMS window keeps its own settings file, so it and the control window
// never overwrite each other's settings with a stale copy.
const FMS_SETTINGS_PATH = path.join(app.getPath('userData'), 'fms-settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings, file = SETTINGS_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

function loadFmsSettings() {
  try {
    return JSON.parse(fs.readFileSync(FMS_SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
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
let fmsWindow = null;
let inputSender = null; // created on the first autopilot input
let mouseSteer = null;
let remoteServer = null; // phone/tablet control on this Wi-Fi - see lib/remoteServer.js
let relayClient = null; // phone/tablet control from anywhere - see lib/relayClient.js

function sendToFms(channel, payload) {
  if (fmsWindow) fmsWindow.webContents.send(channel, payload);
}

function getRelayClient() {
  if (!relayClient) {
    relayClient = createRelayClient({
      onInput: (message) => sendToFms('remote-input', message),
      onClients: (count) => sendToFms('remote-clients', count),
      onStatus: (state, detail) => sendToFms('relay-status', { state, detail }),
    });
  }
  return relayClient;
}

function getRemoteServer() {
  if (!remoteServer) {
    remoteServer = createRemoteServer({
      // Inputs from a phone go to the FMS window, exactly like its own clicks.
      onInput: (message) => {
        if (fmsWindow) fmsWindow.webContents.send('remote-input', message);
      },
      onClients: (count) => {
        if (fmsWindow) fmsWindow.webContents.send('remote-clients', count);
      },
    });
  }
  return remoteServer;
}

function getInputSender() {
  if (!inputSender) inputSender = createInputSender();
  return inputSender;
}

// Electron works in DIPs; the OS input APIs on Windows want physical pixels.
function toPhysical(point) {
  return process.platform === 'win32' ? screen.dipToScreenPoint(point) : point;
}

function getMouseSteer() {
  if (!mouseSteer) {
    mouseSteer = createMouseSteer({
      moveMouse: (x, y) => {
        const p = toPhysical({ x: Math.round(x), y: Math.round(y) });
        getInputSender().moveMouse(p.x, p.y);
      },
      getCursor: () => screen.getCursorScreenPoint(),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
    });
  }
  return mouseSteer;
}

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
    if (fmsWindow) fmsWindow.close();
  });
}

// The MCDU/FMS + autopilot panel (renderer/fms.html). Opened from the
// control window; receives each tracking update relayed below.
function openFmsWindow() {
  if (fmsWindow) {
    fmsWindow.show();
    fmsWindow.focus();
    return;
  }
  fmsWindow = new BrowserWindow({
    width: 900,
    height: 820,
    minWidth: 760,
    minHeight: 640,
    alwaysOnTop: true,
    title: 'FMS / Autopilot',
    backgroundColor: '#15181d',
    webPreferences: PRELOAD_WEB_PREFS,
  });
  fmsWindow.loadFile(path.join(__dirname, 'renderer', 'fms.html'));
  if (process.env.COMPANION_DEVTOOLS) fmsWindow.webContents.openDevTools({ mode: 'detach' });
  fmsWindow.on('closed', () => {
    fmsWindow = null;
    // Never leave a key held down with nothing left to release it.
    if (inputSender) inputSender.releaseAll();
    // Remote control drives the FMS window - nothing to control without it.
    if (remoteServer) remoteServer.stop();
    if (relayClient) relayClient.stop();
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
ipcMain.handle('load-fms-settings', () => loadFmsSettings());
ipcMain.handle('save-fms-settings', (event, settings) => {
  saveSettings(settings, FMS_SETTINGS_PATH);
  return true;
});

ipcMain.handle('open-fms', () => openFmsWindow());
// Each tracking update from the control window, for the FMS/autopilot.
ipcMain.on('telemetry', (event, sample) => {
  if (fmsWindow) fmsWindow.webContents.send('telemetry', sample);
});

ipcMain.handle('autopilot-key-names', () => KEY_NAMES);
ipcMain.handle('autopilot-press', (event, { key, ms }) => {
  getInputSender().press(key, ms);
});
// Pitch/bank nudges via the mouse cursor - see lib/mouseSteer.js.
// Resolves {override: true} if the pilot has moved the mouse.
ipcMain.handle('autopilot-steer', (event, command) => getMouseSteer().steer(command));
ipcMain.handle('autopilot-recenter', (event, center) => {
  if (mouseSteer) mouseSteer.recenter(center);
});
// Where the cursor is now - the FMS settings capture the straight-and-level
// center point with this.
ipcMain.handle('autopilot-cursor', () => screen.getCursorScreenPoint());
// Phone / tablet remote control.
ipcMain.on('fms-view', (event, view) => {
  if (remoteServer && remoteServer.running) remoteServer.publish(view);
  if (relayClient) relayClient.publish(view);
});
ipcMain.handle('relay-start', (event, options) => getRelayClient().start(options));
ipcMain.handle('relay-stop', () => relayClient && relayClient.stop());
ipcMain.handle('relay-new-credentials', () => newRelayCredentials());
ipcMain.handle('remote-start', (event, { port, code }) => getRemoteServer().start({ port, pairingCode: code }));
ipcMain.handle('remote-stop', () => remoteServer && remoteServer.stop());
ipcMain.handle('remote-set-code', (event, code) => remoteServer && remoteServer.setCode(code));
ipcMain.handle('remote-new-code', () => newPairingCode());

ipcMain.handle('autopilot-release-all', () => {
  if (inputSender) inputSender.releaseAll();
});
// While the autopilot is flying, the FMS window stops taking keyboard focus
// (mouse clicks still work), so clicking its buttons doesn't pull focus
// away from the game the autopilot is pressing keys in.
ipcMain.handle('fms-set-passthrough', (event, on) => {
  if (fmsWindow) fmsWindow.setFocusable(!on);
});
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

// Digit-only variant for the heading tape - see lib/ocr.js's getHeadingWorker().
ipcMain.handle('recognize-heading-text', (event, image) => {
  const proc = getOcrProcess();
  const id = ocrRequestId++;
  return new Promise((resolve, reject) => {
    ocrPending.set(id, { resolve, reject });
    proc.send({ id, image, kind: 'heading' });
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
