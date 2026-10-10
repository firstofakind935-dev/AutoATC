// PFD + MFD for iPads and other big screens. Pairs the same way as the MCDU remote page (same stored
// code) and draws the `flight` part of the cockpit view the companion pushes: position, speeds,
// the route and the autopilot's modes. Attitude is estimated - the game only sends heading,
// altitude and speed - from turn rate (bank) and climb rate (pitch).

const STORAGE_KEY = 'autoatc-fms-code';
const $ = (id) => document.getElementById(id);
const COLORS = { sky: '#1d5fa8', ground: '#7a4a1f', white: '#f2f6fa', green: '#3fe06b', magenta: '#ff4fd8', cyan: '#4fd8ff', amber: '#ffb200', dim: '#7c8794', red: '#ff5a4d' };
const RANGES = [5, 10, 20, 40, 80, 160];
const rad = (d) => (d * Math.PI) / 180;
const norm360 = (d) => ((d % 360) + 360) % 360;
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

let flight = null;
let lastRx = 0;
let rangeIndex = 2;
let headingUp = true;
const hist = []; // {t, alt, hdg} - for climb rate, turn rate and the profile trail
const smooth = { bank: 0, pitch: 0, vs: 0 };

// ---------------------------------------------------------------- connection

function code() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function setConn(text, cls) { $('conn').textContent = text; $('conn').className = `pill ${cls || ''}`; }

function connect() {
  const c = code();
  if (!c) { location.href = './'; return; } // pair on the MCDU page first
  const events = new EventSource(`api/events?code=${encodeURIComponent(c)}`);
  events.addEventListener('view', (e) => {
    const vm = JSON.parse(e.data);
    flight = vm.flight || null;
    lastRx = Date.now();
    if (flight?.t) ingest(flight.t);
    setConn('CONNECTED', 'good');
    const age = flight?.t ? Math.round(flight.t.ageMs / 1000) : null;
    $('trk').textContent = flight?.t ? `TRACKING ${age}s ago` : 'NO TRACKING DATA';
    $('trk').className = `pill ${flight?.t && age < 15 ? 'good' : 'bad'}`;
  });
  events.onerror = async () => {
    const res = await fetch(`api/check?code=${encodeURIComponent(c)}`).catch(() => null);
    if (res && res.status === 401) { location.href = './'; return; }
    setConn(res && res.status !== 404 ? 'RECONNECTING' : 'PC OFFLINE', 'bad');
  };
}

// Derives climb rate, turn rate, bank and pitch from the stream of positions.
function ingest(t) {
  const now = Date.now();
  if (typeof t.altFt !== 'number' || typeof t.headingDeg !== 'number') return;
  const prev = hist[hist.length - 1];
  if (prev && now - prev.t < 400) return;
  hist.push({ t: now, alt: t.altFt, hdg: t.headingDeg });
  while (hist.length > 2 && now - hist[0].t > 600_000) hist.shift();
  const ref = [...hist].reverse().find((h) => now - h.t >= 3000);
  if (!ref) return;
  const dt = (now - ref.t) / 1000;
  const vs = ((t.altFt - ref.alt) / dt) * 60;
  const turn = angDiff(t.headingDeg, ref.hdg) / dt; // deg/s
  const v = Math.max(40, (t.speedKt || 120) * 0.5144);
  const bank = (Math.atan((rad(turn) * v) / 9.81) * 180) / Math.PI;
  const gamma = (Math.atan2(vs * 0.00508, v) * 180) / Math.PI;
  const k = 0.5;
  smooth.vs += (vs - smooth.vs) * k;
  smooth.bank += (Math.max(-45, Math.min(45, bank)) - smooth.bank) * k;
  smooth.pitch += (Math.max(-15, Math.min(20, gamma + 2)) - smooth.pitch) * k;
}

// ---------------------------------------------------------------- canvas helpers

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
const text = (g, s, x, y, color = COLORS.white, size = 16, align = 'center', weight = '600') => {
  g.fillStyle = color; g.font = `${weight} ${size}px ui-monospace, Menlo, Consolas, monospace`;
  g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, x, y);
};
const line = (g, x1, y1, x2, y2, color, width = 2) => {
  g.strokeStyle = color; g.lineWidth = width; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
};

// ---------------------------------------------------------------- PFD

function drawPfd() {
  const { g, w, h } = setup($('pfd'));
  g.clearRect(0, 0, w, h);
  const t = flight?.t;
  const s = Math.min(w * 0.72, h);
  const cx = w / 2, cy = h * 0.46;
  const pxPerDeg = s / 38;

  // Horizon: sky/ground, rotated by bank, shifted by pitch.
  g.save();
  g.beginPath(); g.rect(w * 0.02, h * 0.1, w * 0.96, h * 0.74); g.clip();
  g.translate(cx, cy); g.rotate(rad(-smooth.bank));
  const off = smooth.pitch * pxPerDeg;
  g.fillStyle = COLORS.sky; g.fillRect(-w, -h * 2 + off, w * 2, h * 2);
  g.fillStyle = COLORS.ground; g.fillRect(-w, off, w * 2, h * 2);
  line(g, -w, off, w, off, COLORS.white, 2);
  for (let p = -20; p <= 20; p += 5) {
    if (p === 0) continue;
    const y = off - p * pxPerDeg, half = p % 10 === 0 ? s * 0.12 : s * 0.06;
    line(g, -half, y, half, y, COLORS.white, 2);
    if (p % 10 === 0) { text(g, String(Math.abs(p)), -half - 18, y, COLORS.white, 13); text(g, String(Math.abs(p)), half + 18, y, COLORS.white, 13); }
  }
  g.restore();

  // Bank scale + pointer.
  g.save(); g.translate(cx, cy);
  const R = s * 0.34;
  for (const b of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const a = rad(b - 90), len = b % 30 === 0 ? 14 : 8;
    line(g, Math.cos(a) * R, Math.sin(a) * R, Math.cos(a) * (R + len), Math.sin(a) * (R + len), COLORS.white, 2);
  }
  g.rotate(rad(-smooth.bank));
  g.fillStyle = COLORS.amber; g.beginPath(); g.moveTo(0, -R + 2); g.lineTo(-8, -R + 16); g.lineTo(8, -R + 16); g.closePath(); g.fill();
  g.restore();

  // Aircraft symbol.
  g.lineWidth = 4; g.strokeStyle = COLORS.amber;
  g.beginPath(); g.moveTo(cx - s * 0.16, cy); g.lineTo(cx - s * 0.05, cy); g.lineTo(cx - s * 0.05, cy + 10); g.stroke();
  g.beginPath(); g.moveTo(cx + s * 0.16, cy); g.lineTo(cx + s * 0.05, cy); g.lineTo(cx + s * 0.05, cy + 10); g.stroke();
  g.fillStyle = COLORS.amber; g.fillRect(cx - 4, cy - 4, 8, 8);

  tapeSpeed(g, w, h, cy, t, flight?.ap?.targetSpeedKt);
  tapeAlt(g, w, h, cy, t, flight?.ap?.targetAltFt);
  tapeHeading(g, w, h, t, flight?.ap?.targetHeadingDeg);
  drawFma(g, w, h);
  if (!t) text(g, 'NO POSITION DATA', cx, cy + s * 0.22, COLORS.amber, 22);
}

function tapeSpeed(g, w, h, cy, t, target) {
  const x = w * 0.02, tw = w * 0.13, top = h * 0.1, bot = h * 0.84, per = (bot - top) / 80; // 80 kt visible
  g.fillStyle = 'rgba(8,12,18,.85)'; g.fillRect(x, top, tw, bot - top);
  const spd = t?.speedKt ?? 0;
  g.save(); g.beginPath(); g.rect(x, top, tw, bot - top); g.clip();
  for (let v = Math.floor((spd - 45) / 10) * 10; v <= spd + 45; v += 10) {
    if (v < 0) continue;
    const y = cy - (v - spd) * per;
    line(g, x + tw - 12, y, x + tw, y, COLORS.white, 2);
    if (v % 20 === 0) text(g, String(v), x + tw - 18, y, COLORS.white, 15, 'right');
  }
  if (typeof target === 'number') {
    const y = Math.max(top + 6, Math.min(bot - 6, cy - (target - spd) * per));
    g.fillStyle = COLORS.cyan; g.beginPath(); g.moveTo(x + tw, y); g.lineTo(x + tw + 12, y - 8); g.lineTo(x + tw + 12, y + 8); g.closePath(); g.fill();
  }
  g.restore();
  g.fillStyle = '#000'; g.strokeStyle = COLORS.amber; g.lineWidth = 2;
  g.fillRect(x, cy - 17, tw + 6, 34); g.strokeRect(x, cy - 17, tw + 6, 34);
  text(g, t?.speedKt != null ? String(Math.round(spd)) : '---', x + tw / 2 + 2, cy, COLORS.green, 22);
  text(g, 'SPD', x + tw / 2, top - 10, COLORS.dim, 12);
  if (typeof target === 'number') text(g, String(Math.round(target)), x + tw / 2, top + 14, COLORS.cyan, 15);
}

function tapeAlt(g, w, h, cy, t, target) {
  const tw = w * 0.14, x = w * 0.74, top = h * 0.1, bot = h * 0.84, per = (bot - top) / 800; // 800 ft visible
  g.fillStyle = 'rgba(8,12,18,.85)'; g.fillRect(x, top, tw, bot - top);
  const alt = t?.altFt ?? 0;
  g.save(); g.beginPath(); g.rect(x, top, tw, bot - top); g.clip();
  for (let v = Math.floor((alt - 450) / 100) * 100; v <= alt + 450; v += 100) {
    const y = cy - (v - alt) * per;
    line(g, x, y, x + 12, y, COLORS.white, 2);
    if (v % 200 === 0) text(g, String(v), x + 18, y, COLORS.white, 15, 'left');
  }
  if (typeof target === 'number') {
    const y = Math.max(top + 6, Math.min(bot - 6, cy - (target - alt) * per));
    g.fillStyle = COLORS.cyan; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 12, y - 8); g.lineTo(x - 12, y + 8); g.closePath(); g.fill();
  }
  g.restore();
  g.fillStyle = '#000'; g.strokeStyle = COLORS.amber; g.lineWidth = 2;
  g.fillRect(x - 6, cy - 17, tw + 6, 34); g.strokeRect(x - 6, cy - 17, tw + 6, 34);
  text(g, t?.altFt != null ? String(Math.round(alt)) : '-----', x + tw / 2, cy, COLORS.green, 22);
  text(g, 'ALT', x + tw / 2, top - 10, COLORS.dim, 12);
  if (typeof target === 'number') text(g, String(Math.round(target)), x + tw / 2, top + 14, COLORS.cyan, 15);
  // Vertical speed
  const vx = x + tw + 4;
  g.fillStyle = 'rgba(8,12,18,.85)'; g.fillRect(vx - 2, top, w * 0.98 - vx + 2, bot - top);
  text(g, 'V/S', vx + w * 0.045, top - 10, COLORS.dim, 12);
  const vs = Math.round(smooth.vs / 50) * 50;
  const y = cy - Math.max(-2000, Math.min(2000, smooth.vs)) * ((bot - top) / 2 / 2200);
  line(g, vx, cy, vx + w * 0.085, y, COLORS.green, 3);
  text(g, (vs > 0 ? '+' : '') + vs, vx + w * 0.045, bot + 14, Math.abs(vs) > 1800 ? COLORS.amber : COLORS.green, 15);
}

function tapeHeading(g, w, h, t, target) {
  const y0 = h * 0.88, hw = w * 0.7, x0 = (w - hw) / 2, per = hw / 60; // 60 deg visible
  g.fillStyle = 'rgba(8,12,18,.85)'; g.fillRect(x0, y0 - 16, hw, 46);
  const hdg = t?.headingDeg ?? 0;
  g.save(); g.beginPath(); g.rect(x0, y0 - 16, hw, 46); g.clip();
  for (let d = Math.floor((hdg - 32) / 5) * 5; d <= hdg + 32; d += 5) {
    const x = w / 2 + (d - hdg) * per, label = norm360(d);
    line(g, x, y0 - 16, x, y0 - (d % 10 === 0 ? 4 : 10), COLORS.white, 2);
    if (d % 10 === 0) text(g, String(Math.round(label / 10)).padStart(2, '0'), x, y0 + 12, COLORS.white, 15);
  }
  if (typeof target === 'number') {
    const off = Math.max(-30, Math.min(30, angDiff(target, hdg)));
    const x = w / 2 + off * per;
    g.fillStyle = COLORS.cyan; g.beginPath(); g.moveTo(x - 8, y0 - 16); g.lineTo(x + 8, y0 - 16); g.lineTo(x, y0 - 2); g.closePath(); g.fill();
  }
  g.restore();
  g.fillStyle = COLORS.amber; g.beginPath(); g.moveTo(w / 2, y0 - 16); g.lineTo(w / 2 - 7, y0 - 28); g.lineTo(w / 2 + 7, y0 - 28); g.closePath(); g.fill();
  text(g, t?.headingDeg != null ? String(Math.round(norm360(hdg))).padStart(3, '0') + '°' : '---', w / 2, y0 + 44, COLORS.green, 20);
}

function drawFma(g, w, h) {
  const ap = flight?.ap;
  const phase = flight?.nav?.phase;
  const managed = { CLB: 'CLB', CRZ: 'ALT CRZ', DES: 'DES', APP: 'DES', DONE: 'ALT' }[phase] || 'VNAV';
  const cols = [
    ap?.autothrottle ? (ap.speedMode === 'MANAGED' ? 'SPEED' : 'SPD SEL') : '',
    ap ? (ap.lateral === 'LNAV' ? 'NAV' : 'HDG') : '',
    ap ? (ap.vertical === 'VNAV' ? managed : ap.vertical === 'VS' ? `V/S ${ap.selectedVsFpm > 0 ? '+' : ''}${ap.selectedVsFpm}` : 'ALT') : '',
    ap?.engaged ? 'AP1' : '',
  ];
  const cw = w / 4;
  cols.forEach((c, i) => {
    g.strokeStyle = '#1b232c'; g.strokeRect(i * cw + 4, 6, cw - 8, h * 0.07);
    text(g, c, i * cw + cw / 2, 6 + h * 0.035, COLORS.green, 16);
  });
}

// ---------------------------------------------------------------- MFD (route map)

function project(frame, ref, lat, lon) {
  const cosf = frame === 'world' ? 1 : Math.cos(rad(ref.lat));
  return { dx: (lon - ref.lon) * 60 * cosf, dy: (lat - ref.lat) * 60 };
}

function drawMfd() {
  const { g, w, h } = setup($('mfd'));
  g.fillStyle = '#04070b'; g.fillRect(0, 0, w, h);
  const f = flight;
  const t = f?.t;
  const route = f?.route || [];
  if (!route.length && !t) { text(g, 'NO ROUTE · load a plan in the MCDU', w / 2, h / 2, COLORS.dim, 20); return; }

  // Reference: the aircraft, else the middle of the route.
  const ref = t ? { lat: t.lat, lon: t.lon } : { lat: route.reduce((a, p) => a + p.lat, 0) / route.length, lon: route.reduce((a, p) => a + p.lon, 0) / route.length };
  const up = headingUp && t && typeof t.headingDeg === 'number';
  const hdg = up ? t.headingDeg : 0;
  const rangeNm = RANGES[rangeIndex];
  const cx = w / 2, cy = up ? h * 0.78 : h * 0.55;
  const scale = (up ? h * 0.7 : Math.min(w, h) * 0.45) / rangeNm;
  const toScreen = (lat, lon) => {
    const { dx, dy } = project(f.frame, ref, lat, lon);
    if (up) {
      const fwd = dx * Math.sin(rad(hdg)) + dy * Math.cos(rad(hdg));
      const right = dx * Math.cos(rad(hdg)) - dy * Math.sin(rad(hdg));
      return [cx + right * scale, cy - fwd * scale];
    }
    return [cx + dx * scale, cy - dy * scale];
  };

  // Range rings.
  g.strokeStyle = '#16202b'; g.lineWidth = 1;
  for (const frac of [0.5, 1]) { g.beginPath(); g.arc(cx, cy, rangeNm * frac * scale, up ? Math.PI : 0, up ? 2 * Math.PI : 2 * Math.PI * 1); g.stroke(); }
  text(g, `${rangeNm / 2}`, cx + 4, cy - (rangeNm / 2) * scale - 8, COLORS.dim, 12, 'left');

  // Compass marks on the outer ring (heading up).
  if (up) {
    for (let d = 0; d < 360; d += 10) {
      const a = rad(d - hdg - 90), r = rangeNm * scale;
      const x1 = cx + Math.cos(a) * r, y1 = cy + Math.sin(a) * r;
      if (y1 > cy) continue;
      const len = d % 30 === 0 ? 12 : 6;
      line(g, x1, y1, cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len), COLORS.dim, 2);
      if (d % 30 === 0) text(g, String(d / 10), cx + Math.cos(a) * (r + 14), cy + Math.sin(a) * (r + 14), COLORS.white, 12);
    }
  } else {
    text(g, 'N', cx, cy - rangeNm * scale - 12, COLORS.white, 14);
  }

  // Route.
  const pts = route.map((p) => [...toScreen(p.lat, p.lon), p]);
  for (let i = 1; i < pts.length; i++) {
    const active = i === f.active, done = i < f.active;
    line(g, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], active ? COLORS.magenta : done ? '#4a5560' : COLORS.white, active ? 3 : 2);
  }
  pts.forEach(([x, y, p], i) => {
    if (x < -40 || x > w + 40 || y < -40 || y > h + 40) return;
    const isTo = i === f.active;
    g.strokeStyle = isTo ? COLORS.magenta : i < f.active ? '#6b7682' : COLORS.white; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 7, y); g.lineTo(x, y + 7); g.lineTo(x - 7, y); g.closePath(); g.stroke();
    text(g, p.ident, x + 11, y - 4, isTo ? COLORS.magenta : COLORS.white, 14, 'left');
    const r = p.altAtFt != null ? `${p.altAtFt}` : p.altMinFt != null && p.altMaxFt != null ? `${p.altMinFt}-${p.altMaxFt}` : p.altMaxFt != null ? `-${p.altMaxFt}` : p.altMinFt != null ? `+${p.altMinFt}` : '';
    if (r) text(g, r, x + 11, y + 11, COLORS.cyan, 12, 'left');
  });

  // Aircraft.
  if (t) {
    const [ax, ay] = toScreen(t.lat, t.lon);
    g.save(); g.translate(ax, ay); g.rotate(rad((t.headingDeg || 0) - hdg));
    g.fillStyle = COLORS.amber; g.beginPath(); g.moveTo(0, -14); g.lineTo(9, 10); g.lineTo(0, 5); g.lineTo(-9, 10); g.closePath(); g.fill();
    g.restore();
    // Selected-heading line.
    const tgt = f.ap?.targetHeadingDeg;
    if (typeof tgt === 'number') {
      const a = rad(tgt - hdg - 90);
      g.setLineDash([8, 8]);
      line(g, ax, ay, ax + Math.cos(a) * rangeNm * scale, ay + Math.sin(a) * rangeNm * scale, COLORS.cyan, 2);
      g.setLineDash([]);
    }
  }

  // Info block: next waypoint, destination.
  const n = f?.nav;
  if (n) {
    text(g, n.toIdent || '-----', 14, 22, COLORS.magenta, 22, 'left');
    text(g, n.toDistanceNm != null ? `${n.toDistanceNm.toFixed(1)} NM` : '', 14, 46, COLORS.white, 16, 'left');
    if (n.xtkNm != null) text(g, `XTK ${n.xtkNm >= 0 ? 'R' : 'L'}${Math.abs(n.xtkNm).toFixed(1)}`, 14, 68, COLORS.dim, 13, 'left');
    text(g, `${f.destination || ''}`, w - 14, 22, COLORS.white, 20, 'right');
    if (n.distanceToDestNm != null) text(g, `${Math.round(n.distanceToDestNm)} NM  ${Math.floor((n.eteMin || 0) / 60)}:${String(Math.round((n.eteMin || 0) % 60)).padStart(2, '0')}`, w - 14, 44, COLORS.white, 15, 'right');
    text(g, n.phase || '', w - 14, 66, COLORS.green, 15, 'right');
  }
  text(g, up ? 'HDG UP' : 'NORTH UP', w / 2, h - 12, COLORS.dim, 12);
}

// ---------------------------------------------------------------- vertical profile

function drawProfile() {
  const { g, w, h } = setup($('profile'));
  g.fillStyle = '#04070b'; g.fillRect(0, 0, w, h);
  const f = flight;
  const route = f?.route || [];
  if (route.length < 2) { text(g, 'VERTICAL PROFILE', w / 2, h / 2, COLORS.dim, 14); return; }
  const cum = [0];
  for (let i = 1; i < route.length; i++) {
    const { dx, dy } = project(f.frame, route[i - 1], route[i].lat, route[i].lon);
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const total = cum[cum.length - 1] || 1;
  const maxAlt = Math.max(f.cruiseAltFt || 0, f.t?.altFt || 0, 3000) * 1.1;
  const L = 52, R = 14, T = 12, B = 22;
  const X = (d) => L + (d / total) * (w - L - R);
  const Y = (a) => h - B - (a / maxAlt) * (h - T - B);
  for (let a = 0; a <= maxAlt; a += maxAlt > 20000 ? 10000 : 5000) {
    line(g, L, Y(a), w - R, Y(a), '#16202b', 1);
    text(g, a >= 1000 ? `${a / 1000}k` : String(a), L - 6, Y(a), COLORS.dim, 11, 'right');
  }
  if (f.cruiseAltFt) { g.setLineDash([6, 6]); line(g, L, Y(f.cruiseAltFt), w - R, Y(f.cruiseAltFt), COLORS.dim, 1); g.setLineDash([]); }
  route.forEach((p, i) => {
    const x = X(cum[i]);
    line(g, x, h - B, x, h - B + 5, COLORS.dim, 1);
    if (route.length <= 14 || i % 2 === 0 || i === route.length - 1) text(g, p.ident, x, h - 9, i === f.active ? COLORS.magenta : COLORS.dim, 10);
    const alt = p.altAtFt ?? p.altMaxFt ?? p.altMinFt;
    if (alt != null) {
      g.fillStyle = COLORS.magenta; g.beginPath(); g.arc(x, Y(alt), 4, 0, 2 * Math.PI); g.fill();
      text(g, `${p.altMaxFt != null && p.altAtFt == null ? '-' : p.altMinFt != null && p.altAtFt == null ? '+' : ''}${alt}`, x + 6, Y(alt) - 8, COLORS.cyan, 10, 'left');
    }
  });
  // Altitude trail + the aircraft along the route.
  const t = f.t;
  if (t) {
    let along = 0;
    // project onto the leg we are flying
    const a = Math.max(1, Math.min(route.length - 1, f.active));
    const from = route[a - 1], to = route[a];
    const legV = project(f.frame, from, to.lat, to.lon), me = project(f.frame, from, t.lat, t.lon);
    const legLen = Math.hypot(legV.dx, legV.dy) || 1;
    const frac = Math.max(0, Math.min(1, (me.dx * legV.dx + me.dy * legV.dy) / (legLen * legLen)));
    along = cum[a - 1] + frac * (cum[a] - cum[a - 1]);
    const x = X(along), y = Y(t.altFt || 0);
    g.fillStyle = COLORS.amber; g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 7, y + 6); g.lineTo(x - 7, y + 6); g.closePath(); g.fill();
    if (f.nav?.pathAltFt != null) { g.strokeStyle = COLORS.green; g.lineWidth = 2; g.strokeRect(x - 4, Y(f.nav.pathAltFt) - 4, 8, 8); }
    line(g, x, y, x, h - B, 'rgba(255,178,0,.25)', 1);
  }
}

// ---------------------------------------------------------------- loop + controls

function frame() {
  drawPfd(); drawMfd(); drawProfile();
  if (lastRx && Date.now() - lastRx > 6000) setConn('NO DATA', 'bad');
  requestAnimationFrame(frame);
}

$('orient').addEventListener('click', () => { headingUp = !headingUp; $('orient').textContent = headingUp ? 'HDG UP' : 'NORTH UP'; });
const showRange = () => { $('range').textContent = `${RANGES[rangeIndex]} NM`; };
$('range-down').addEventListener('click', () => { rangeIndex = Math.max(0, rangeIndex - 1); showRange(); });
$('range-up').addEventListener('click', () => { rangeIndex = Math.min(RANGES.length - 1, rangeIndex + 1); showRange(); });
$('full').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); });
showRange();
connect();
requestAnimationFrame(frame);
