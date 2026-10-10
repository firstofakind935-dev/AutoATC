const test = require('node:test');
const assert = require('node:assert');
const { findMarker, fixFromMap, loadWorldMask } = require('../companion/lib/mapFix');

// A fake screenshot of the game map: a window of the world mask drawn at `zoom`, with the aircraft
// marker (light green, as in the real game) at a known spot.
function fakeShot(world, { x0, y0, width, height, zoom, marker }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const wx = Math.min(world.width - 1, Math.floor(x0 + x / zoom)), wy = Math.min(world.height - 1, Math.floor(y0 + y / zoom));
      const land = world.values[wy * world.width + wx] > 0.5;
      const o = (y * width + x) * 4;
      [data[o], data[o + 1], data[o + 2]] = land ? [67, 137, 68] : [59, 90, 125];
      data[o + 3] = 255;
    }
  }
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const o = ((marker.y + dy) * width + marker.x + dx) * 4;
    [data[o], data[o + 1], data[o + 2]] = [161, 233, 93];
  }
  return { width, height, data };
}

test('finds the green marker and ignores the map\'s own greens', () => {
  const world = loadWorldMask();
  const shot = fakeShot(world, { x0: 400, y0: 400, width: 300, height: 300, zoom: 3, marker: { x: 120, y: 80 } });
  const m = findMarker(shot);
  assert.ok(Math.abs(m.x - 120) < 0.6 && Math.abs(m.y - 80) < 0.6);
  assert.strictEqual(findMarker({ width: 10, height: 10, data: new Uint8ClampedArray(400) }), null);
});

test('works out where a zoomed map is looking and puts the marker on the radar grid', async () => {
  const world = loadWorldMask();
  // Zoomed in on Rockford's airport, marker at a known screenshot pixel.
  const spec = { x0: 440, y0: 450, width: 360, height: 340, zoom: 6.5, marker: { x: 200, y: 150 } };
  const fix = await fixFromMap(fakeShot(world, spec), { world });
  assert.ok(!fix.error, fix.error);
  const expectX = (spec.x0 + spec.marker.x / spec.zoom) / world.pxPerNm;
  const expectY = (spec.y0 + spec.marker.y / spec.zoom) / world.pxPerNm;
  assert.ok(Math.abs(fix.xNm - expectX) < 0.05, `x ${fix.xNm} vs ${expectX}`);
  assert.ok(Math.abs(fix.yNm - expectY) < 0.05, `y ${fix.yNm} vs ${expectY}`);
  // Reusing the last view as a hint gives the same answer.
  const again = await fixFromMap(fakeShot(world, spec), { world, hint: { zoom: fix.zoom, x0: fix.x0 + 2, y0: fix.y0 - 2, score: fix.score } });
  assert.ok(Math.abs(again.xNm - fix.xNm) < 0.02);
});

test('says so when there is no marker', async () => {
  const world = loadWorldMask();
  const shot = fakeShot(world, { x0: 440, y0: 450, width: 200, height: 200, zoom: 5, marker: { x: 50, y: 50 } });
  for (let i = 0; i < shot.data.length; i += 4) if (shot.data[i + 1] > 200) { shot.data[i] = 67; shot.data[i + 1] = 137; shot.data[i + 2] = 68; }
  assert.match((await fixFromMap(shot, { world })).error, /marker/);
});
