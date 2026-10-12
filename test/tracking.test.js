// The companion's automatic tracking (ported from the tracker, test-pim-vpilot): the minimap is found on screen, a
// fix comes from features with no stand entry, the marker survives colour drift, and the filter follows a flight.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { findMinimap, blankButtons } = require('../companion/lib/minimapFinder');
const { findMarker, fixFromMinimap } = require('../companion/lib/mapFix');
const { createLocator } = require('../companion/lib/featureLocator');
const { createPositionFilter } = require('../companion/lib/positionFilter');
const { standFix } = require('../companion/lib/stands');

// A real 2000x1125 screen parked at Rockford stand 14: its bottom-right corner (with the minimap) put back in place
// on an otherwise plain screen.
function screen() {
  const meta = require('./fixtures/ptfs_irfd_stand14_corner.json');
  const corner = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'ptfs_irfd_stand14_corner.rgba.gz')));
  const [W, H] = meta.screen;
  const data = new Uint8ClampedArray(W * H * 4).fill(200);
  for (let y = 0; y < meta.height; y++) {
    data.set(corner.subarray(y * meta.width * 4, (y + 1) * meta.width * 4), ((meta.y + y) * W + meta.x) * 4);
  }
  return { width: W, height: H, data };
}

function crop(image, r) {
  const data = new Uint8ClampedArray(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) data.set(image.data.subarray(((r.y + y) * image.width + r.x) * 4, ((r.y + y) * image.width + r.x + r.w) * 4), y * r.w * 4);
  return { width: r.w, height: r.h, data };
}

test('the minimap is found on screen by its corner buttons', () => {
  const r = findMinimap(screen());
  assert.ok(r, 'not found');
  assert.ok(Math.abs(r.x - 1690) < 8 && Math.abs(r.y - 828) < 8, JSON.stringify(r));
  assert.ok(Math.abs(r.w - 306) < 10 && Math.abs(r.h - 297) < 10, JSON.stringify(r));
});

test('no minimap on a screen without one', () => {
  const plain = { width: 1280, height: 720, data: new Uint8ClampedArray(1280 * 720 * 4).fill(200) };
  assert.strictEqual(findMinimap(plain), null);
});

test('first fix with no stand entry: Rockford stand 14, by features', async () => {
  const s = screen();
  const panel = crop(s, findMinimap(s));
  const fix = await fixFromMinimap(blankButtons(panel), { locator: createLocator() });
  assert.ok(!fix.error, fix.error);
  const stand = standFix('IRFD', '14');
  const off = Math.hypot(fix.xNm - stand.xNm, fix.yNm - stand.yNm);
  assert.ok(off < 0.08, `${off.toFixed(3)} nm from stand 14 (${fix.method})`);
  assert.ok(fix.score >= 0.75, `score ${fix.score}`);
});

test('the marker is found when the screen colours drift', () => {
  const s = screen();
  const panel = blankButtons(crop(s, findMinimap(s)));
  const base = findMarker(panel);
  assert.ok(base);
  for (const sh of [[-20, 30, -15], [25, -30, 20], [0, 40, 0], [30, 30, 30], [-45, -45, -45]]) {
    const d = new Uint8ClampedArray(panel.data.length);
    for (let i = 0; i < d.length; i += 4) { d[i] = panel.data[i] + sh[0]; d[i + 1] = panel.data[i + 1] + sh[1]; d[i + 2] = panel.data[i + 2] + sh[2]; d[i + 3] = 255; }
    const m = findMarker({ width: panel.width, height: panel.height, data: d });
    assert.ok(m && Math.hypot(m.x - base.x, m.y - base.y) < 3, `${sh}: ${JSON.stringify(m)}`);
  }
});

test('filter: from the stand into the air through a 12 s gap, never frozen', () => {
  const f = createPositionFilter();
  let t = 0, x = 20.84;
  const y = 21.35;
  f.anchor(x, y, t);
  for (let i = 0; i < 600; i++) {
    t += 1;
    x += (t < 120 ? 15 : Math.min(250, 15 + (t - 120) * 4)) / 3600;
    if (t >= 300 && t < 312) continue;
    const v = f.accept(x, y, 0.9, t);
    assert.ok(v.ok, `t=${t}: ${v.reason}`);
  }
  assert.ok(f.speedKt > 240);
});

test('filter: through a gap on final it keeps moving, then refuses a far look-alike after landing', () => {
  const f = createPositionFilter();
  let t = 0, x = 10;
  const y = 23.2;
  f.anchor(x, y, t);
  for (let i = 0; i < 60; i++) { t += 1; x -= 140 / 3600; assert.ok(f.accept(x, y, 0.9, t).ok); }
  const last = f.position;
  assert.ok(Math.abs(last.xNm - f.positionAt(t + 20).xNm - (140 / 3600) * 20) < 1e-6, 'carried along the track');
  assert.ok(Math.abs(f.positionAt(t + 300).xNm - f.positionAt(t + 30).xNm) < 1e-9, 'held after 30 s');
  t += 60;
  assert.ok(!f.accept(x - 1.3 + 0.5, y + 3, 0.95, t).ok, 'look-alike 3 nm away believed');
  assert.ok(f.accept(x - 1.3, y, 0.9, t + 1).ok, 'real position refused');
});

test('filter: a parked aircraft cannot jump', () => {
  const f = createPositionFilter();
  f.anchor(20.84, 21.35, 0);
  for (let t = 1; t < 6; t++) assert.ok(f.accept(20.84, 21.35, 0.9, t).ok);
  assert.ok(!f.accept(20.0, 21.0, 0.95, 6).ok);
});
