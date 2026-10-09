// AutoATC additions to the 24SPY fork (new code, written for this fork).
//   - live AutoATC aircraft drawn on the map, with radar controller tools
//   - Ground view: airport diagrams (ground/maps/<ICAO>/)
//   - Charts view: airport data (charts/<ICAO>.json) plus chart links
// Original site: 24SPY by Tiago Murteira (tiaguinho_2009), see LICENSE.md.

(function () {
  const UNITS_PER_NM = 34.19; // 24SPY map units per nautical mile (fitted to the PTFS world map)
  const POLL_MS = 3000;
  let aircraft = [];

  const airports = () => controlAreas.filter((a) => a.type === 'Airport' && Array.isArray(a.coordinates));
  const airportByIcao = (icao) => airports().find((a) => a.name === icao);

  // ---- live aircraft + radar controller tools -------------------------------
  // Data blocks, speed leaders, trails, ATC vectors, conflict alerts, range
  // rings, a measuring tool, direct-to distance/time, scratchpad and handoff
  // tags. All of it is drawn from the aircraft feed; tags and notes stay in
  // this browser (they are not sent anywhere).
  const TRAIL_POINTS = 14;
  const CA_NM = 3, CA_FT = 1000; // conflict alert: closer than this, laterally AND vertically
  const trails = new Map();       // callsign -> [[x, y], ...] in map units
  const opts = { blocks: true, trails: true, leaders: true, vectors: true, alerts: true, rings: false, scope: true, sweep: true };
  let leaderMin = 1;              // speed-leader length, minutes
  let selected = null;            // callsign
  let measure = null;             // { a: [x, y], b: [x, y] | null } while the tool is active/finished
  let measuring = false;
  let directTo = null;            // ICAO the selected aircraft is shown heading direct to
  let conflicts = new Set();
  const tags = (() => { try { return JSON.parse(localStorage.getItem('aa-tags') || '{}'); } catch (e) { return {}; } })();
  const saveTags = () => { try { localStorage.setItem('aa-tags', JSON.stringify(tags)); } catch (e) { /* private mode */ } };

  function toMapUnits(row) {
    const p = row.position || {};
    const ref = airportByIcao(p.referenceAirport);
    if (!ref || typeof p.distanceNm !== 'number' || typeof p.bearingDeg !== 'number') return null;
    const rad = (p.bearingDeg * Math.PI) / 180;
    return [ref.coordinates[0] + p.distanceNm * UNITS_PER_NM * Math.sin(rad), ref.coordinates[1] - p.distanceNm * UNITS_PER_NM * Math.cos(rad)];
  }
  const nmBetween = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / UNITS_PER_NM;
  const bearingTo = (a, b) => (((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI) + 360) % 360;

  function findConflicts() {
    const found = new Set();
    for (let i = 0; i < aircraft.length; i++) {
      for (let j = i + 1; j < aircraft.length; j++) {
        const a = aircraft[i], b = aircraft[j];
        const fa = a.row.position.altitudeFt, fb = b.row.position.altitudeFt;
        if (typeof fa !== 'number' || typeof fb !== 'number') continue;
        if (Math.min(fa, fb) < 400) continue; // on the ground / just rolling: not a conflict
        if (nmBetween(a.xy, b.xy) < CA_NM && Math.abs(fa - fb) < CA_FT) { found.add(a.row.callsign); found.add(b.row.callsign); }
      }
    }
    return found;
  }

  async function poll() {
    try {
      const rows = await fetch('/api/dashboard/positions').then((r) => r.json());
      aircraft = rows.map((row) => ({ row, xy: toMapUnits(row) })).filter((a) => a.xy);
    } catch (e) { aircraft = []; }
    const live = new Set();
    for (const { row, xy } of aircraft) {
      live.add(row.callsign);
      const t = trails.get(row.callsign) || [];
      const last = t[t.length - 1];
      if (!last || last[0] !== xy[0] || last[1] !== xy[1]) t.push(xy);
      if (t.length > TRAIL_POINTS) t.shift();
      trails.set(row.callsign, t);
    }
    for (const cs of trails.keys()) if (!live.has(cs)) trails.delete(cs);
    if (selected && !live.has(selected)) selected = null;
    conflicts = opts.alerts ? findConflicts() : new Set();
    renderPanel();
    if (typeof draw === 'function') draw();
  }

  const fl = (ft) => (typeof ft === 'number' ? String(Math.round(ft / 100)).padStart(3, '0') : '---');

  window.autoatcDraw = function (ctx, transform, scale) {
    ctx.save();
    ctx.font = '11px monospace';
    const sel = aircraft.find((a) => a.row.callsign === selected);

    // range rings around the selected aircraft (5 nm steps)
    if (opts.rings && sel) {
      const [cx, cy] = transform(sel.xy);
      ctx.strokeStyle = 'rgba(111,138,125,.45)'; ctx.fillStyle = 'rgba(111,138,125,.8)'; ctx.lineWidth = 1;
      for (let nm = 5; nm <= 15; nm += 5) {
        ctx.beginPath(); ctx.arc(cx, cy, nm * UNITS_PER_NM * scale, 0, Math.PI * 2); ctx.stroke();
        ctx.fillText(`${nm} nm`, cx + nm * UNITS_PER_NM * scale + 3, cy);
      }
    }

    for (const { row, xy } of aircraft) {
      const p = row.position, [x, y] = transform(xy);
      const isSel = row.callsign === selected, alert = conflicts.has(row.callsign);
      const color = alert ? '#ff5555' : isSel ? '#5fe8ff' : '#7dffb2';

      if (opts.trails) {
        ctx.fillStyle = 'rgba(207,227,214,.5)';
        for (const t of (trails.get(row.callsign) || []).slice(0, -1)) { const [tx, ty] = transform(t); ctx.fillRect(tx - 1, ty - 1, 2, 2); }
      }
      if (opts.leaders && p.headingDeg != null && row.speed) {
        const len = (row.speed / 60) * leaderMin * UNITS_PER_NM * scale, rad = (p.headingDeg * Math.PI) / 180;
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(rad) * len, y - Math.cos(rad) * len); ctx.stroke();
      }
      if (opts.vectors && row.assignedHeadingDeg != null) {
        const len = 5 * UNITS_PER_NM * scale, rad = (row.assignedHeadingDeg * Math.PI) / 180;
        ctx.strokeStyle = '#ffbf47'; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(rad) * len, y - Math.cos(rad) * len); ctx.stroke(); ctx.setLineDash([]);
      }
      if (alert) { ctx.strokeStyle = '#ff5555'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, CA_NM / 2 * UNITS_PER_NM * scale, 0, Math.PI * 2); ctx.stroke(); }

      // symbol
      ctx.translate(x, y); ctx.rotate(((p.headingDeg || 0) * Math.PI) / 180);
      ctx.fillStyle = color;
      ctx.fillRect(-2.5, -2.5, 5, 5);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (isSel) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.strokeRect(x - 10, y - 10, 20, 20); }

      // data block with a short leader line
      if (opts.blocks || isSel) {
        const tag = tags[row.callsign] || {};
        const lines = [`${row.callsign}${tag.handoff ? ' >' + tag.handoff : ''}`, `${fl(p.altitudeFt)} ${row.speed ? Math.round(row.speed / 10) : '--'}  ${row.aircraftType || ''}`];
        if (tag.note) lines.push(tag.note);
        if (alert) lines.unshift('CA');
        ctx.strokeStyle = 'rgba(207,227,214,.35)';
        ctx.beginPath(); ctx.moveTo(x + 6, y - 6); ctx.lineTo(x + 20, y - 18); ctx.stroke();
        ctx.fillStyle = color;
        lines.forEach((t, i) => ctx.fillText(t, x + 22, y - 14 + i * 12));
      }
    }

    // direct-to line for the selected aircraft
    if (sel && directTo) {
      const ap = airportByIcao(directTo);
      if (ap) {
        const [x, y] = transform(sel.xy), [ax, ay] = transform(ap.coordinates);
        const nm = nmBetween(sel.xy, ap.coordinates);
        ctx.strokeStyle = '#7aa7ff'; ctx.setLineDash([2, 4]); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ax, ay); ctx.stroke(); ctx.setLineDash([]);
        const eta = sel.row.speed ? ` ${Math.round((nm / sel.row.speed) * 60)} min` : '';
        ctx.fillStyle = '#7aa7ff';
        ctx.fillText(`${directTo} ${nm.toFixed(1)} nm  ${String(Math.round(bearingTo(sel.xy, ap.coordinates))).padStart(3, '0')}°${eta}`, (x + ax) / 2 + 6, (y + ay) / 2 - 6);
      }
    }

    // measuring tool
    if (measure) {
      const [x1, y1] = transform(measure.a);
      ctx.fillStyle = '#fff'; ctx.fillRect(x1 - 3, y1 - 3, 6, 6);
      if (measure.b) {
        const [x2, y2] = transform(measure.b);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        ctx.fillRect(x2 - 3, y2 - 3, 6, 6);
        const nm = nmBetween(measure.a, measure.b), brg = String(Math.round(bearingTo(measure.a, measure.b))).padStart(3, '0');
        let txt = `${nm.toFixed(1)} nm  ${brg}°`;
        if (sel && sel.row.speed) txt += `  ${Math.round((nm / sel.row.speed) * 60)} min @${sel.row.speed}kt`;
        ctx.fillText(txt, (x1 + x2) / 2 + 8, (y1 + y2) / 2 - 8);
      }
    }
    ctx.restore();
  };

  // ---- selecting / measuring with the mouse ---------------------------------
  const mapCanvas = document.getElementById('map');
  let down = null;
  mapCanvas.addEventListener('mousedown', (e) => { down = [e.clientX, e.clientY]; });
  mapCanvas.addEventListener('mouseup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) { down = null; return; } // it was a drag
    down = null;
    const r = mapCanvas.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const point = [(sx - offsetX) / scale, (sy - offsetY) / scale];
    if (measuring) {
      if (!measure || measure.b) measure = { a: point, b: null }; else measure.b = point;
      if (measure.b) { measuring = false; measureBtn.classList.remove('on'); }
      draw(); return;
    }
    let best = null, bestD = 16;
    for (const a of aircraft) {
      const [x, y] = transformCoordinates(a.xy), d = Math.hypot(x - sx, y - sy);
      if (d < bestD) { best = a.row.callsign; bestD = d; }
    }
    selected = best; directTo = null;
    renderPanel(); draw();
  });

  // ---- controller panel -----------------------------------------------------
  const ctrlStyle = document.createElement('style');
  ctrlStyle.textContent = `
  #aa-ctrl{position:fixed;top:72px;left:12px;width:250px;max-height:calc(100vh - 130px);overflow:auto;z-index:4000;background:rgba(32,32,36,.94);color:#e6e6e6;border-radius:8px;font:12px sans-serif;padding:8px 10px}
  #aa-ctrl h4{margin:8px 0 4px;font-size:12px;color:#9aa}
  #aa-ctrl label{display:flex;gap:6px;align-items:center;margin:2px 0}
  #aa-ctrl button,#aa-ctrl select,#aa-ctrl input[type=text]{background:#2b2b31;color:#fff;border:1px solid #444;border-radius:4px;padding:3px 6px;font:inherit}
  #aa-ctrl button{cursor:pointer}#aa-ctrl button.on{background:#2f5fd0;border-color:#4a7bf0}
  #aa-ctrl .row{display:flex;gap:6px;align-items:center;margin:3px 0}
  #aa-ctrl .ac{display:flex;justify-content:space-between;padding:2px 4px;border-radius:4px;cursor:pointer}
  #aa-ctrl .ac:hover{background:#3a3a42}#aa-ctrl .ac.sel{background:#3b3a20}#aa-ctrl .ac.ca{color:#ff7777}
  #aa-ctrl table{border-collapse:collapse;width:100%}#aa-ctrl td{padding:1px 0}#aa-ctrl td:first-child{color:#9aa}
  #aa-ctrl .min{float:right;cursor:pointer;color:#9aa}`;
  document.head.appendChild(ctrlStyle);
  const ctrl = document.createElement('div');
  ctrl.id = 'aa-ctrl';
  ctrl.innerHTML = `<span class="min" title="hide / show">_</span><b>Radar tools</b>
    <div class="body">
    <div id="aa-toggles"></div>
    <div class="row">Leader <select id="aa-leader"><option value="1">1 min</option><option value="2">2 min</option><option value="5">5 min</option></select></div>
    <div class="row"><button id="aa-measure">Measure</button><button id="aa-clear">Clear</button></div>
    <div id="aa-sel"></div>
    <h4>Traffic</h4><div id="aa-list"></div></div>`;
  document.body.appendChild(ctrl);
  const TOGGLES = [['blocks', 'Data blocks'], ['trails', 'Trails'], ['leaders', 'Speed leaders'], ['vectors', 'ATC vectors'], ['alerts', 'Conflict alerts'], ['rings', 'Range rings (selected aircraft)'], ['scope', 'Scope rings + compass'], ['sweep', 'Sweep']];
  const togBox = ctrl.querySelector('#aa-toggles');
  for (const [key, label] of TOGGLES) {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" ${opts[key] ? 'checked' : ''}> ${label}`;
    l.firstChild.onchange = (e) => { opts[key] = e.target.checked; if (key === 'alerts') conflicts = opts.alerts ? findConflicts() : new Set(); draw(); };
    togBox.appendChild(l);
  }
  ctrl.querySelector('#aa-leader').onchange = (e) => { leaderMin = Number(e.target.value); draw(); };
  const measureBtn = ctrl.querySelector('#aa-measure');
  measureBtn.onclick = () => { measuring = !measuring; measureBtn.classList.toggle('on', measuring); if (measuring) measure = null; draw(); };
  ctrl.querySelector('#aa-clear').onclick = () => { measure = null; measuring = false; measureBtn.classList.remove('on'); draw(); };
  ctrl.querySelector('.min').onclick = () => { const b = ctrl.querySelector('.body'); b.style.display = b.style.display === 'none' ? '' : 'none'; };

  const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let panelSig = '';
  function renderPanel() {
    const list = ctrl.querySelector('#aa-list'), selBox = ctrl.querySelector('#aa-sel');
    const sorted = [...aircraft].sort((a, b) => a.row.callsign.localeCompare(b.row.callsign));
    list.replaceChildren();
    if (!sorted.length) list.textContent = 'No aircraft reporting.';
    for (const { row } of sorted) {
      const d = document.createElement('div');
      d.className = `ac${row.callsign === selected ? ' sel' : ''}${conflicts.has(row.callsign) ? ' ca' : ''}`;
      d.innerHTML = `<span>${esc(row.callsign)}</span><span>${fl(row.position.altitudeFt)} ${esc(row.aircraftType || '')}</span>`;
      d.onclick = () => { selected = row.callsign; directTo = null; renderPanel(); draw(); };
      list.appendChild(d);
    }
    const sel = aircraft.find((a) => a.row.callsign === selected);
    // rebuild the detail box only when the selection changes, so typing in it isn't interrupted
    const sig = `${selected}|${sel ? 1 : 0}`;
    const refresh = sig !== panelSig;
    panelSig = sig;
    if (!sel) { selBox.replaceChildren(); return; }
    const p = sel.row.position, tag = tags[sel.row.callsign] || {};
    if (refresh) {
      selBox.innerHTML = `<h4>${esc(sel.row.callsign)}</h4><table id="aa-info"></table>
        <div class="row">Scratchpad <input type="text" id="aa-note" maxlength="12" size="10" value="${esc(tag.note || '')}"></div>
        <div class="row">Handoff <select id="aa-handoff"><option value="">-</option>${['TWR', 'GND', 'APP', 'DEP', 'CTR'].map((h) => `<option ${tag.handoff === h ? 'selected' : ''}>${h}</option>`).join('')}</select></div>
        <div class="row">Direct to <select id="aa-direct"><option value="">-</option>${airports().map((a) => `<option value="${a.name}">${a.name}</option>`).join('')}</select></div>`;
      selBox.querySelector('#aa-note').oninput = (e) => { (tags[selected] ||= {}).note = e.target.value.trim(); saveTags(); draw(); };
      selBox.querySelector('#aa-handoff').onchange = (e) => { (tags[selected] ||= {}).handoff = e.target.value; saveTags(); draw(); };
      selBox.querySelector('#aa-direct').onchange = (e) => { directTo = e.target.value || null; draw(); };
    }
    selBox.querySelector('#aa-info').innerHTML = [
      ['Type', sel.row.aircraftType || '-'], ['Altitude', `${p.altitudeFt ?? '-'} ft`], ['Speed', `${sel.row.speed ?? '-'} kt`],
      ['Heading', p.headingDeg != null ? `${String(Math.round(p.headingDeg)).padStart(3, '0')}°` : '-'],
      ['From', `${esc(p.referenceAirport)} ${p.distanceNm?.toFixed?.(1)} nm / ${String(Math.round(p.bearingDeg)).padStart(3, '0')}°`],
      ['ATC vector', sel.row.assignedHeadingDeg != null ? `${String(Math.round(sel.row.assignedHeadingDeg)).padStart(3, '0')}° ${esc(sel.row.vectorReason || '')}` : '-'],
      ['Conflict', conflicts.has(sel.row.callsign) ? 'YES' : 'no'],
    ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  }

  // Islands the 24SPY tiles lack (Grindavik), drawn under the airspace lines.
  const islands = [];
  fetch('islands/index.json').then((r) => (r.ok ? r.json() : [])).then((list) => {
    for (const it of list) {
      const img = new Image();
      img.onload = () => { islands.push({ ...it, img }); if (typeof draw === 'function') draw(); };
      img.src = `islands/${it.file}`;
    }
  }).catch(() => {});
  const siteIcao = () => (document.getElementById('aa-airport') || {}).value || 'IRFD';
  const siteXY = () => { const a = airportByIcao(siteIcao()); return a ? a.coordinates : null; };

  window.autoatcDrawUnder = function (ctx, transform, scale) {
    for (const it of islands) {
      const [x, y] = transform(it.originUnits);
      ctx.drawImage(it.img, x, y, it.unitsWide * scale, it.unitsHigh * scale);
    }
    // radar-scope look: tint the whole chart toward a dark green-grey glass
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = '#6f9d8c';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.restore();

    // range rings and a compass scale around the selected airport
    const site = siteXY();
    if (!opts.scope || !site) return;
    const [cx, cy] = transform(site);
    const pxPerNm = UNITS_PER_NM * scale;
    const step = [1, 2, 5, 10, 20, 50].find((n) => n * pxPerNm >= 70) || 50;
    const maxPx = Math.hypot(ctx.canvas.width, ctx.canvas.height);
    ctx.save();
    ctx.lineWidth = 1; ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    for (let nm = step; nm * pxPerNm < maxPx * 1.2 && nm <= 80; nm += step) {
      const r = nm * pxPerNm;
      ctx.strokeStyle = 'rgba(47,214,160,.22)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(95,138,125,.9)';
      ctx.fillText(`${nm}`, cx + 3, cy - r - 3);
    }
    // compass ticks on the first ring that is comfortably large
    const ringNm = Math.max(step, Math.ceil(180 / pxPerNm / step) * step), R = ringNm * pxPerNm;
    ctx.strokeStyle = 'rgba(47,214,160,.55)'; ctx.fillStyle = 'rgba(125,255,178,.75)';
    for (let deg = 0; deg < 360; deg += 10) {
      const rad = (deg * Math.PI) / 180, long = deg % 30 === 0, len = long ? 10 : 5;
      const sx = Math.sin(rad), sy = -Math.cos(rad);
      ctx.beginPath(); ctx.moveTo(cx + sx * R, cy + sy * R); ctx.lineTo(cx + sx * (R + len), cy + sy * (R + len)); ctx.stroke();
      if (long) ctx.fillText(String(deg).padStart(3, '0'), cx + sx * (R + 24) - 9, cy + sy * (R + 24) + 3);
    }
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  };

  // rotating sweep, on its own canvas so it doesn't redraw the map every frame
  const sweep = document.createElement('canvas');
  sweep.id = 'aa-sweep';
  document.body.appendChild(sweep);
  const SWEEP_SECONDS = 8;
  (function spin(t) {
    const mc = document.getElementById('map');
    if (mc) {
      const r = mc.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      if (sweep.width !== Math.round(r.width * dpr) || sweep.height !== Math.round(r.height * dpr)) {
        sweep.width = Math.round(r.width * dpr); sweep.height = Math.round(r.height * dpr);
        sweep.style.left = `${r.left}px`; sweep.style.top = `${r.top}px`; sweep.style.width = `${r.width}px`; sweep.style.height = `${r.height}px`;
      }
      const g = sweep.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
      const site = siteXY();
      if (opts.sweep && site && typeof transformCoordinates === 'function' && g.createConicGradient) {
        const [cx, cy] = transformCoordinates(site);
        const a = (((t / 1000) % SWEEP_SECONDS) / SWEEP_SECONDS) * Math.PI * 2 - Math.PI / 2;
        const trail = Math.PI / 3, R = Math.hypot(r.width, r.height);
        const grad = g.createConicGradient(a - trail, cx, cy);
        grad.addColorStop(0, 'rgba(47,214,160,0)'); grad.addColorStop(trail / (Math.PI * 2), 'rgba(47,214,160,.16)');
        grad.addColorStop(trail / (Math.PI * 2) + 0.0005, 'rgba(47,214,160,0)');
        g.fillStyle = grad; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a - trail, a); g.closePath(); g.fill();
        g.strokeStyle = 'rgba(125,255,178,.55)'; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
      }
    }
    requestAnimationFrame(spin);
  }(0));

  // readout strip: site, cursor range/bearing from it, view width, Zulu time, traffic
  const status = document.createElement('div');
  status.id = 'aa-status';
  status.innerHTML = '<span><b>SITE</b><i id="aa-s-site"></i></span><span><b>CURSOR</b><i id="aa-s-cur">---</i></span><span><b>VIEW</b><i id="aa-s-view"></i></span><span><b>TFC</b><i id="aa-s-tfc">0</i></span><span id="aa-s-z"></span>';
  document.body.appendChild(status);
  let cursor = null;
  document.getElementById('map').addEventListener('mousemove', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    cursor = [(e.clientX - r.left - offsetX) / scale, (e.clientY - r.top - offsetY) / scale];
  });
  function updateStatus() {
    const site = siteXY(), q = (id) => document.getElementById(id);
    q('aa-s-site').textContent = siteIcao();
    q('aa-s-tfc').textContent = String(aircraft.length);
    q('aa-s-view').textContent = `${(document.getElementById('map').width / (scale * UNITS_PER_NM)).toFixed(0)} nm`;
    q('aa-s-cur').textContent = cursor && site ? `${nmBetween(site, cursor).toFixed(1)} nm  ${String(Math.round(bearingTo(site, cursor))).padStart(3, '0')}°` : '---';
    q('aa-s-z').textContent = `${new Date().toISOString().slice(11, 19)}Z`;
  }
  setInterval(updateStatus, 500);

  // ---- ground + charts views ------------------------------------------------
  const css = `
  #aa-bar{position:fixed;bottom:44px;left:50%;transform:translateX(-50%);z-index:5000;display:flex;gap:6px;align-items:center;background:rgba(32,32,36,.92);padding:6px 10px;border-radius:8px;color:#fff;font:13px sans-serif}
  #aa-bar select,#aa-bar button{background:#2b2b31;color:#fff;border:1px solid #444;border-radius:5px;padding:4px 8px;font:inherit;cursor:pointer}
  #aa-bar button:hover{background:#3a3a42}
  .aa-panel{position:fixed;inset:70px 20px 40px 20px;z-index:5001;background:#17171b;color:#e6e6e6;border:1px solid #444;border-radius:10px;display:none;flex-direction:column;font:14px sans-serif}
  .aa-panel .aa-head{display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid #333}
  .aa-panel .aa-head b{flex:1}
  .aa-panel button{background:#2b2b31;color:#fff;border:1px solid #444;border-radius:5px;padding:4px 10px;cursor:pointer}
  .aa-body{flex:1;overflow:auto;padding:12px}
  #aa-ground-stage{position:relative;flex:1;overflow:hidden;cursor:grab;background:#0e0e11}
  #aa-ground-stage img{position:absolute;left:0;top:0;transform-origin:0 0;user-select:none;-webkit-user-drag:none}
  .aa-chart-links button{margin:3px 6px 3px 0}
  .aa-note{color:#8a8a94;font-size:12px;margin-top:10px}
  table.aa{border-collapse:collapse}table.aa td,table.aa th{border:1px solid #333;padding:3px 10px;text-align:left}`;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'aa-bar';
  bar.innerHTML = '<select id="aa-airport"></select><button id="aa-ground">Ground view</button><button id="aa-charts">Charts view</button>';
  document.body.appendChild(bar);
  const sel = bar.querySelector('#aa-airport');
  for (const a of airports()) sel.add(new Option(`${a.name} ${a.real_name}`, a.name));
  sel.value = 'IRFD';

  function panel(id, title) {
    const el = document.createElement('div');
    el.className = 'aa-panel'; el.id = id;
    el.innerHTML = `<div class="aa-head"><b class="aa-title">${title}</b><button class="aa-close">Close</button></div>`;
    el.querySelector('.aa-close').onclick = () => { el.style.display = 'none'; };
    document.body.appendChild(el);
    return el;
  }
  const groundPanel = panel('aa-ground-panel', 'Ground view');
  const chartsPanel = panel('aa-charts-panel', 'Charts view');

  // Ground view: the airport's GROUND.svg inlined and restyled layer by layer
  // (ramps/taxiways, taxiway centre lines, runways/buildings), plus pan/zoom.
  const GROUND_STYLES = {
    'Taxiways / Ramps': { fill: '#3b4049', stroke: 'none' },
    'Taxiway Lines': { fill: 'none', stroke: '#d4b02a' },
    'Runways / Buildings': { fill: '#1f2227', stroke: '#8d95a3' },
  };
  async function openGround() {
    const icao = sel.value;
    groundPanel.style.display = 'flex';
    groundPanel.querySelector('.aa-title').textContent = `Ground view - ${icao}`;
    groundPanel.querySelectorAll('.aa-stage-wrap').forEach((n) => n.remove());
    const wrap = document.createElement('div');
    wrap.className = 'aa-stage-wrap'; wrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0';
    const tools = document.createElement('div');
    tools.style.cssText = 'padding:6px 12px;display:flex;gap:12px;border-bottom:1px solid #333';
    const stage = document.createElement('div'); stage.id = 'aa-ground-stage';
    wrap.append(tools, stage);
    groundPanel.appendChild(wrap);
    let text = null;
    try { const r = await fetch(`ground/maps/${icao}/GROUND.svg`); if (r.ok) text = await r.text(); } catch (e) { /* none */ }
    if (!text) { stage.innerHTML = '<p style="padding:16px;color:#aaa">No ground diagram for this airport.</p>'; return; }
    const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
    // The drawing only fills a small part of the file's canvas (the units are
    // tiny), so frame it by its real bounds instead of the declared size.
    stage.appendChild(svg);
    const bb = svg.getBBox();
    const pad = Math.max(bb.width, bb.height) * 0.04;
    const K = 900 / Math.max(bb.width, bb.height); // px per drawing unit
    const w = (bb.width + 2 * pad) * K, h = (bb.height + 2 * pad) * K;
    svg.setAttribute('viewBox', `${bb.x - pad} ${bb.y - pad} ${bb.width + 2 * pad} ${bb.height + 2 * pad}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0';
    for (const g of svg.querySelectorAll('g')) {
      const style = GROUND_STYLES[g.getAttribute('inkscape:label')];
      if (!style) continue;
      g.querySelectorAll('path,rect,circle,polygon,polyline,ellipse').forEach((el) => {
        el.removeAttribute('style'); el.setAttribute('fill', style.fill); el.setAttribute('stroke', style.stroke);
        if (style.stroke !== 'none') el.setAttribute('stroke-width', 1.2 / K);
      });
      const lab = document.createElement('label');
      lab.innerHTML = `<input type="checkbox" checked> ${g.getAttribute('inkscape:label')}`;
      lab.firstChild.onchange = (e) => { g.style.display = e.target.checked ? 'inline' : 'none'; };
      tools.appendChild(lab);
    }
    const view = { s: 1, x: 0, y: 0 };
    const apply = () => { svg.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`; };
    const fit = () => {
      view.s = Math.min(stage.clientWidth / w, stage.clientHeight / h) * 0.95;
      view.x = (stage.clientWidth - w * view.s) / 2; view.y = (stage.clientHeight - h * view.s) / 2;
      apply();
    };
    fit();
    let drag = null;
    stage.onpointerdown = (e) => { drag = [e.clientX, e.clientY]; stage.setPointerCapture(e.pointerId); stage.style.cursor = 'grabbing'; };
    stage.onpointermove = (e) => { if (!drag) return; view.x += e.clientX - drag[0]; view.y += e.clientY - drag[1]; drag = [e.clientX, e.clientY]; apply(); };
    stage.onpointerup = () => { drag = null; stage.style.cursor = 'grab'; };
    stage.ondblclick = fit;
    stage.onwheel = (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * 0.0015), r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      view.x = mx - (mx - view.x) * f; view.y = my - (my - view.y) * f; view.s *= f; apply();
    };
  }

  // Charts view: airport facts, frequencies and chart links.
  async function openCharts() {
    const icao = sel.value, spy = airportByIcao(icao);
    chartsPanel.style.display = 'flex';
    chartsPanel.querySelector('.aa-title').textContent = `Charts view - ${icao} ${spy ? spy.real_name : ''}`;
    chartsPanel.querySelectorAll('.aa-body').forEach((n) => n.remove());
    const body = document.createElement('div'); body.className = 'aa-body';
    chartsPanel.appendChild(body);
    let info = null;
    try { info = await fetch(`charts/${icao}.json`).then((r) => (r.ok ? r.json() : null)); } catch (e) { /* no data */ }
    const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const freqs = spy ? [['Tower', spy.towerfreq], ['Ground', spy.groundfreq]].filter(([, f]) => f && f !== 'None') : [];
    let html = '';
    if (info) html += `<h3>${esc(info.name)} (${esc(info.icao)}${info.iata ? ' / ' + esc(info.iata) : ''})</h3><p>${esc(info.location)} - elevation ${esc(info.elevationFt)} - ${esc(info.coordinates)}</p>`;
    if (freqs.length) html += `<h4>Frequencies</h4><table class="aa">${freqs.map(([n, f]) => `<tr><td>${n}</td><td>${esc(f)}</td></tr>`).join('')}</table>`;
    if (info && info.runways && info.runways.length) html += `<h4>Runways</h4><table class="aa"><tr><th>Runway</th><th>Heading</th></tr>${info.runways.map((r) => `<tr><td>${esc(r.designator)}</td><td>${esc(r.heading)}</td></tr>`).join('')}</table>`;
    if (info && info.groundLayout) html += `<h4>Ground layout</h4><p>${esc(info.groundLayout)}</p>`;
    html += '<h4>Charts</h4><div class="aa-chart-links"></div>';
    body.innerHTML = html || '<p>No data for this airport.</p>';
    const links = body.querySelector('.aa-chart-links');
    const list = spy && spy.charts ? spy.charts : [];
    if (!list.length) links.textContent = 'No chart links for this airport.';
    for (const [name, url] of list) {
      const b = document.createElement('button'); b.textContent = name; b.onclick = () => window.open(url, '_blank', 'noopener');
      links.appendChild(b);
    }
    const note = document.createElement('div'); note.className = 'aa-note';
    note.textContent = 'Chart links open the chart packs 24SPY lists for this airport.';
    body.appendChild(note);
  }

  bar.querySelector('#aa-ground').onclick = openGround;
  bar.querySelector('#aa-charts').onclick = openCharts;
  poll(); setInterval(poll, POLL_MS);
})();
