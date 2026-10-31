// Phone radar tracking: a PTFS screenshot (PC, parked at Rockford stand 14) goes through the server's tracker the way
// the Android app sends it - the whole screen first to find the minimap, then the minimap crop for the position.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const jpeg = require('../monitor/node_modules/jpeg-js');
const { createPhoneTracker } = require('../monitor/tracker/phoneTracker');

test('finds the minimap on a full screenshot, then the aircraft on the minimap', async () => {
  const shot = fs.readFileSync(path.join(__dirname, 'fixtures', 'ptfs_irfd_stand14.jpg'));
  const t = createPhoneTracker({ onPosition() {}, logger: { error() {} } });
  try {
    const a = await t.submit('DAL123', 'full', shot);
    assert.ok(a.ok, a.reason);
    const full = jpeg.decode(shot, { formatAsRGBA: true });
    const r = a.minimap;
    assert.ok(r.x > 0.8 && r.y > 0.7, 'bottom right, where PTFS puts it');
    const cx = Math.round(r.x * full.width), cy = Math.round(r.y * full.height), cw = Math.round(r.w * full.width), ch = Math.round(r.h * full.height);
    const crop = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < ch; y++) full.data.copy(crop, y * cw * 4, ((cy + y) * full.width + cx) * 4, ((cy + y) * full.width + cx + cw) * 4);
    const b = await t.submit('DAL123', 'mini', jpeg.encode({ width: cw, height: ch, data: crop }, 80).data);
    assert.ok(b.ok, b.reason);
    assert.strictEqual(b.position.referenceAirport, 'IRFD');
    assert.ok(b.position.distanceNm < 0.5, `parked at the airport (${b.position.distanceNm} nm)`);
    const blank = await t.submit('N1', 'full', jpeg.encode({ width: 64, height: 64, data: Buffer.alloc(64 * 64 * 4, 40) }, 80).data);
    assert.strictEqual(blank.ok, false);
  } finally { t.stop(); }
});
