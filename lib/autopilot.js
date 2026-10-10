// Autopilot: turns targets (selected on the FCU/MCP, or managed by the FMS)
// into short key presses for PTFS - roll left/right, pitch up/down,
// throttle up/down.
//
// The only feedback is what the companion app reads off the game's HUD
// every tracking update: heading, altitude and speed, every few seconds. No
// bank or pitch angle. So each axis controls a *rate* instead: work out how
// fast heading/altitude/speed should be changing to reach the target, see
// how fast they actually changed since the last update, and tap the key
// that closes the gap - a longer tap for a bigger gap. Taps rather than held
// keys, so a misread HUD value can only ever cost one short input.
//
// Plain functions over a plain state object, so the FMS window loads this
// with a <script> tag and node's test runner can require it.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Autopilot = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const norm = (d) => ((d % 360) + 360) % 360;
  function angleDiff(a, b) {
    let d = norm(a - b);
    if (d > 180) d -= 360;
    return d;
  }

  const DEFAULT_TUNING = {
    // Heading: aim for a turn rate proportional to the heading error, up
    // to standard rate (3 deg/s).
    turnRatePerDegErr: 0.15,
    maxTurnRateDegS: 3,
    turnRateDeadbandDegS: 0.4,
    rollMsPerDegS: 120,
    // Altitude: aim for a vertical speed proportional to the altitude error.
    vsPerFtErr: 1.5,
    vsDeadbandFpm: 200,
    pitchMsPerFpm: 0.12,
    // Speed: throttle taps proportional to the speed error.
    speedDeadbandKt: 4,
    throttleMsPerKt: 15,
    // Slowing down: aircraft shed speed slowly, so when over the target the
    // throttle comes back harder (longer taps, and a bigger cap) than when adding thrust.
    decelBoost: 2,
    // A/D-key steering (24Flight style): the heading error that gives full deflection.
    yokeFullDeg: 90,
    maxDecelPulseMs: 900,
    // Never tap shorter (the game may not register it) or longer (one bad
    // reading shouldn't throw the aircraft around) than these.
    minPulseMs: 40,
    maxPulseMs: 450,
    // Telemetry older than this is ignored; with none for staleDisengageMs
    // the autopilot disconnects itself.
    staleMs: 15000,
    staleDisengageMs: 30000,
  };

  function create(tuning = {}) {
    return {
      engaged: false,
      autothrottle: false,
      lateral: 'HDG', // HDG | LNAV
      vertical: 'ALT', // ALT | VS | VNAV
      speedMode: 'SEL', // SEL | MANAGED
      selected: { headingDeg: 0, altFt: 3000, vsFpm: 1500, speedKt: 250 },
      tuning: { ...DEFAULT_TUNING, ...tuning },
      last: null, // previous telemetry sample
      lastSampleAtMs: null,
      disconnectReason: null,
    };
  }

  function pulse(axis, direction, ms, t, maxMs = t.maxPulseMs) {
    return { axis, direction, ms: Math.round(clamp(ms, t.minPulseMs, maxMs)) };
  }

  /** The targets this update should fly, from the active modes. */
  function targets(ap, guidance) {
    const out = {};
    if (ap.lateral === 'LNAV' && guidance?.lnav) out.headingDeg = guidance.lnav.headingDeg;
    else out.headingDeg = ap.selected.headingDeg;

    if (ap.vertical === 'VNAV' && guidance?.vnav) {
      // Managed: the FMS altitude, but never through the altitude selected
      // on the panel (the clearance limit), like a real VNAV.
      const fmsAlt = guidance.vnav.targetAltFt;
      out.altFt = guidance.vnav.verticalSpeedFpm >= 0 ? Math.min(fmsAlt, ap.selected.altFt) : Math.max(fmsAlt, ap.selected.altFt);
      out.maxVsFpm = Math.abs(guidance.vnav.verticalSpeedFpm) || ap.selected.vsFpm;
    } else {
      out.altFt = ap.selected.altFt;
      out.maxVsFpm = ap.vertical === 'VS' ? Math.abs(ap.selected.vsFpm) : 2000;
    }

    out.speedKt = ap.speedMode === 'MANAGED' && guidance?.speedKt ? guidance.speedKt : ap.selected.speedKt;
    return out;
  }

  /**
   * One control update. `sample` = {headingDeg, altFt, speedKt, atMs} from
   * the HUD. Returns {commands: [{axis, direction, ms}], targets, rates,
   * disconnected}. axis is roll/pitch/throttle; direction is +1
   * (right / nose up / more thrust) or -1.
   */
  function update(ap, sample, guidance, nowMs = Date.now()) {
    const t = ap.tuning;
    const result = { commands: [], targets: targets(ap, guidance), rates: null, disconnected: false };

    const fresh = sample && typeof sample.headingDeg === 'number' && nowMs - sample.atMs < t.staleMs;
    if (!fresh) {
      if (ap.engaged && ap.lastSampleAtMs !== null && nowMs - ap.lastSampleAtMs > t.staleDisengageMs) {
        ap.engaged = false;
        ap.autothrottle = false;
        ap.disconnectReason = 'No tracking data - autopilot disconnected';
        result.disconnected = true;
      }
      return result;
    }

    const prev = ap.last;
    ap.last = sample;
    ap.lastSampleAtMs = sample.atMs;
    if (!prev || sample.atMs <= prev.atMs) return result; // need two samples for rates
    const dtS = (sample.atMs - prev.atMs) / 1000;
    const rates = {
      turnDegS: angleDiff(sample.headingDeg, prev.headingDeg) / dtS,
      vsFpm: typeof sample.altFt === 'number' && typeof prev.altFt === 'number' ? ((sample.altFt - prev.altFt) / dtS) * 60 : null,
      accelKtS: typeof sample.speedKt === 'number' && typeof prev.speedKt === 'number' ? (sample.speedKt - prev.speedKt) / dtS : null,
    };
    result.rates = rates;

    const tg = result.targets;

    if (ap.engaged) {
      const headingErr = angleDiff(tg.headingDeg, sample.headingDeg);
      const wantedTurn = clamp(headingErr * t.turnRatePerDegErr, -t.maxTurnRateDegS, t.maxTurnRateDegS);
      const turnGap = wantedTurn - rates.turnDegS;
      if (Math.abs(turnGap) > t.turnRateDeadbandDegS) {
        result.commands.push(pulse('roll', Math.sign(turnGap), Math.abs(turnGap) * t.rollMsPerDegS, t));
      }

      if (typeof sample.altFt === 'number' && rates.vsFpm !== null) {
        const altErr = tg.altFt - sample.altFt;
        const wantedVs = clamp(altErr * t.vsPerFtErr, -tg.maxVsFpm, tg.maxVsFpm);
        const vsGap = wantedVs - rates.vsFpm;
        if (Math.abs(vsGap) > t.vsDeadbandFpm) {
          result.commands.push(pulse('pitch', Math.sign(vsGap), Math.abs(vsGap) * t.pitchMsPerFpm, t));
        }
      }
    }

    if (ap.autothrottle && typeof sample.speedKt === 'number') {
      const speedErr = tg.speedKt - sample.speedKt;
      // Don't keep adding thrust while the speed is already heading the
      // right way quickly enough.
      const closing = rates.accelKtS !== null && Math.sign(rates.accelKtS) === Math.sign(speedErr) && Math.abs(rates.accelKtS) > 1;
      if (Math.abs(speedErr) > t.speedDeadbandKt && !closing) {
        const slowing = speedErr < 0;
        const ms = Math.abs(speedErr) * t.throttleMsPerKt * (slowing ? t.decelBoost : 1);
        result.commands.push(pulse('throttle', Math.sign(speedErr), ms, t, slowing ? t.maxDecelPulseMs : t.maxPulseMs));
      }
    }

    return result;
  }

  // ---- tuning aids -----------------------------------------------------------

  // The gains the settings page lets you edit, with sane limits.
  const TUNABLE = {
    turnRatePerDegErr: [0.02, 0.6],
    maxTurnRateDegS: [0.5, 6],
    rollMsPerDegS: [20, 600],
    vsPerFtErr: [0.3, 5],
    pitchMsPerFpm: [0.02, 0.6],
    throttleMsPerKt: [3, 80],
    decelBoost: [1, 4],
    yokeFullDeg: [20, 180],
  };

  /** Applies edited gains, ignoring anything unknown or out of range. Returns the keys changed. */
  function setTuning(ap, values) {
    const changed = [];
    for (const [key, value] of Object.entries(values || {})) {
      const range = TUNABLE[key];
      const n = Number(value);
      if (!range || !Number.isFinite(n) || n < range[0] || n > range[1]) continue;
      ap.tuning[key] = n;
      changed.push(key);
    }
    return changed;
  }

  // ---- A/D-key steering ----------------------------------------------------
  // Ported from 24Flight Desktop's autopilot (MIT, see THIRD_PARTY.md): the yoke is
  // a percentage, proportional to the heading error (full at 90 degrees), and
  // a key is pulsed with a duty cycle that grows with it - a short tap after a
  // long rest for a small correction, almost held for a big one.

  /** Heading error (deg, + = target is to the right) -> yoke -100 (full left) .. +100 (full right). */
  function yokePercent(headingErrDeg, fullDeg = DEFAULT_TUNING.yokeFullDeg) {
    return clamp((headingErrDeg / fullDeg) * 100, -100, 100);
  }

  /**
   * The next key pulse for `pct`, or null when it is not time. `state` ({nextAt}) is kept by the caller.
   * Returns {direction: +1 | -1, holdMs}; call it every ~80 ms.
   */
  function yokePulse(pct, nowMs, state) {
    const magnitude = Math.abs(pct);
    if (magnitude <= 2) { state.nextAt = 0; return null; } // inside the deadband: let go
    if (nowMs < (state.nextAt || 0)) return null;
    const n = Math.min(100, magnitude) / 100;
    const holdMs = Math.round(40 + n * 180);
    const restMs = Math.round(80 + (1 - n) * 220);
    state.nextAt = nowMs + holdMs + restMs;
    return { direction: Math.sign(pct), holdMs };
  }

  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  function ratesOf(samples, field) {
    const out = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i].atMs - samples[i - 1].atMs) / 1000;
      if (dt <= 0) continue;
      const delta = field === 'headingDeg' ? angleDiff(samples[i].headingDeg, samples[i - 1].headingDeg) : samples[i][field] - samples[i - 1][field];
      out.push(field === 'altFt' ? (delta / dt) * 60 : delta / dt); // altitude as fpm, heading as deg/s, speed as kt/s
    }
    return out;
  }

  /**
   * Works out one gain from a test: `before` = samples taken while the
   * aircraft was steady, `after` = samples taken after one `pulseMs` tap on
   * the axis. Returns {key, value, change} or null when the response was too
   * small to trust (not live, wrong window, aircraft already moving a lot...).
   *   roll     -> rollMsPerDegS    = ms per deg/s of turn rate added
   *   pitch    -> pitchMsPerFpm    = ms per fpm of vertical speed added
   *   throttle -> throttleMsPerKt  = ms per kt of speed gained or lost
   */
  function measureResponse(axis, before, after, pulseMs, direction = 1) {
    const spec = { roll: ['headingDeg', 'rollMsPerDegS', 0.4], pitch: ['altFt', 'pitchMsPerFpm', 150], throttle: ['speedKt', 'throttleMsPerKt', 3] }[axis];
    if (!spec || !(pulseMs > 0) || !before || !after || before.length < 3 || after.length < 3) return null;
    const [field, key, minChange] = spec;
    let change;
    if (axis === 'throttle') {
      // speed settles slowly: compare where it was before with where it ended up
      change = (mean(after.slice(-2).map((x) => x.speedKt)) - mean(before.slice(-2).map((x) => x.speedKt))) * direction;
    } else {
      change = (Math.max(...ratesOf(after, field).map((r) => r * direction)) - mean(ratesOf(before, field))) * 1;
    }
    if (!(change > minChange)) return null;
    const value = pulseMs / change;
    const range = TUNABLE[key];
    return { key, value: Math.round(clamp(value, range[0], range[1]) * 1000) / 1000, change };
  }

  const LOG_COLUMNS = ['t', 'hdg', 'hdgTarget', 'alt', 'altTarget', 'vsFpm', 'speed', 'speedTarget', 'turnDegS', 'accelKtS', 'commands'];
  /** One CSV row for the flight log (see Download flight log in the FMS settings). */
  function logRow(sample, result) {
    const tg = result.targets || {};
    const r = result.rates || {};
    const f = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) : '');
    return [new Date(sample.atMs).toISOString().slice(11, 23), f(sample.headingDeg, 0), f(tg.headingDeg, 0), f(sample.altFt, 0), f(tg.altFt, 0), f(r.vsFpm, 0), f(sample.speedKt, 0), f(tg.speedKt, 0), f(r.turnDegS, 2), f(r.accelKtS, 2),
      (result.commands || []).map((c) => `${c.axis}${c.direction > 0 ? '+' : '-'}${c.ms}`).join(' ')];
  }
  const toCsv = (rows) => [LOG_COLUMNS.join(','), ...rows.map((r) => r.join(','))].join('\n');

  return { create, update, targets, yokePercent, yokePulse, setTuning, measureResponse, logRow, toCsv, DEFAULT_TUNING, TUNABLE, LOG_COLUMNS };
});
