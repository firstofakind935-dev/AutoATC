// Applications on disk: one JSON file, rewritten atomically on every change. Keyed by Discord user id, which is
// what makes it one application per Discord account. On Railway, attach a volume to the monitor service so the
// file survives redeploys (RAILWAY_VOLUME_MOUNT_PATH is then set and used automatically).
const fs = require('fs');
const path = require('path');

function createStore(dir) {
  const persistent = !!dir;
  const base = dir || path.join(__dirname, '..', '..', 'data', 'apply');
  const file = path.join(base, 'applications.json');
  let state = { applications: {} };
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!state || typeof state.applications !== 'object') state = { applications: {} };
  } catch { /* first run */ }

  function save() {
    fs.mkdirSync(base, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, file);
  }

  return {
    persistent,
    file,
    get: (uid) => state.applications[uid] || null,
    list: () => Object.values(state.applications).sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt))),
    /** Adds an application; false if this Discord account already has one. */
    create(uid, application) {
      if (state.applications[uid]) return false;
      state.applications[uid] = application;
      save();
      return true;
    },
    update(uid, patch) {
      const a = state.applications[uid];
      if (!a) return null;
      Object.assign(a, patch);
      save();
      return a;
    },
    remove(uid) {
      if (!state.applications[uid]) return false;
      delete state.applications[uid];
      save();
      return true;
    },
  };
}

module.exports = { createStore };
