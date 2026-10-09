// Saved flight plans, by short plan ID and by callsign (latest wins), so a
// pilot can import into the companion's FMS by either. Kept in memory and
// mirrored to a JSON file so plans survive a restart where the host keeps
// the disk - on Railway that means attaching a volume and pointing
// PLANS_FILE at it; without one, plans last until the next deploy.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PLANS = 5000;
const PLAN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// No 0/O or 1/I - plan IDs get read off a screen and typed into an MCDU.
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class PlanStore {
  constructor(file) {
    this.file = file || null;
    this.plans = new Map(); // id -> plan, oldest first
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      for (const plan of JSON.parse(fs.readFileSync(this.file, 'utf8'))) this.plans.set(plan.id, plan);
      this._prune();
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[planner] Could not read ${this.file}: ${err.message}`);
    }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify([...this.plans.values()]));
    } catch (err) {
      console.warn(`[planner] Could not save plans to ${this.file}: ${err.message}`);
    }
  }

  _prune() {
    const cutoff = Date.now() - PLAN_TTL_MS;
    for (const [id, plan] of this.plans) {
      if (Date.parse(plan.createdAt) < cutoff || this.plans.size > MAX_PLANS) this.plans.delete(id);
      else break;
    }
  }

  _newId() {
    for (;;) {
      const bytes = crypto.randomBytes(6);
      const id = [...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
      if (!this.plans.has(id)) return id;
    }
  }

  add(plan) {
    const saved = { id: this._newId(), createdAt: new Date().toISOString(), ...plan };
    this.plans.set(saved.id, saved);
    this._prune();
    this._save();
    return saved;
  }

  get(id) {
    return this.plans.get(String(id || '').toUpperCase()) || null;
  }

  latestForCallsign(callsign) {
    const wanted = String(callsign || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let latest = null;
    for (const plan of this.plans.values()) if (plan.callsign === wanted) latest = plan;
    return latest;
  }
}

module.exports = { PlanStore };
