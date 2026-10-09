// The autopilot's Windows input: real SendInput structs, checked byte by
// byte against the Win32 layout - runs on any OS, no Windows needed.
const test = require('node:test');
const assert = require('node:assert/strict');

let koffi = null;
try {
  koffi = require('../companion/node_modules/koffi');
} catch {
  // Skipped below.
}
const skip = !koffi && 'run "npm install" in companion/ first';
const sender = koffi && require('../companion/lib/inputSender');

function bytesOf(input) {
  const { INPUT } = sender.defineWindowsInputTypes(koffi);
  const buf = Buffer.alloc(koffi.sizeof(INPUT));
  koffi.encode(buf, INPUT, input);
  return buf;
}

test('INPUT matches the 64-bit Windows layout', { skip }, () => {
  const { INPUT } = sender.defineWindowsInputTypes(koffi);
  assert.equal(koffi.sizeof(INPUT), 40);
  assert.equal(koffi.offsetof(INPUT, 'u'), 8);
});

test('a key press is a hardware scan code, as games read it', { skip }, () => {
  const b = bytesOf(sender.keyboardInput(sender.KEYS.W, false));
  assert.equal(b.readUInt32LE(0), 1, 'INPUT_KEYBOARD');
  assert.equal(b.readUInt16LE(8), 0, 'no virtual-key code');
  assert.equal(b.readUInt16LE(10), 0x11, 'W scan code');
  assert.equal(b.readUInt32LE(12), 0x0008, 'KEYEVENTF_SCANCODE');
});

test('releasing an arrow key sets the extended and key-up flags', { skip }, () => {
  const b = bytesOf(sender.keyboardInput(sender.KEYS.ArrowUp, true));
  assert.equal(b.readUInt16LE(10), 0x48);
  assert.equal(b.readUInt32LE(12), 0x0008 | 0x0001 | 0x0002);
});

test('a mouse move is absolute across the whole virtual desktop', { skip }, () => {
  const desk = { left: -1920, top: 0, width: 3840, height: 1080 }; // a monitor left of the main one
  const b = bytesOf(sender.mouseMoveInput(0, 540, desk));
  assert.equal(b.readUInt32LE(0), 0, 'INPUT_MOUSE');
  assert.equal(b.readInt32LE(8), Math.round((1920 * 65535) / 3839), 'dx');
  assert.equal(b.readInt32LE(12), Math.round((540 * 65535) / 1079), 'dy');
  assert.equal(b.readUInt32LE(20), 0x0001 | 0x8000 | 0x4000, 'MOVE | ABSOLUTE | VIRTUALDESK');
});

test('the Windows backend calls SendInput itself - no helper process', { skip }, () => {
  const calls = [];
  const metrics = { 76: 0, 77: 0, 78: 1920, 79: 1080 };
  const fakeKoffi = Object.assign(Object.create(koffi), {
    struct: koffi.struct, union: koffi.union, sizeof: koffi.sizeof,
    load: (dll) => {
      assert.equal(dll, 'user32.dll');
      return {
        func: (proto) => (proto.includes('SendInput')
          ? (count, input, size) => { calls.push({ count, input, size }); return 1; }
          : (index) => metrics[index]),
      };
    },
  });
  const childProcess = require('child_process');
  const realSpawn = childProcess.spawn;
  childProcess.spawn = () => { throw new Error('must not spawn a process'); };
  try {
    const backend = sender.createWindowsBackend(fakeKoffi);
    backend.down(sender.KEYS.S);
    backend.up(sender.KEYS.S);
    backend.moveMouse(960, 540);
  } finally {
    childProcess.spawn = realSpawn;
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.count === 1 && c.size === 40));
  assert.equal(calls[0].input.u.ki.wScan, 0x1f, 'S down');
  assert.equal(calls[1].input.u.ki.dwFlags & 0x0002, 0x0002, 'S up');
  assert.equal(calls[2].input.u.mi.dx, Math.round((960 * 65535) / 1919));
});
