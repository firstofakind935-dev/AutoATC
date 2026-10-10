// Remote-control page for the companion app's FMS / autopilot. Served two
// ways with the same files: by the companion app itself on the home Wi-Fi
// (lib/remoteServer.js, 6-digit code), or from anywhere by the flight
// planner's relay (planner/lib/relay.js, 12-character code; a copy of this
// folder lives in planner/public/remote/ - see scripts/sync-remote-page.js).
// API paths are relative, so both work. The companion app owns all flight
// state; this page draws the view it pushes (with the same fmsView.js as the
// PC window) and posts every button press back.

/* global FmsView */

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'autoatc-fms-code';
let code = null;
let events = null;
let mounted = false;
let live = false;
let retryTimer = null;

// Codes are typed with or without dashes/spaces, any case.
const normalizeCode = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const validCode = (c) => /^\d{6}$/.test(c) || /^[A-Z0-9]{12}$/.test(c);

function setConn(text, good) {
  $('conn').textContent = text;
  $('conn').className = `pill ${good === true ? 'good' : good === false ? 'bad' : ''}`;
}

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
  clearTimeout(retryTimer);
  $('cockpit').hidden = true;
  $('pairing').hidden = false;
  $('pair-error').textContent = message;
}

async function send(message) {
  try {
    const res = await fetch('api/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pairing-Code': code },
      body: JSON.stringify(message),
    });
    if (res.status === 401) showPairing('The pairing code changed - enter the new one.');
    if (res.status === 404) setConn('PC OFFLINE', false);
  } catch {
    setConn('NO INTERNET', false);
  }
}

function connect() {
  if (events) events.close();
  clearTimeout(retryTimer);
  events = new EventSource(`api/events?code=${encodeURIComponent(code)}`);
  setConn('CONNECTING');
  events.addEventListener('view', (e) => {
    const vm = JSON.parse(e.data);
    live = vm.status.live;
    FmsView.render(vm);
    setConn('CONNECTED', true);
    $('live-toggle').textContent = live ? 'LIVE · tap for DRY RUN' : 'DRY RUN';
  });
  events.onerror = async () => {
    // Work out why: a new pairing code means pair again; the PC being
    // offline (app closed, PC asleep) means keep trying until it's back.
    const res = await fetch(`api/check?code=${encodeURIComponent(code)}`).catch(() => null);
    if (res && res.status === 401) return showPairing('The pairing code changed - enter the new one.');
    if (!res || res.status === 404) {
      events.close();
      setConn(res ? 'PC OFFLINE' : 'NO CONNECTION', false);
      retryTimer = setTimeout(connect, 5000);
      return null;
    }
    setConn('RECONNECTING', false); // EventSource retries by itself
    return null;
  };
}

async function pair(value) {
  const res = await fetch(`api/check?code=${encodeURIComponent(value)}`).catch(() => null);
  if (!res) return showPairing('Cannot connect. Check this device is online (and on the same Wi-Fi, for a 6-digit code).');
  if (res.status === 404) return showPairing('No pilot online with that code. Is the companion app open with remote control turned on?');
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
  const value = normalizeCode($('pair-code').value);
  if (validCode(value)) pair(value);
  else $('pair-error').textContent = 'Enter the 6-digit or 12-character code from the companion app.';
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

const fromUrl = normalizeCode(new URLSearchParams(location.search).get('code'));
const saved = fromUrl || readStoredCode();
if (saved && validCode(saved)) pair(saved);
