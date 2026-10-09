const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { FILES, DEST, ROOT } = require('../scripts/sync-remote-page');

test("the planner's copy of the phone remote page matches the companion's", () => {
  for (const [src, name] of FILES) {
    const original = fs.readFileSync(path.join(ROOT, src), 'utf8');
    const copy = fs.readFileSync(path.join(DEST, name), 'utf8');
    assert.equal(copy, original, `planner/public/remote/${name} is out of date - run: node scripts/sync-remote-page.js`);
  }
});
