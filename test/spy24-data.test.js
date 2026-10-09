// The 24SPY data in the radar: attribution kept, positions sane, nothing lost.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'monitor', 'public', '365radar', 'src', 'data');
const text = fs.readFileSync(path.join(DATA, 'spy24Data.js'), 'utf8');
const data = JSON.parse(text.slice(text.indexOf('export default') + 'export default'.length).trim().replace(/;$/, ''));

test('the data file credits 24SPY and says it is a modified copy', () => {
  assert.match(text, /Tiago Murteira/);
  assert.match(text, /github\.com\/tiaguinho2009\/24SPY/);
  assert.match(text, /MODIFIED COPY/);
  assert.match(text, /non-commercial/i);
  assert.ok(data.meta.sourceCommit);
});

test('the full 24SPY licence ships beside the data', () => {
  const notice = fs.readFileSync(path.join(DATA, '24SPY-NOTICE.md'), 'utf8');
  assert.match(notice, /Non-Commercial Use/);
  assert.match(notice, /Attribution/);
  assert.match(notice, /modified copy/i);
});

test('every waypoint 365Radar already had is still there', () => {
  const old = [...fs.readFileSync(path.join(DATA, 'fixes.js'), 'utf8').matchAll(/identifier:\s*'(\w+)'/g)].map((m) => m[1]);
  const have = new Set(data.waypoints.map((w) => w.id));
  assert.ok(old.length > 100);
  assert.deepEqual(old.filter((id) => !have.has(id)), []);
  assert.equal(have.size, data.waypoints.length, 'no duplicate waypoints');
});

test('everything lands on the world map, and the fit to our airports is tight', () => {
  const W = 937, H = 706, slack = 120; // outlines may run a little past the picture's edge
  const inside = ([x, y]) => x > -slack && x < W + slack && y > -slack && y < H + slack;
  assert.ok(data.waypoints.every((w) => inside([w.x, w.y])), 'waypoints');
  assert.ok(data.areas.every((a) => a.points.length > 2 && a.points.every(inside)), 'areas');
  assert.ok(data.airways.every((a) => a.points.length >= 2 && a.points.every(([, x, y]) => inside([x, y]))), 'airways');
  assert.ok(data.meta.fit.medianErrorPx / data.meta.fit.pxPerNm < 1, `median fit error ${data.meta.fit.medianErrorPx}px`);
  assert.ok(data.meta.fit.airports >= 15);
});
