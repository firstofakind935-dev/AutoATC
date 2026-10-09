#!/usr/bin/env node
// Copies the phone/tablet remote-control page into the flight planner, so
// the planner's relay can serve it to phones anywhere (planner/lib/relay.js).
//
// The planner deploys on its own (Railway root directory: planner/), so it
// can't reach companion/ at runtime - it needs its own copy. The companion
// files are the originals: edit those, then run
//     node scripts/sync-remote-page.js
// test/remote-page-sync.test.js fails if the copies have drifted.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'planner', 'public', 'remote');

// [source, name in planner/public/remote/]
const FILES = [
  ['companion/remote/index.html', 'index.html'],
  ['companion/remote/remote.js', 'remote.js'],
  ['companion/remote/remote.css', 'remote.css'],
  ['companion/remote/manifest.json', 'manifest.json'],
  ['companion/remote/icon.svg', 'icon.svg'],
  ['companion/renderer/fms.css', 'fms.css'],
  ['companion/renderer/fmsView.js', 'fmsView.js'],
];

function main() {
  fs.mkdirSync(DEST, { recursive: true });
  for (const [src, name] of FILES) fs.copyFileSync(path.join(ROOT, src), path.join(DEST, name));
  console.log(`Copied ${FILES.length} files to ${path.relative(ROOT, DEST)}/`);
}

if (require.main === module) main();

module.exports = { FILES, DEST, ROOT };
