// Push-to-talk for the in-app radio: the key is watched while the game has focus; down/up are reported once each.
const test = require('node:test');
const assert = require('node:assert');
const { watchPttKey, PTT_KEYS } = require('../companion/lib/pttKey');

test('reports press and release of the chosen key, and switches keys', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const held = new Set();
  const events = [];
  const w = watchPttKey((down) => events.push(down), { key: 'Right Ctrl', getKeyState: (vk) => held.has(vk) });
  assert.strictEqual(w.supported, true);
  t.mock.timers.tick(50);
  held.add(PTT_KEYS['Right Ctrl']);
  t.mock.timers.tick(50);
  t.mock.timers.tick(50);
  held.delete(PTT_KEYS['Right Ctrl']);
  t.mock.timers.tick(50);
  assert.deepStrictEqual(events, [true, false]);
  w.setKey('Mouse button 4');
  held.add(PTT_KEYS['Right Ctrl']);
  t.mock.timers.tick(50);
  assert.deepStrictEqual(events, [true, false], 'the old key no longer counts');
  held.add(PTT_KEYS['Mouse button 4']);
  t.mock.timers.tick(50);
  assert.deepStrictEqual(events, [true, false, true]);
  w.stop();
  assert.deepStrictEqual(events, [true, false, true, false], 'stopping releases');
});

test('not supported off Windows without a key reader', () => {
  const w = watchPttKey(() => {}, { platform: 'linux' });
  assert.strictEqual(w.supported, false);
  w.stop();
});
