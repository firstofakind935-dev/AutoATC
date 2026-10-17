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
  let vk = PTT_KEYS[key] || PTT_KEYS[DEFAULT_PTT_KEY];
  let down = false;
  const timer = read ? setInterval(() => {
    let now;
    try { now = read(vk); } catch { now = false; }
    if (now !== down) { down = now; onChange(down); }
  }, POLL_MS) : null;
  return {
    supported: Boolean(read),
    setKey(name) {
      vk = PTT_KEYS[name] || PTT_KEYS[DEFAULT_PTT_KEY];
      if (down) { down = false; onChange(false); }
    },
    stop() { if (timer) clearInterval(timer); if (down) { down = false; onChange(false); } },
  };
}

module.exports = { watchPttKey, PTT_KEYS, DEFAULT_PTT_KEY };
