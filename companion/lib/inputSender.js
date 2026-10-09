// The autopilot's hands: presses keys (throttle) and moves the mouse
// cursor (pitch and bank - PTFS steers toward the cursor) as if a person
// were doing it. Runs in the Electron main process (see main.js's
// 'autopilot-press' / 'autopilot-steer' handlers), never in a renderer.
//
// One method per OS (nothing extra to install on Windows or macOS):
// - Windows: Windows' own SendInput, called directly from this process
//   through koffi (a Node library for calling system functions, prebuilt
//   for every platform) - hardware scan codes for keys, absolute moves for
//   the mouse, which games read like a real keyboard and mouse. No helper
//   process and no PowerShell: an app that spawns hidden, encoded
//   PowerShell to inject input looks exactly like malware to antivirus.
// - macOS: osascript (System Events for keys, CoreGraphics for the mouse).
//   The companion app needs Accessibility permission (System Settings >
//   Privacy & Security > Accessibility).
// - Linux: xdotool (install it from your package manager).
//
// Keys go to the FOCUSED window - the PTFS game window must be focused
// while the autopilot is flying. Mouse positions are physical screen
// pixels (main.js converts from Electron's DIPs).

const { spawn } = require('child_process');

// [Windows scan code, extended?, macOS key code, xdotool name]
const KEYS = {
  ...Object.fromEntries(
    [
      ['A', 0x1e, 0], ['B', 0x30, 11], ['C', 0x2e, 8], ['D', 0x20, 2], ['E', 0x12, 14], ['F', 0x21, 3],
      ['G', 0x22, 5], ['H', 0x23, 4], ['I', 0x17, 34], ['J', 0x24, 38], ['K', 0x25, 40], ['L', 0x26, 37],
      ['M', 0x32, 46], ['N', 0x31, 45], ['O', 0x18, 31], ['P', 0x19, 35], ['Q', 0x10, 12], ['R', 0x13, 15],
      ['S', 0x1f, 1], ['T', 0x14, 17], ['U', 0x16, 32], ['V', 0x2f, 9], ['W', 0x11, 13], ['X', 0x2d, 7],
      ['Y', 0x15, 16], ['Z', 0x2c, 6],
    ].map(([k, scan, mac]) => [k, [scan, false, mac, k.toLowerCase()]])
  ),
  ...Object.fromEntries(
    [[1, 0x02, 18], [2, 0x03, 19], [3, 0x04, 20], [4, 0x05, 21], [5, 0x06, 23], [6, 0x07, 22], [7, 0x08, 26], [8, 0x09, 28], [9, 0x0a, 25], [0, 0x0b, 29]]
      .map(([k, scan, mac]) => [String(k), [scan, false, mac, String(k)]])
  ),
  Space: [0x39, false, 49, 'space'],
  Shift: [0x2a, false, 56, 'Shift_L'],
  Ctrl: [0x1d, false, 59, 'Control_L'],
  Minus: [0x0c, false, 27, 'minus'],
  Equals: [0x0d, false, 24, 'equal'],
  ArrowUp: [0x48, true, 126, 'Up'],
  ArrowDown: [0x50, true, 125, 'Down'],
  ArrowLeft: [0x4b, true, 123, 'Left'],
  ArrowRight: [0x4d, true, 124, 'Right'],
  PageUp: [0x49, true, 116, 'Prior'],
  PageDown: [0x51, true, 121, 'Next'],
};

const MAX_HOLD_MS = 1000;

// ---- Windows: SendInput through koffi

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const definedTypes = new WeakMap(); // koffi rejects declaring the same type name twice

/** The Win32 INPUT struct (and its parts) declared for koffi, once. */
function defineWindowsInputTypes(koffi) {
  // Keyed on koffi.struct, not the module object, so a test's stand-in
  // koffi (the real one with load() replaced) shares the same types.
  if (definedTypes.has(koffi.struct)) return definedTypes.get(koffi.struct);
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  });
  const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
  definedTypes.set(koffi.struct, { INPUT });
  return { INPUT };
}

/** One key going down or up, by hardware scan code (what games read). */
function keyboardInput([scan, extended], up) {
  const dwFlags = KEYEVENTF_SCANCODE | (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0);
  return { type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: scan, dwFlags, time: 0, dwExtraInfo: 0 } } };
}

/**
 * An absolute mouse move to physical pixel (x, y). SendInput wants 0-65535
 * across the whole virtual desktop (all monitors), so `desk` is that
 * desktop's {left, top, width, height}.
 */
function mouseMoveInput(x, y, desk) {
  const scale = (v, origin, size) => Math.round(((v - origin) * 65535) / Math.max(1, size - 1));
  return {
    type: INPUT_MOUSE,
    u: { mi: { dx: scale(x, desk.left, desk.width), dy: scale(y, desk.top, desk.height), mouseData: 0, dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, time: 0, dwExtraInfo: 0 } },
  };
}

function createWindowsBackend(koffi = require('koffi')) {
  const { INPUT } = defineWindowsInputTypes(koffi);
  const user32 = koffi.load('user32.dll');
  const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t cInputs, INPUT *pInputs, int cbSize)');
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
  const size = koffi.sizeof(INPUT);
  const send = (input) => {
    if (SendInput(1, input, size) !== 1) console.error('[inputSender] SendInput was blocked (is PTFS running as administrator?)');
  };
  return {
    down: (key) => send(keyboardInput(key, false)),
    up: (key) => send(keyboardInput(key, true)),
    moveMouse: (x, y) => send(mouseMoveInput(x, y, {
      left: GetSystemMetrics(SM_XVIRTUALSCREEN),
      top: GetSystemMetrics(SM_YVIRTUALSCREEN),
      width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
      height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
    })),
  };
}

// ---- macOS / Linux: the OS's own tools

function runDetached(cmd, args) {
  const proc = spawn(cmd, args, { stdio: 'ignore' });
  proc.on('error', (err) => console.error(`[inputSender] ${cmd} failed: ${err.message}`));
}

function createMacBackend() {
  return {
    // One osascript per press keeps key down and key up together, so an
    // interrupted app can't leave a key stuck down.
    pressFor: (key, ms) =>
      runDetached('osascript', ['-e', `tell application "System Events"
key down (key code ${key[2]})
delay ${(ms / 1000).toFixed(3)}
key up (key code ${key[2]})
end tell`]),
    // A real mouse-moved event (not just warping the cursor), so the game
    // sees it like a hand on the mouse.
    moveMouse: (x, y) =>
      runDetached('osascript', ['-l', 'JavaScript', '-e',
        `ObjC.import('CoreGraphics'); $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, {x: ${Math.round(x)}, y: ${Math.round(y)}}, $.kCGMouseButtonLeft));`]),
  };
}

function createLinuxBackend() {
  return {
    pressFor: (key, ms) => runDetached('xdotool', ['keydown', key[3], 'sleep', (ms / 1000).toFixed(3), 'keyup', key[3]]),
    moveMouse: (x, y) => runDetached('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y))]),
  };
}

/**
 * Creates an input sender. `press(name, ms)` holds that key for `ms`
 * milliseconds (a key pressed again while still held is extended rather
 * than released and re-pressed); `moveMouse(x, y)` puts the cursor at that
 * physical screen pixel.
 */
function createInputSender(platform = process.platform) {
  const backend = platform === 'win32' ? createWindowsBackend() : platform === 'darwin' ? createMacBackend() : createLinuxBackend();
  const held = new Map(); // key name -> release timer (Windows backend only)

  function press(name, ms) {
    const key = KEYS[name];
    if (!key) throw new Error(`Unknown key "${name}"`);
    const holdMs = Math.max(10, Math.min(MAX_HOLD_MS, Math.round(ms)));

    if (backend.pressFor) {
      backend.pressFor(key, holdMs);
      return;
    }
    if (held.has(name)) clearTimeout(held.get(name));
    else backend.down(key);
    held.set(name, setTimeout(() => {
      held.delete(name);
      backend.up(key);
    }, holdMs));
  }

  function releaseAll() {
    for (const [name, timer] of held) {
      clearTimeout(timer);
      backend.up(KEYS[name]);
    }
    held.clear();
  }

  return {
    press,
    releaseAll,
    moveMouse: (x, y) => backend.moveMouse(x, y),
    close() {
      releaseAll();
      backend.close?.();
    },
  };
}

module.exports = {
  createInputSender,
  KEY_NAMES: Object.keys(KEYS),
  // Exposed for tests: the exact Windows input structs, checkable on any OS.
  KEYS,
  defineWindowsInputTypes,
  createWindowsBackend,
  keyboardInput,
  mouseMoveInput,
};
