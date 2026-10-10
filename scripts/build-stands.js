#!/usr/bin/env node
// Writes data/stands.json: where each stand number sits on the radar's ground charts. The stand numbers are
// text labels in the charts' TAXIWAYS.svg (only IRFD, ITKO and IPPH have them), placed by the radar page
// itself, so this opens the radar in a browser and reads them off the Ground View.
//   1. start the monitor:  (cd monitor && PORT=3917 node server.js)
//   2. node scripts/build-stands.js            (needs `playwright` installed, e.g. npx playwright install chromium)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = process.env.RADAR_URL || 'http://localhost:3917/365radar/';
const AIRPORTS = ['IRFD', 'ITKO', 'IPPH'];

(async () => {
  const browser = await chromium.launch();
  const out = {
    note: 'Stand positions and stand lines read from the radar ground charts (TAXIWAYS.svg labels), in ground-chart units (100 studs each) - see scripts/build-stands.js. Only airports whose chart has stand numbers are listed.',
    airports: {},
  };
  for (const icao of AIRPORTS) {
    const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
    await page.goto(BASE);
    await page.waitForTimeout(2000);
    await page.mouse.click(1020, 352).catch(() => {}); // the changelog popup
    await page.selectOption('#airport-dropdown', icao);
    await page.waitForTimeout(800);
    await page.mouse.click(25, 925); // open the side panel
    await page.waitForTimeout(600);
    await page.click('#groundview-button').catch(() => {});
    await page.waitForTimeout(4000);
    // Each stand number sits beside its yellow stand line (a short straight 2-point path, ~1.2 units long):
    // take the nearest one, with its end points in the chart's own frame.
    const stands = await page.evaluate(() => {
      const svg = document.querySelector('#ground-map-svg');
      const toRoot = (el) => svg.getCTM().inverse().multiply(el.getCTM());
      const round = (n) => Math.round(n * 1000) / 1000;
      const lines = [];
      for (const p of svg.querySelectorAll('path')) {
        if (getComputedStyle(p).stroke !== 'rgb(146, 125, 22)') continue;
        let len;
        try { len = p.getTotalLength(); } catch { continue; }
        if (len < 0.5 || len > 3) continue;
        const m = toRoot(p);
        const a = new DOMPoint(p.getPointAtLength(0).x, p.getPointAtLength(0).y).matrixTransform(m);
        const b = new DOMPoint(p.getPointAtLength(len).x, p.getPointAtLength(len).y).matrixTransform(m);
        const mid = p.getPointAtLength(len / 2);
        // straight only: the middle must sit on the chord
        const c = new DOMPoint(mid.x, mid.y).matrixTransform(m);
        if (Math.hypot(c.x - (a.x + b.x) / 2, c.y - (a.y + b.y) / 2) > 0.05) continue;
        lines.push({ a: [round(a.x), round(a.y)], b: [round(b.x), round(b.y)], cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 });
      }
      const result = {};
      for (const t of svg.querySelectorAll('text')) {
        const name = t.textContent.trim();
        if (!/^\d{1,3}$/.test(name) || result[name]) continue;
        const x = +t.getAttribute('x'), y = +t.getAttribute('y');
        let best = null;
        for (const l of lines) {
          const d = Math.hypot(l.cx - x, l.cy - y);
          if (d < 2 && (!best || d < best.d)) best = { d, l };
        }
        result[name] = { x: round(x), y: round(y), line: best ? { a: best.l.a, b: best.l.b } : null };
      }
      return result;
    });
    out.airports[icao] = stands;
    await page.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, '..', 'data', 'stands.json'), `${JSON.stringify(out, null, 1)}\n`);
  console.log(Object.fromEntries(Object.entries(out.airports).map(([k, v]) => [k, Object.keys(v).length])));
})();
