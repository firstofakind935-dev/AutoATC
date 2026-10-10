// Flight planner page: fill the form from /api/aircraft + /api/navdata,
// post to /api/plans, and render the returned plan as a briefing.

const $ = (id) => document.getElementById(id);
const FMS_NAMES = { airbus: 'Airbus MCDU', a350: 'A350/A380 MFD', a220: 'A220 FMS', boeing: 'Boeing CDU', boeing787: 'Boeing 787 CDU', embraer: 'Embraer MCDU', generic: 'Default FMS' };
let navdata = null;

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function fmtMin(min) {
  const total = Math.round(min * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

const fmtAlt = (ft) => (ft >= 18000 ? `FL${String(Math.round(ft / 100)).padStart(3, '0')}` : `${ft.toLocaleString()} ft`);

function row(cells, cls) {
  const tr = document.createElement('tr');
  if (cls) tr.className = cls;
  for (const c of cells) {
    const td = document.createElement('td');
    td.textContent = c;
    tr.append(td);
  }
  return tr;
}

function header(cells) {
  const tr = document.createElement('tr');
  for (const c of cells) {
    const th = document.createElement('th');
    th.textContent = c;
    tr.append(th);
  }
  return tr;
}

async function loadReferenceData() {
  const [aircraft, nav] = await Promise.all([
    fetch('/api/aircraft').then((r) => r.json()),
    fetch('/api/navdata').then((r) => r.json()),
  ]);
  navdata = nav;
  const form = $('plan-form');
  for (const a of aircraft) form.aircraftType.append(option(a.icao, `${a.name} (${a.icao})`));
  form.aircraftType.value = 'A320'; // default
  for (const name of ['origin', 'destination']) {
    for (const ap of nav.airports) form[name].append(option(ap.icao, `${ap.icao} · ${ap.name}`));
  }
  form.origin.value = 'IRFD';
  form.destination.value = 'ITKO';
}

function renderMap(plan) {
  const svg = $('map');
  const all = [...navdata.airports, ...navdata.fixes];
  const minLat = Math.min(...all.map((p) => p.lat));
  const maxLat = Math.max(...all.map((p) => p.lat));
  const minLon = Math.min(...all.map((p) => p.lon));
  const maxLon = Math.max(...all.map((p) => p.lon));
  // Flat projection with longitude shrunk by cos(lat), same as the FMS,
  // scaled into a 600 x 450 drawing so CSS sizes are in screen-ish pixels.
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const W = 600;
  const H = 450;
  const pad = 24;
  const scale = Math.min((W - 2 * pad) / ((maxLon - minLon) * k), (H - 2 * pad) / (maxLat - minLat));
  const offX = (W - (maxLon - minLon) * k * scale) / 2;
  const offY = (H - (maxLat - minLat) * scale) / 2;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const xy = (p) => [((p.lon - minLon) * k * scale + offX).toFixed(1), ((maxLat - p.lat) * scale + offY).toFixed(1)];

  let out = '';
  for (const f of navdata.fixes) {
    const [x, y] = xy(f);
    out += `<circle class="fix" cx="${x}" cy="${y}" r="1.6"/>`;
  }
  for (const a of navdata.airports) {
    const [x, y] = xy(a);
    out += `<rect class="airport" x="${x - 2.5}" y="${y - 2.5}" width="5" height="5"/>`;
    out += `<text class="airport-label" x="${+x + 5}" y="${+y - 4}">${a.icao}</text>`;
  }
  const pts = plan.waypoints.map(xy);
  out += `<polyline class="route" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
  plan.waypoints.forEach((wpt, i) => {
    const [x, y] = pts[i];
    const end = i === 0 || i === plan.waypoints.length - 1;
    out += `<circle class="${end ? 'endpoint' : 'route-point'}" cx="${x}" cy="${y}" r="${end ? 4 : 3}"/>`;
    out += `<text class="route-label" x="${+x + 6}" y="${+y + 14}">${wpt.ident}</text>`;
  });
  svg.innerHTML = out;
}

function renderPlan(plan) {
  $('ofp').hidden = false;
  $('plan-id').textContent = plan.id;
  $('fms-hint').textContent = `${plan.aircraft.name} uses the ${FMS_NAMES[plan.aircraft.fms]} in the companion app. You can also import by callsign ${plan.callsign}.`;
  $('route-text').textContent = `${plan.origin.icao} ${plan.route} ${plan.destination.icao}`;

  const summary = [
    [plan.callsign, 'Callsign'],
    [`${plan.origin.icao} → ${plan.destination.icao}`, 'Route'],
    [plan.aircraft.icao, 'Aircraft'],
    [`${plan.distanceNm} nm`, 'Distance'],
    [fmtAlt(plan.profile.cruiseAltFt), 'Cruise'],
    [fmtMin(plan.times.enrouteMin), 'Time'],
    [plan.fuel.block.toLocaleString(), 'Block fuel kg'],
  ];
  $('summary').innerHTML = '';
  for (const [value, label] of summary) {
    const div = document.createElement('div');
    div.innerHTML = '<b></b><span></span>';
    div.querySelector('b').textContent = value;
    div.querySelector('span').textContent = label;
    $('summary').append(div);
  }

  $('warnings').innerHTML = '';
  for (const w of plan.warnings) {
    const li = document.createElement('li');
    li.textContent = w;
    $('warnings').append(li);
  }

  const fuel = $('fuel');
  fuel.innerHTML = '';
  for (const [label, key] of [['Taxi', 'taxi'], ['Trip', 'trip'], ['Contingency 5%', 'contingency'], ['Final reserve 30 min', 'finalReserve']]) {
    fuel.append(row([label, plan.fuel[key].toLocaleString()]));
  }
  fuel.append(row(['Block', plan.fuel.block.toLocaleString()], 'total'));

  const times = $('times');
  times.innerHTML = '';
  times.append(row(['Climb to cruise', fmtMin(plan.times.climbMin)]));
  times.append(row(['Top of climb', `${plan.profile.tocNm} nm`]));
  times.append(row(['Top of descent', `${plan.profile.todNm} nm`]));
  times.append(row(['Enroute', fmtMin(plan.times.enrouteMin)], 'total'));

  const log = $('navlog');
  log.innerHTML = '';
  log.append(header(['Waypoint', 'Track', 'Leg nm', 'Total nm', 'Alt', 'Time', 'Fuel kg']));
  for (const e of plan.navlog) {
    log.append(row([
      e.ident,
      e.trackDeg == null ? '' : `${String(e.trackDeg).padStart(3, '0')}°`,
      e.legNm || '',
      e.cumNm,
      e.altFt.toLocaleString(),
      fmtMin(e.eteMin),
      e.fuelRemKg.toLocaleString(),
    ], e.type === 'PSEUDO' ? 'pseudo' : ''));
  }

  renderMap(plan);
  history.replaceState(null, '', `?id=${plan.id}`);
  $('ofp').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openPlan(id) {
  const res = await fetch(`/api/plans/${encodeURIComponent(id)}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  renderPlan(body);
}

// ---- procedures: SID / STAR / approach pickers for airports we have charts for
const procData = {}; // icao -> procedures summary
async function procsFor(icao) {
  if (!(icao in procData)) procData[icao] = await fetch(`/api/procedures/${icao}`).then((r) => r.json()).catch(() => null);
  return procData[icao];
}
const fill = (select, items, blank) => {
  const keep = select.value;
  select.replaceChildren(option('', blank));
  for (const it of items) select.append(option(it.value, it.label));
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
};
async function refreshProcedures() {
  const form = $('plan-form');
  const [dep, arr] = await Promise.all([procsFor(form.origin.value), procsFor(form.destination.value)]);
  const hasDep = dep && dep.sids.length;
  const hasArr = arr && (arr.stars.length || arr.approaches.length);
  // The pickers only show when the pilot chooses to pick procedures by hand
  // (Advanced options); otherwise runway, SID, STAR and approach are automatic.
  $('procs').hidden = !((hasDep || hasArr) && form.procMode.value === 'manual');
  if ($('procs').hidden) { for (const n of ['sid', 'depRunway', 'star', 'arrRunway', 'starEntry', 'approach', 'approachIaf']) form[n].value = ''; return; }
  const runways = (list) => [...new Set(list.flatMap((p) => p.runways))].sort().map((r) => ({ value: r, label: r }));
  const unplaced = (p) => (p.unplaced.length ? ` (no position: ${p.unplaced.join(', ')})` : '');
  fill(form.depRunway, hasDep ? runways(dep.sids) : [], 'Automatic');
  fill(form.sid, hasDep ? dep.sids.filter((p) => !form.depRunway.value || p.runways.includes(form.depRunway.value)).map((p) => ({ value: p.name, label: `${p.title}${unplaced(p)}` })) : [], 'Automatic');
  fill(form.arrRunway, hasArr ? runways([...arr.stars, ...arr.approaches]) : [], 'Automatic');
  const rw = form.arrRunway.value;
  const stars = hasArr ? arr.stars.filter((p) => !rw || p.runways.includes(rw)) : [];
  fill(form.star, stars.map((p) => ({ value: p.name, label: `${p.title}${unplaced(p)}` })), 'Automatic');
  const star = stars.find((p) => p.name === form.star.value);
  fill(form.starEntry, (star?.entries || []).map((e) => ({ value: e, label: e })), 'First entry');
  const apps = hasArr ? arr.approaches.filter((p) => !rw || p.runways.includes(rw)) : [];
  fill(form.approach, apps.map((p) => ({ value: p.name, label: `${p.name}${unplaced(p)}` })), 'Automatic');
  const app = apps.find((p) => p.name === form.approach.value);
  fill(form.approachIaf, (app?.iaf || []).map((e) => ({ value: e, label: e })), 'Join at first fix');
  $('procs-hint').textContent = [hasDep && `${form.origin.value} SIDs`, hasArr && `${form.destination.value} STARs/approaches`].filter(Boolean).join(' · ');
}
for (const n of ['origin', 'destination', 'depRunway', 'arrRunway', 'star', 'approach', 'procMode']) $('plan-form')[n].addEventListener('change', refreshProcedures);

$('plan-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('form-error').textContent = '';
  const data = Object.fromEntries(new FormData(e.target));
  if (!data.cruiseAltFt) delete data.cruiseAltFt;
  const mode = data.procMode;
  delete data.procMode;
  if (mode === 'none') data.auto = false; // waypoint to waypoint, no procedures
  for (const k of ['sid', 'depRunway', 'star', 'arrRunway', 'starEntry', 'approach', 'approachIaf']) if (!data[k] || mode !== 'manual') delete data[k];
  if (!data.aircraftType) delete data.aircraftType;
  if (!data.route) delete data.route;
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const res = await fetch('/api/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    renderPlan(body);
  } catch (err) {
    $('form-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('lookup').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('lookup-id').value.trim();
  if (id) openPlan(id).catch((err) => alert(err.message));
});

loadReferenceData().then(() => {
  refreshProcedures();
  const id = new URLSearchParams(location.search).get('id');
  if (id) openPlan(id).catch(() => {});
});
