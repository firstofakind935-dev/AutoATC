// Decides which minimap fixes to believe, and where the aircraft is between them. A port of the tracker's
// src/position_filter.py (test-pim-vpilot), with the same numbers. Positions are on the radar grid (nm); times in
// seconds.
//
//  - a fix that agrees with where we could be is taken: parked, within ~0.25 nm; moving, near the path between the
//    last fix and where the last track leads (an aircraft that slowed down - say it landed - is somewhere along it),
//    with room that grows slowly with the gap;
//  - anything else needs CONFIRMATIONS agreeing strong fixes in a row (a look-alike match changes every time; a real
//    one doesn't) - and while parked, the same answer held for PARKED_HOLD_SECONDS (a static scene repeats the same
//    wrong match every frame, so counting frames alone proves nothing);
//  - with no fix (open sea, a small island on final) the position keeps moving along the track for COAST_SECONDS.
// A stand entry or an ATC clearance (anchor) sets the position directly.

const CONFIRMATIONS = 3;
const TRUST_SCORE = 0.75;
const PARKED_KT = 5;
const PARKED_TRUST_SCORE = 0.85;
const PARKED_HOLD_SECONDS = 60;
const SPEED_WINDOW_S = 10;
const COAST_SECONDS = 30;
const MOVING_KT = 30;
const SPEED_CHANGE_KT = 60;

function createPositionFilter({ trustScore = TRUST_SCORE, confirmations = CONFIRMATIONS } = {}) {
  let pos = null; // [x, y]
  let t = null;
  let speedKt = null;
  let velocity = null; // [vx, vy] nm per hour
  let pending = null; // {x, y, count, since}
  let track = []; // [[t, x, y]]

  const moving = () => velocity !== null && speedKt !== null && speedKt >= MOVING_KT;

  function take(x, y, now) {
    track = track.filter((p) => now - p[0] <= SPEED_WINDOW_S).concat([[now, x, y]]);
    const [t0, x0, y0] = track[0];
    if (now - t0 >= 3) {
      const dtH = (now - t0) / 3600;
      velocity = [(x - x0) / dtH, (y - y0) / dtH];
      speedKt = Math.hypot(velocity[0], velocity[1]);
    }
    pos = [x, y];
    t = now;
    pending = null;
  }

  function distanceFromPath(x, y, now) {
    const [ax, ay] = pos;
    if (!moving()) return Math.hypot(x - ax, y - ay);
    const dtH = Math.max(0, now - t) / 3600;
    const dx = velocity[0] * dtH, dy = velocity[1] * dtH;
    const L2 = dx * dx + dy * dy;
    const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    return Math.hypot(x - (ax + u * dx), y - (ay + u * dy));
  }

  return {
    get hasPosition() { return pos !== null; },
    get speedKt() { return speedKt; },
    get position() { return pos && { xNm: pos[0], yNm: pos[1] }; },
    /** A known position (a stand, an ATC clearance): trusted outright, and we are parked. */
    anchor(x, y, now) {
      pos = [x, y]; t = now; speedKt = 0; velocity = [0, 0]; pending = null; track = [[now, x, y]];
    },
    /** A position we were told outright that is not a parked spot (a manual map fix): taken, track kept. */
    set(x, y, now) { take(x, y, now); },
    /** The direction of travel from the track (degrees true), or null when not moving. */
    trackDeg() {
      if (!moving()) return null;
      return ((Math.atan2(velocity[0], -velocity[1]) * 180) / Math.PI + 360) % 360;
    },
    /** Where we believe the aircraft is now: the last fix carried along the track for up to COAST_SECONDS. */
    positionAt(now) {
      if (!pos) return null;
      if (!moving()) return { xNm: pos[0], yNm: pos[1] };
      const dtH = Math.min(Math.max(0, now - t), COAST_SECONDS) / 3600;
      return { xNm: pos[0] + velocity[0] * dtH, yNm: pos[1] + velocity[1] * dtH };
    },
    /** -> {ok, reason}. ok: use this fix as the position. */
    accept(x, y, score, now) {
      if (!pos) {
        if (score >= trustScore) { take(x, y, now); return { ok: true, reason: 'first fix' }; }
        return { ok: false, reason: `first fix too weak (${Math.round(score * 100)}% match)` };
      }
      const moved = Math.hypot(x - pos[0], y - pos[1]);
      const parked = speedKt !== null && speedKt < PARKED_KT;
      const sinceH = Math.max(0, now - t) / 3600;
      let off, allowed;
      if (parked) { off = moved; allowed = 0.25 + sinceH * 40; } // it can only have started taxiing since (~40 kt)
      else if (moving()) { off = distanceFromPath(x, y, now); allowed = 0.4 + sinceH * SPEED_CHANGE_KT; }
      else { off = moved; allowed = 0.4 + sinceH * 150; } // slow or unknown: taxiing, or just started
      if (off <= allowed) { take(x, y, now); return { ok: true, reason: 'agrees' }; }
      const same = pending && Math.hypot(x - pending.x, y - pending.y) < 0.3;
      pending = same ? { x, y, count: pending.count + 1, since: pending.since } : { x, y, count: 1, since: now };
      const needScore = parked ? PARKED_TRUST_SCORE : trustScore;
      const held = parked ? now - pending.since >= PARKED_HOLD_SECONDS : true;
      if (pending.count >= confirmations && score >= needScore && held) { take(x, y, now); return { ok: true, reason: 'jump confirmed' }; }
      return {
        ok: false,
        reason: `ignored: ${moved.toFixed(1)} nm from where you were, ${Math.round(score * 100)}% match, ${pending.count}/${confirmations} agreeing${parked ? ', parked' : ''}`,
      };
    },
  };
}

module.exports = { createPositionFilter, COAST_SECONDS };
