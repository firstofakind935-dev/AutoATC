// Runs in the transparent, click-through-by-default overlay window that
// sits directly on top of the game. It has three jobs:
//  1. Draw the saved region boxes as a passive HUD.
//  2. While "armed" by the control window, capture exactly one drag (a
//     region box) or one click (a calibration/position point) in real
//     screen coordinates, then go straight back to click-through.
//  3. Host a persistent top bar (like a game overlay HUD) that stays
//     clickable even though the rest of the window is click-through, via
//     the standard Electron trick: toggle setIgnoreMouseEvents() based on
//     whether the cursor is currently over the bar.

const TOPBAR_HEIGHT = 40;

const canvas = document.getElementById('hud');
const ctx = canvas.getContext('2d');
const banner = document.getElementById('banner');
const barToggleTrackingBtn = document.getElementById('barToggleTrackingBtn');

let armed = null; // { kind: 'drag'|'click', tag, meta, label } or null
let dragStart = null;
let savedRegions = {};
let showHud = true;
let overBar = false; // whether the cursor is currently over the top bar
let tracking = false;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  draw();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!showHud) return;
  const labels = [
    ['heading', '#e11d48'],
    ['info', '#2563eb'],
    ['minimap', '#16a34a'],
  ];
  ctx.lineWidth = 2;
  for (const [key, color] of labels) {
    const r = savedRegions[key];
    if (!r) continue;
    ctx.strokeStyle = color;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
}

function setBanner(text) {
  if (!text) {
    banner.style.display = 'none';
    return;
  }
  banner.textContent = text;
  banner.style.display = 'block';
}

// ---------- Region/calibration arm-disarm (unrelated to the bar) ----------

function arm(command) {
  armed = command;
  window.companion.setOverlayInteractive(true);
  setBanner(command.label || (command.kind === 'drag' ? `Drag a box over the ${command.tag}...` : 'Click on your game...'));
}

function disarm() {
  armed = null;
  dragStart = null;
  setBanner(null);
  draw();
  // Interactivity now depends purely on cursor position again (see
  // updateInteractivity below) rather than being forced on for the arm -
  // restore whatever it was last known to be; if the cursor has since
  // moved off the bar, the next mousemove corrects it immediately.
  window.companion.setOverlayInteractive(overBar);
}

document.addEventListener('mousedown', (e) => {
  if (!armed || armed.kind !== 'drag') return;
  dragStart = { x: e.clientX, y: e.clientY };
});

document.addEventListener('mousemove', (e) => {
  if (!armed || armed.kind !== 'drag' || !dragStart) return;
  draw();
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  ctx.strokeRect(dragStart.x, dragStart.y, e.clientX - dragStart.x, e.clientY - dragStart.y);
});

document.addEventListener('mouseup', (e) => {
  if (!armed) return;

  if (armed.kind === 'drag') {
    if (!dragStart) return;
    const x0 = Math.min(dragStart.x, e.clientX);
    const y0 = Math.min(dragStart.y, e.clientY);
    const w = Math.abs(e.clientX - dragStart.x);
    const h = Math.abs(e.clientY - dragStart.y);
    dragStart = null;
    if (w < 5 || h < 5) return; // an accidental click mid-drag, not a real box - stay armed
    const tag = armed.tag;
    window.companion.sendToControl({ tag, rect: { x: x0, y: y0, w, h } });
    disarm();
    return;
  }

  // 'click'
  window.companion.sendToControl({ tag: armed.tag, point: { x: e.clientX, y: e.clientY }, meta: armed.meta });
  disarm();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && armed) {
    window.companion.sendToControl({ tag: armed.tag, cancelled: true });
    disarm();
  }
});

// ---------- Top bar hit-testing ----------
// While armed, the whole window is already interactive (see arm() above),
// so the hit-test only needs to run when nothing is armed.

function updateInteractivity(e) {
  if (armed) return;
  const nowOverBar = e.clientY >= 0 && e.clientY < TOPBAR_HEIGHT;
  if (nowOverBar === overBar) return;
  overBar = nowOverBar;
  window.companion.setOverlayInteractive(overBar);
}

document.addEventListener('mousemove', updateInteractivity);

barToggleTrackingBtn.addEventListener('click', () => {
  window.companion.sendToControl({ tag: 'bar-toggle-tracking' });
});
document.getElementById('barSetupBtn').addEventListener('click', () => {
  window.companion.focusControlWindow();
});

// ---------- Commands from the control window ----------

window.companion.onOverlayCommand((command) => {
  if (command.type === 'arm') {
    arm(command);
  } else if (command.type === 'draw-regions') {
    savedRegions = command.regions || {};
    draw();
  } else if (command.type === 'set-hud-visible') {
    showHud = command.visible;
    draw();
  } else if (command.type === 'disarm') {
    disarm();
  } else if (command.type === 'set-bar-status') {
    tracking = !!command.tracking;
    document.getElementById('barFixText').textContent = command.fixSummary || 'No fix';
    document.getElementById('barDotFix').className = 'bar-dot' + (command.fixSummary ? ' good' : '');
    document.getElementById('barTrackingText').textContent = tracking ? 'Running' : 'Stopped';
    document.getElementById('barDotTracking').className = 'bar-dot' + (tracking ? ' good' : '');
    barToggleTrackingBtn.textContent = tracking ? 'Stop tracking' : 'Start tracking';
    barToggleTrackingBtn.classList.toggle('armed', tracking);
  }
});
