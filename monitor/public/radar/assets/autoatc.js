// AutoATC additions to the 24SPY fork (new code, written for this fork).
//   - live AutoATC aircraft drawn on the map
//   - Ground view: airport diagrams (ground/maps/<ICAO>/)
//   - Charts view: airport data (charts/<ICAO>.json) plus chart links
// Original site: 24SPY by Tiago Murteira (tiaguinho_2009), see LICENSE.md.

(function () {
  const UNITS_PER_NM = 34.19; // 24SPY map units per nautical mile (fitted to the PTFS world map)
  const POLL_MS = 3000;
  let aircraft = [];

  const airports = () => controlAreas.filter((a) => a.type === 'Airport' && Array.isArray(a.coordinates));
  const airportByIcao = (icao) => airports().find((a) => a.name === icao);

  // ---- live aircraft --------------------------------------------------------
  function toMapUnits(row) {
    const p = row.position || {};
    const ref = airportByIcao(p.referenceAirport);
    if (!ref || typeof p.distanceNm !== 'number' || typeof p.bearingDeg !== 'number') return null;
    const rad = (p.bearingDeg * Math.PI) / 180;
    return [ref.coordinates[0] + p.distanceNm * UNITS_PER_NM * Math.sin(rad), ref.coordinates[1] - p.distanceNm * UNITS_PER_NM * Math.cos(rad)];
  }

  async function poll() {
    try {
      const rows = await fetch('/api/dashboard/positions').then((r) => r.json());
      aircraft = rows.map((row) => ({ row, xy: toMapUnits(row) })).filter((a) => a.xy);
    } catch (e) { aircraft = []; }
    if (typeof draw === 'function') draw();
  }

  window.autoatcDraw = function (ctx, transform) {
    ctx.save();
    ctx.font = '11px monospace';
    for (const { row, xy } of aircraft) {
      const [x, y] = transform(xy);
      const p = row.position;
      ctx.translate(x, y);
      ctx.rotate(((p.headingDeg || 0) * Math.PI) / 180);
      ctx.fillStyle = '#6dff9c';
      ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6); ctx.closePath(); ctx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const alt = typeof p.altitudeFt === 'number' ? String(Math.round(p.altitudeFt / 100)).padStart(3, '0') : '---';
      ctx.fillStyle = '#cfe3d6';
      ctx.fillText(row.callsign, x + 9, y - 5);
      ctx.fillText(`${alt} ${row.speed ? Math.round(row.speed / 10) : '--'}`, x + 9, y + 7);
    }
    ctx.restore();
  };

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
