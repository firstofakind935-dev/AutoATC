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

  return { create, update, targets, DEFAULT_TUNING };
});
