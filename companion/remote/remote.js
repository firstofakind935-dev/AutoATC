// Remote-control page for the companion app's FMS / autopilot (served by
// lib/remoteServer.js). The companion app owns all flight state; this page
// draws the view it pushes (with the same fmsView.js as the PC window) and
// posts every button press back.

/* global FmsView */

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'autoatc-fms-code';
let code = null;
let events = null;
let mounted = false;
let live = false;

function readStoredCode() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function storeCode(value) {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing etc. - the pilot just re-enters the code next time.
  }
}

function showPairing(message = '') {
  if (events) events.close();
  events = null;
  $('cockpit').hidden = true;
  $('pairing').hidden = false;
  $('pair-error').textContent = message;
}

async function send(message) {
  try {
    const res = await fetch('/api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pairing-Code': code },
      body: JSON.stringify(message),
    });
    if (res.status === 401) showPairing('The pairing code changed - enter the new one.');
  } catch {
    $('conn').textContent = 'OFFLINE';
    $('conn').className = 'pill bad';
  }
}

function connect() {
  if (events) events.close();
  events = new EventSource(`/api/events?code=${encodeURIComponent(code)}`);
  $('conn').textContent = 'CONNECTING';
  $('conn').className = 'pill';
  events.addEventListener('view', (e) => {
    const vm = JSON.parse(e.data);
    live = vm.status.live;
    FmsView.render(vm);
    $('conn').textContent = 'CONNECTED';
    $('conn').className = 'pill good';
    $('live-toggle').textContent = live ? 'LIVE · tap for DRY RUN' : 'DRY RUN';
  });
  events.onerror = async () => {
    $('conn').textContent = 'RECONNECTING';
    $('conn').className = 'pill bad';
    // A closed stream can mean a new pairing code - check before retrying.
    const res = await fetch(`/api/check?code=${encodeURIComponent(code)}`).catch(() => null);
    if (res && res.status === 401) showPairing('The pairing code changed - enter the new one.');
  };
}

async function pair(value) {
  const res = await fetch(`/api/check?code=${encodeURIComponent(value)}`).catch(() => null);
  if (!res) return showPairing('Cannot reach the companion app. Is remote control turned on, and is this device on the same Wi-Fi?');
  if (res.status === 429) return showPairing('Too many wrong codes - wait a minute and try again.');
  if (res.status !== 204) {
    storeCode(null);
    return showPairing('That code is not right.');
  }
  code = value;
  storeCode(value);
  $('pairing').hidden = true;
  $('cockpit').hidden = false;
  if (!mounted) {
    FmsView.mount(send);
    mounted = true;
  }
  connect();
  return null;
}

$('pair-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('pair-code').value.replace(/\D/g, '');
  if (value.length === 6) pair(value);
  else $('pair-error').textContent = 'The code is 6 digits.';
});

$('live-toggle').addEventListener('click', () => {
  if (live) send({ type: 'dry-run' });
});

$('unpair').addEventListener('click', () => {
  storeCode(null);
  showPairing();
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.pane')) p.classList.toggle('active', p.dataset.pane === tab.dataset.tab);
  });
}

const fromUrl = new URLSearchParams(location.search).get('code');
const saved = fromUrl || readStoredCode();
if (saved) pair(saved);
