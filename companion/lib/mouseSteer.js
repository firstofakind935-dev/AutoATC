// Pitch and bank for PTFS, which steers toward the mouse cursor: the
// further the cursor sits from the screen point where the aircraft flies
// straight and level (the "center", captured in the FMS window's settings),
// the harder it pitches/banks.
//
// The autopilot's commands are short nudges - {direction, ms} per axis,
// the same shape as a key tap. A nudge puts the cursor `deflectionPx` off
// center on that axis for `ms`, then brings it back, so between tracking
// updates (every few seconds) the cursor rests at center and the aircraft
// isn't left rolling. Roll moves the cursor left/right, pitch up/down
// (nose up = cursor up, unless invertPitch).
//
// Manual override: if the cursor isn't where the autopilot last put it,
// the pilot has taken the mouse - steer() reports that and moves nothing,
// so the autopilot can disconnect like a real one does when the pilot
// moves the controls.
//
// Coordinates here are Electron DIPs; main.js converts to physical pixels
// for the OS. `io` is injected ({moveMouse, getCursor, now, setTimer,
// clearTimer}) so this runs under the test runner without Electron.

const OVERRIDE_PX = 40;
const OVERRIDE_WINDOW_MS = 15000;

function createMouseSteer(io) {
  let lastSet = null; // {x, y, atMs} - where we last put the cursor
  let timers = [];

  const clearTimers = () => {
    timers.forEach((t) => io.clearTimer(t));
    timers = [];
  };

  function moveTo(x, y) {
    io.moveMouse(x, y);
    lastSet = { x, y, atMs: io.now() };
  }

  function overridden() {
    if (!lastSet || io.now() - lastSet.atMs > OVERRIDE_WINDOW_MS) return false;
    const cur = io.getCursor();
    return Math.hypot(cur.x - lastSet.x, cur.y - lastSet.y) > OVERRIDE_PX;
  }

  /**
   * One steering update. Returns {override: true} (and does nothing) if the
   * pilot has moved the mouse since the last update.
   */
  function steer({ center, deflectionPx, invertPitch = false, roll = null, pitch = null }) {
    if (overridden()) {
      clearTimers();
      lastSet = null;
      return { override: true };
    }
    clearTimers();
    const pitchSign = invertPitch ? 1 : -1; // screen y grows downward
    const offsets = {
      roll: roll ? roll.direction * deflectionPx : 0,
      pitch: pitch ? pitchSign * pitch.direction * deflectionPx : 0,
    };
    const place = () => moveTo(center.x + offsets.roll, center.y + offsets.pitch);
    place();

    // Each axis returns to center when its own nudge ends.
    for (const [axis, cmd] of [['roll', roll], ['pitch', pitch]]) {
      if (!cmd) continue;
      timers.push(io.setTimer(() => {
        offsets[axis] = 0;
        place();
      }, cmd.ms));
    }
    return { override: false };
  }

  /** Puts the cursor back at center and forgets it (on disconnect). */
  function recenter(center) {
    clearTimers();
    if (center) io.moveMouse(center.x, center.y);
    lastSet = null;
  }

  return { steer, recenter };
}

module.exports = { createMouseSteer, OVERRIDE_PX };
