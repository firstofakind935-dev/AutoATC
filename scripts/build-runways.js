#!/usr/bin/env node
// Writes data/runways.json: where each runway's threshold is on the radar's ground charts, and its heading.
// Runways are the long thin dark shapes in each chart's "Runways / Buildings" layer; their names and headings come from
// data/charts/<ICAO>.json. Parallels (L/C/R) are told apart by which side of the direction of travel they lie on.
//   1. start the monitor:  (cd monitor && PORT=3917 node server.js)
//   2. node scripts/build-runways.js            (needs `playwright`)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.RADAR_URL || 'http://localhost:3917/365radar/';
const MAPS = path.join(ROOT, 'monitor/public/365radar/public/assets/maps');
const rad = (d) => (d * Math.PI) / 180;

function assign(icao, shapes, chartRunways) {
  const out = {};
  // group the chart's runways by their heading: "25L/25C/25R" share 247
  const groups = new Map();
  for (const r of chartRunways) {
    const h = parseInt(String(r.heading), 10);
    if (!Number.isFinite(h)) continue;
    const num = r.designator.replace(/[LCR]$/, '');
    if (!groups.has(num)) groups.set(num, { h, names: [] });
    groups.get(num).names.push(r.designator);
  }
  for (const [num, { h, names }] of groups) {
    const axis = h % 180;
    const cands = shapes.filter((s) => Math.min(Math.abs(s.brg - axis), 180 - Math.abs(s.brg - axis)) < 10);
    if (!cands.length) { console.warn(`  ${icao} ${num}: no runway shape at ${h}`); continue; }
    if (cands.length !== names.length) { console.warn(`  ${icao} ${num}: ${cands.length} shapes for ${names.join('/')} - skipped`); continue; }
    // direction of travel (x east, y south) and the left-hand side of it
    const dir = [Math.sin(rad(h)), -Math.cos(rad(h))];
    const left = [dir[1], -dir[0]];
    const mean = [cands.reduce((a, s) => a + s.mx, 0) / cands.length, cands.reduce((a, s) => a + s.my, 0) / cands.length];
    const sorted = cands.map((s) => ({ s, lat: (s.mx - mean[0]) * left[0] + (s.my - mean[1]) * left[1] })).sort((a, b) => b.lat - a.lat);
    const suffixes = names.length === 1 ? [''] : names.length === 2 ? ['L', 'R'] : ['L', 'C', 'R'];
    sorted.forEach(({ s }, i) => {
      const name = `${num}${suffixes[i]}`;
      if (!names.includes(name)) return;
      // the threshold is the end you start the roll from: the end lying against the direction of travel
      const ends = [s.a, s.b];
      const start = ends.reduce((best, e) => ((e[0] - s.mx) * dir[0] + (e[1] - s.my) * dir[1] < (best[0] - s.mx) * dir[0] + (best[1] - s.my) * dir[1] ? e : best));
      out[name] = { x: +start[0].toFixed(3), y: +start[1].toFixed(3), headingDeg: h, lengthUnits: +s.L.toFixed(1) };
    });
  }
  return out;
}

(async () => {
  const airports = fs.readdirSync(MAPS).filter((d) => fs.existsSync(path.join(MAPS, d, 'GROUND.svg')));
  const browser = await chromium.launch();
  const result = {
    note: 'Runway thresholds (x, y in ground-chart units, 100 studs each) and headings, read off the radar ground charts by scripts/build-runways.js.',
    airports: {},
  };
  for (const icao of airports) {
    const chartPath = path.join(ROOT, 'data/charts', `${icao}.json`);
    if (!fs.existsSync(chartPath)) continue;
    const chartRunways = JSON.parse(fs.readFileSync(chartPath, 'utf8')).runways || [];
    const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
    await page.goto(BASE);
    await page.waitForTimeout(1800);
    await page.mouse.click(1020, 352).catch(() => {});
    try { await page.selectOption('#airport-dropdown', icao); } catch { await page.close(); continue; }
    await page.waitForTimeout(800);
    await page.mouse.click(25, 925);
    await page.waitForTimeout(600);
    await page.click('#groundview-button').catch(() => {});
    await page.waitForTimeout(3500);
    const shapes = await page.evaluate(() => {
      const svg = document.querySelector('#ground-map-svg');
      if (!svg) return [];
      const toRoot = (el) => svg.getCTM().inverse().multiply(el.getCTM());
      const res = [];
      for (const el of svg.querySelectorAll('path,rect,polygon')) {
        let len;
        try { len = el.getTotalLength(); } catch { continue; }
        if (!len) continue;
        const m = toRoot(el);
        const pts = [];
        for (let i = 0; i <= 80; i++) { const q = el.getPointAtLength((len * i) / 80); const r = new DOMPoint(q.x, q.y).matrixTransform(m); pts.push([r.x, r.y]); }
        const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        let sxx = 0, syy = 0, sxy = 0;
        for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
        const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
        const proj = pts.map(([x, y]) => (x - mx) * ux + (y - my) * uy), perp = pts.map(([x, y]) => -(x - mx) * uy + (y - my) * ux);
        const lo = Math.min(...proj), hi = Math.max(...proj), L = hi - lo, W = Math.max(...perp) - Math.min(...perp);
        const fill = getComputedStyle(el).fill;
        if (L > 12 && W > 0.3 && L / W > 8 && fill !== 'none') {
          // centre line ends
          const midPerp = (Math.max(...perp) + Math.min(...perp)) / 2;
          const at = (t) => [mx + t * ux - midPerp * uy, my + t * uy + midPerp * ux];
          res.push({ L, W, mx, my, brg: (((Math.atan2(ux, -uy) * 180) / Math.PI) + 360) % 180, a: at(lo), b: at(hi) });
        }
      }
      return res;
    });
    await page.close();
    const found = assign(icao, shapes, chartRunways);
    if (Object.keys(found).length) result.airports[icao] = found;
    console.log(`${icao}: ${Object.keys(found).join(' ') || '(none)'}`);
  }
  await browser.close();
  fs.writeFileSync(path.join(ROOT, 'data/runways.json'), `${JSON.stringify(result, null, 1)}\n`);
})();
