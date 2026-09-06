/**
 * Decides whether this bot should stay quiet on a channel because a human
 * controller is handling it instead.
 *
 * How a server actually detects "a human controller is active" is left
 * unimplemented on purpose — every server's existing ATC system (roster
 * bots, roles, external booking tools, etc.) is different, and that
 * integration was explicitly deferred. `isExternalHandoffActive()` below
 * is the extension point: replace its body with a call into your server's
 * ATC system (e.g. check a role, hit an internal API, read a booking
 * channel) and the rest of the bot will respect it automatically.
 *
 * In the meantime, operators get a manual override via chat commands
 * (see AtcBot's command handling) so the bot can be silenced by hand.
 */
class HumanHandoff {
  constructor() {
    this.manuallyPaused = false;
  }

  pause() {
    this.manuallyPaused = true;
  }

  resume() {
    this.manuallyPaused = false;
  }

  /**
   * TODO(integration): wire this up to your server's real ATC system.
   * Return true when a human controller is actively working this position,
   * so the AI should not transmit. Always returns false today (stub).
   */
  // eslint-disable-next-line class-methods-use-this
  async isExternalHandoffActive(/* guildId, channelId */) {
    return false;
  }

  async shouldStayQuiet(guildId, channelId) {
    if (this.manuallyPaused) return true;
    return this.isExternalHandoffActive(guildId, channelId);
  }
}

module.exports = { HumanHandoff };
