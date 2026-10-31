// Push-to-talk for the in-app radio, held down while the GAME has focus (not this app). Runs in the Electron main
// process: on Windows it asks Windows every 25 ms whether the chosen key or mouse button is down
// (GetAsyncKeyState, through koffi - the same library inputSender.js uses, nothing to install). Electron's own
// global shortcuts only report key presses, never releases, so they can't do "hold to talk".
// Elsewhere (macOS/Linux) only the in-window key and the on-screen button work - see renderer/radio.js.

// name -> Windows virtual-key code
const PTT_KEYS = {
  'Right Ctrl': 0xa3,
  'Right Alt': 0xa5,
  'Right Shift': 0xa1,
  'Caps Lock': 0x14,
  'Mouse button 4': 0x05,
  'Mouse button 5': 0x06,
  'Middle mouse button': 0x04,
  '` (backtick)': 0xc0,
  'Num 0': 0x60,
  'Insert': 0x2d,
};
const DEFAULT_PTT_KEY = 'Right Ctrl';
const POLL_MS = 25;

// Any other key or mouse button the pilot sets by pressing it ("Set talk button"): stored as "vk:<code>".
const VK_NAMES = {
  0x04: 'Middle mouse button', 0x05: 'Mouse button 4', 0x06: 'Mouse button 5',
  0x08: 'Backspace', 0x09: 'Tab', 0x0d: 'Enter', 0x13: 'Pause', 0x14: 'Caps Lock', 0x20: 'Space',
  0x21: 'Page Up', 0x22: 'Page Down', 0x23: 'End', 0x24: 'Home', 0x25: 'Left arrow', 0x26: 'Up arrow',
  0x27: 'Right arrow', 0x28: 'Down arrow', 0x2d: 'Insert', 0x2e: 'Delete',
  0x5b: 'Left Windows', 0x5c: 'Right Windows', 0x5d: 'Menu key',
  0x6a: 'Num *', 0x6b: 'Num +', 0x6d: 'Num -', 0x6e: 'Num .', 0x6f: 'Num /', 0x90: 'Num Lock', 0x91: 'Scroll Lock',
  0xa0: 'Left Shift', 0xa1: 'Right Shift', 0xa2: 'Left Ctrl', 0xa3: 'Right Ctrl', 0xa4: 'Left Alt', 0xa5: 'Right Alt',
  0xba: ';', 0xbb: '=', 0xbc: ',', 0xbd: '-', 0xbe: '.', 0xbf: '/', 0xc0: '` (backtick)', 0xdb: '[', 0xdc: '\\', 0xdd: ']', 0xde: "'",
};
for (let c = 0x30; c <= 0x39; c++) VK_NAMES[c] = String.fromCharCode(c);
for (let c = 0x41; c <= 0x5a; c++) VK_NAMES[c] = String.fromCharCode(c);
for (let n = 0; n <= 9; n++) VK_NAMES[0x60 + n] = `Num ${n}`;
for (let n = 1; n <= 24; n++) VK_NAMES[0x6f + n] = `F${n}`;
// Never offered: left/right click (the click on "Set talk button" itself), Escape (cancels), and the generic
// Shift/Ctrl/Alt codes that go down together with the left/right ones.
const NOT_CAPTURABLE = new Set([0x01, 0x02, 0x1b, 0x10, 0x11, 0x12]);

/** The virtual-key code for a stored setting: a preset name or "vk:<code>". */
function vkOf(key) {
  if (typeof key === 'string' && /^vk:\d+$/.test(key)) {
    const vk = Number(key.slice(3));
    if (vk > 0 && vk < 256 && !NOT_CAPTURABLE.has(vk)) return vk;
  }
  return PTT_KEYS[key] || PTT_KEYS[DEFAULT_PTT_KEY];
}

/** What to show for a stored setting. */
function keyLabel(key) {
  if (PTT_KEYS[key]) return key;
  const vk = vkOf(key);
  return VK_NAMES[vk] || `Key ${vk}`;
}

/**
 * Watches a key; calls onChange(true/false) when it goes down/up. Returns {setKey(name), stop(), supported}.
 * `getKeyState(vk)` may be given (tests); otherwise Windows' GetAsyncKeyState is used, or nothing on other systems.
 */
function watchPttKey(onChange, { key = DEFAULT_PTT_KEY, getKeyState = null, platform = process.platform, koffi = null } = {}) {
  let read = getKeyState;
  if (!read && platform === 'win32') {
    try {
      const k = koffi || require('koffi');
      const user32 = k.load('user32.dll');
      const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)');
      read = (vk) => (GetAsyncKeyState(vk) & 0x8000) !== 0;
    } catch (err) {
      read = null;
    }
  }
  let vk = vkOf(key);
  let down = false;
  let capturing = false;
  const timer = read ? setInterval(() => {
    if (capturing) return;
    let now;
    try { now = read(vk); } catch { now = false; }
    if (now !== down) { down = now; onChange(down); }
  }, POLL_MS) : null;
  return {
    supported: Boolean(read),
    setKey(name) {
      vk = vkOf(name);
      if (down) { down = false; onChange(false); }
    },
    /**
     * Waits for the pilot to press a key or mouse button (anywhere - the game can have focus) and resolves
     * {key: 'vk:<code>', label}, or null after `timeoutMs` or on Escape. Push-to-talk is paused meanwhile.
     */
    capture(timeoutMs = 10000) {
      if (!read) return Promise.resolve(null);
      if (down) { down = false; onChange(false); }
      capturing = true;
      const held = new Set(); // already down when we started (e.g. the mouse button that clicked): wait for a new press
      for (let c = 1; c < 256; c++) { try { if (read(c)) held.add(c); } catch { /* ignore */ } }
      return new Promise((resolve) => {
        const started = Date.now();
        const finish = (result) => { clearInterval(poll); capturing = false; resolve(result); };
        const poll = setInterval(() => {
          if (Date.now() - started > timeoutMs) return finish(null);
          for (let c = 1; c < 256; c++) {
            let isDown;
            try { isDown = read(c); } catch { isDown = false; }
            if (!isDown) { held.delete(c); continue; }
            if (held.has(c)) continue;
            if (c === 0x1b) return finish(null); // Escape cancels
            if (NOT_CAPTURABLE.has(c)) continue;
            return finish({ key: `vk:${c}`, label: VK_NAMES[c] || `Key ${c}` });
          }
        }, POLL_MS);
      });
    },
    stop() { if (timer) clearInterval(timer); if (down) { down = false; onChange(false); } },
  };
}

module.exports = { watchPttKey, PTT_KEYS, DEFAULT_PTT_KEY, VK_NAMES, vkOf, keyLabel };
