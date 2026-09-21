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

const canvas = document.getElementById('hud');
const ctx = canvas.getContext('2d');
const banner = document.getElementById('banner');
const toast = document.getElementById('toast');
const barToggleTrackingBtn = document.getElementById('barToggleTrackingBtn');
const messagesBtn = document.getElementById('barMessagesBtn');
const messagePanel = document.getElementById('messagePanel');

let armed = null; // { kind: 'drag'|'click', tag, meta, label } or null
let dragStart = null;
let savedRegions = {};
let showHud = true;
let overUi = false; // whether the cursor is currently over an interactive UI element (bar/panel)
let tracking = false;
let messages = []; // datalink (CPDLC/PDC) messages received so far, newest first
let unreadCount = 0;
let toastTimer = null;

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
  window.companion.setOverlayInteractive(overUi);
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

// ---------- Top bar / panel hit-testing ----------
// While armed, the whole window is already interactive (see arm() above),
// so the hit-test only needs to run when nothing is armed. Uses
// elementFromPoint against a shared ".overlay-ui" class rather than a fixed
// pixel region, since the message panel below can be taller than the bar
// itself and can open/close independently of it.

function updateInteractivity(e) {
  if (armed) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const nowOverUi = !!(el && el.closest && el.closest('.overlay-ui'));
  if (nowOverUi === overUi) return;
  overUi = nowOverUi;
  window.companion.setOverlayInteractive(overUi);
}

document.addEventListener('mousemove', updateInteractivity);

barToggleTrackingBtn.addEventListener('click', () => {
  window.companion.sendToControl({ tag: 'bar-toggle-tracking' });
});
document.getElementById('barSetupBtn').addEventListener('click', () => {
  window.companion.focusControlWindow();
});

// ---------- Radio panel (VHF1/2/3 + squawk) ----------
// State lives in the control window (see control.js) - this just renders
// whatever snapshot it last pushed via 'radio-state' and relays user
// interaction back via sendToControl({tag: 'radio-action', ...}), same
// round-trip shape as region/calibration clicks use.

const radioPanel = document.getElementById('radioPanel');
const radiosBtn = document.getElementById('barRadiosBtn');
let radioState = null; // last snapshot from control.js, or null before one's arrived

function toggleRadioPanel(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : radioPanel.hidden;
  radioPanel.hidden = !open;
  if (open) renderRadioPanel();
}

radiosBtn.addEventListener('click', () => toggleRadioPanel());

/**
 * A small draggable/scrollable dial. Turning it (mouse-wheel, or drag up/
 * down) calls onStep(+1) / onStep(-1) per notch - the rotation itself is
 * just a tactile cue that accumulates per step, not a literal mapping of
 * the underlying frequency/squawk range (that range is far too
 * fine-grained for one knob turn to cover 1:1). Deliberately left
 * unwrapped (no "% 360") rather than wrapping the angle back to 0 - CSS's
 * rotate() handles values past 360° fine, and wrapping it would make the
 * animated transition spin the long way around at the wrap point instead
 * of continuing to turn the same direction the knob was actually turned.
 */
function makeKnob(onStep, disabled) {
  const knob = document.createElement('div');
  knob.className = 'knob';
  const indicator = document.createElement('div');
  indicator.className = 'knob-indicator';
  knob.appendChild(indicator);
  if (disabled) {
    knob.style.opacity = '0.35';
    knob.style.cursor = 'not-allowed';
    return knob;
  }

  let rotation = 0;
  const STEP_DEG = 20;
  function applyStep(direction) {
    rotation += direction * STEP_DEG;
    indicator.style.transform = `rotate(${rotation}deg)`;
    onStep(direction);
  }

  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    applyStep(e.deltaY < 0 ? 1 : -1);
  });

  let dragging = false;
  let lastY = 0;
  const DRAG_PX_PER_STEP = 6;
  knob.addEventListener('mousedown', (e) => {
    dragging = true;
    lastY = e.clientY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dy = lastY - e.clientY; // dragging up (dy > 0) increases, matching a real radio knob
    if (Math.abs(dy) < DRAG_PX_PER_STEP) return;
    lastY = e.clientY;
    applyStep(dy > 0 ? 1 : -1);
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });

  return knob;
}

function renderRadioPanel() {
  const list = document.getElementById('radioList');
  list.innerHTML = '';
  if (!radioState) {
    list.innerHTML = '<div class="message-empty">Waiting for the control window...</div>';
    return;
  }

  for (const [key, radio] of Object.entries(radioState.radios)) {
    const row = document.createElement('div');
    row.className = 'radio-row';

    const knob = makeKnob((direction) => {
      window.companion.sendToControl({ tag: 'radio-action', action: 'step', radio: key, value: direction });
    }, radio.inop);

    const info = document.createElement('div');
    info.className = 'radio-info';
    info.innerHTML = `
      <div class="radio-label">${radio.label}${radio.inop ? ' (inop)' : ''}</div>
      <div class="radio-freqs">
        <span class="radio-active">${radio.active.toFixed(3)}</span>
        <button class="radio-swap" ${radio.inop ? 'disabled' : ''}>⇄</button>
        <span class="radio-standby">${radio.standby.toFixed(3)}</span>
      </div>
      ${radio.switchable ? `<button class="radio-power">${radio.inop ? 'Switch on' : 'Switch off'}</button>` : ''}
    `;
    info.querySelector('.radio-swap').addEventListener('click', () => {
      window.companion.sendToControl({ tag: 'radio-action', action: 'swap', radio: key });
    });
    const powerBtn = info.querySelector('.radio-power');
    if (powerBtn) {
      powerBtn.addEventListener('click', () => {
        window.companion.sendToControl({ tag: 'radio-action', action: 'power', radio: key });
      });
    }

    row.appendChild(knob);
    row.appendChild(info);
    list.appendChild(row);
  }

  const squawkRow = document.createElement('div');
  squawkRow.className = 'radio-row';
  const squawkKnob = makeKnob((direction) => {
    window.companion.sendToControl({ tag: 'radio-action', action: 'squawkStep', value: direction });
  }, false);
  const squawkInfo = document.createElement('div');
  squawkInfo.className = 'radio-info';
  squawkInfo.innerHTML = `
    <div class="radio-label">Squawk${radioState.identing ? ' - IDENT' : ''}</div>
    <div class="radio-freqs">
      <span class="radio-active">${radioState.squawk}</span>
      <button class="radio-power">Ident</button>
    </div>
  `;
  squawkInfo.querySelector('.radio-power').addEventListener('click', () => {
    window.companion.sendToControl({ tag: 'radio-action', action: 'ident' });
  });
  squawkRow.appendChild(squawkKnob);
  squawkRow.appendChild(squawkInfo);
  list.appendChild(squawkRow);
}

// ---------- Datalink (CPDLC/PDC) messages ----------

function describeMessage(m) {
  if (m.kind === 'contact') return `Contact ${m.facility || 'ATC'} on ${m.frequency || '(freq unknown)'}`;
  if (m.kind === 'pdc') return `PDC: ${m.clearance}`;
  if (m.broadcast) return `📢 ${m.text || '(empty message)'}`;
  return m.text || '(empty message)';
}

function renderMessagePanel() {
  document.getElementById('messagesBadge').textContent = unreadCount > 0 ? String(unreadCount) : '';
  document.getElementById('messagesBadge').hidden = unreadCount === 0;

  const list = document.getElementById('messageList');
  if (messages.length === 0) {
    list.innerHTML = '<div class="message-empty">No messages yet.</div>';
    return;
  }
  list.innerHTML = messages
    .map(
      (m) => `
      <div class="message-item${m.broadcast ? ' message-broadcast' : ''}">
        <div class="message-meta">${m.broadcast ? 'Broadcast · ' : ''}${m.fromPosition || 'ATC'} · ${new Date(m.createdAt).toLocaleTimeString()}</div>
        <div class="message-body">${describeMessage(m).replace(/</g, '&lt;')}</div>
      </div>`
    )
    .join('');
}

function toggleMessagePanel(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : messagePanel.hidden;
  messagePanel.hidden = !open;
  if (open) {
    unreadCount = 0;
    renderMessagePanel();
  }
}

messagesBtn.addEventListener('click', () => toggleMessagePanel());

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = describeMessage(message);
  toast.classList.toggle('broadcast', !!message.broadcast);
  toast.style.display = 'block';
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, 8000);
}

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
  } else if (command.type === 'cpdlc-messages') {
    const incoming = command.messages || [];
    messages = [...incoming].reverse().concat(messages).slice(0, 30);
    unreadCount += incoming.length;
    renderMessagePanel();
    for (const m of incoming) showToast(m);
  } else if (command.type === 'radio-state') {
    radioState = { radios: command.radios, squawk: command.squawk, identing: command.identing };
    if (!radioPanel.hidden) renderRadioPanel();
  }
});
