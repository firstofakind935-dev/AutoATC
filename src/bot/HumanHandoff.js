const { handoffRegistry } = require('../handoff/HandoffRegistry');

/**
 * Decides whether this bot should stay quiet on a channel because a human
 * controller is handling it instead.
 *
 * Two ways that happens:
 * - A human controller is logged on to this position (or above it at the
 *   same airport, covering below) in the fleet's HandoffRegistry - see
 *   src/handoff/HandoffRegistry.js. AtcBot also leaves the voice channel
 *   entirely in that case, not just stays quiet.
 * - An operator paused it by hand with /pause (see AtcBot's command
 *   handling), which keeps the bot in the channel but silent.
 */
class HumanHandoff {
  constructor(persona, registry = handoffRegistry) {
    this.persona = persona;
    this.registry = registry;
    this.manuallyPaused = false;
  }

  pause() {
    this.manuallyPaused = true;
  }

  resume() {
    this.manuallyPaused = false;
  }

  /** The human controller's log-on covering this position, or null. */
  coveringLogon() {
    return this.registry.coveringLogon(this.persona);
  }

  async isExternalHandoffActive() {
    return this.coveringLogon() !== null;
  }

  async shouldStayQuiet() {
    if (this.manuallyPaused) return true;
    return this.isExternalHandoffActive();
  }
}

module.exports = { HumanHandoff };
