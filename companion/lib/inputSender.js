// The autopilot's hands: presses keys (throttle) and moves the mouse
// cursor (pitch and bank - PTFS steers toward the cursor) as if a person
// were doing it. Runs in the Electron main process (see main.js's
// 'autopilot-press' / 'autopilot-steer' handlers), never in a renderer.
//
// One method per OS, all built into the OS (nothing to install on Windows
// or macOS):
// - Windows: a long-lived PowerShell process calling SendInput - hardware
//   scan codes for keys, absolute moves for the mouse - which games read
//   like a real keyboard and mouse.
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

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AutoAtcKeys {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void Init() { SetProcessDPIAware(); }
  // Absolute move in physical pixels across the whole virtual desktop.
  public static void Move(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    INPUT input = new INPUT();
    input.type = 0;
    input.u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
    input.u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
    input.u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000; // MOVE | ABSOLUTE | VIRTUALDESK
    SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Send(ushort scan, bool extended, bool up) {
    INPUT input = new INPUT();
    input.type = 1;
    input.u.ki.wScan = scan;
    input.u.ki.dwFlags = (uint)(0x0008 | (extended ? 0x0001 : 0) | (up ? 0x0002 : 0));
    SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
[AutoAtcKeys]::Init()
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $p = $line.Split(' ')
  if ($p[0] -eq 'move') { [AutoAtcKeys]::Move([int]$p[1], [int]$p[2]) }
  else { [AutoAtcKeys]::Send([uint16]$p[1], $p[2] -eq '1', $p[0] -eq 'up') }
}
`;

function createWindowsBackend() {
  // The script goes in as -EncodedCommand so stdin is left free for the
  // script's own command loop (one "down|up <scan> <extended>" per line).
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  proc.on('error', (err) => console.error(`[inputSender] PowerShell failed to start: ${err.message}`));
  proc.stderr.on('data', (d) => console.error(`[inputSender] ${d}`));
  // Lines written before Add-Type finishes compiling just wait in the pipe.
  const send = (dir, [scan, extended]) => proc.stdin.write(`${dir} ${scan} ${extended ? 1 : 0}\n`);
  return {
    down: (key) => send('down', key),
    up: (key) => send('up', key),
    moveMouse: (x, y) => proc.stdin.write(`move ${Math.round(x)} ${Math.round(y)}\n`),
    close: () => proc.kill(),
  };
}

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

module.exports = { createInputSender, KEY_NAMES: Object.keys(KEYS) };
