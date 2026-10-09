const { EventEmitter } = require('events');
const { RANK } = require('../botmanager/hierarchy');

/**
 * Fleet-wide record of which human controllers are logged on to which
 * positions, and so which AI bots should be off frequency. Every bot runs
 * in this one process (see src/index.js), so a single in-memory registry
 * is shared by the whole fleet - each AtcBot subscribes to 'change' and
 * leaves or rejoins its voice channel to match (see AtcBot's
 * _syncWithHandoff).
 *
 * How a controller actually logs on is deliberately not decided here -
 * whatever method the server ends up using (joining a channel with a role,
 * a slash command, an external roster) just calls logon()/logoff() below.
 *
 * A log-on is for one position at one airport. With coverBelow, the
 * controller also takes every lower-ranked position at that same airport
 * (RANK from botmanager/hierarchy.js - e.g. Tower covers Ground, Apron and
 * Delivery; Center covers everything at its airport). Whether to cover
 * below is the controller's choice on each log-on. Positions outside RANK
 * (e.g. "Training") are only ever covered by an exact match.
 */
class HandoffRegistry extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0); // one listener per fleet bot - 60+ is expected, not a leak
    this.logons = new Map(); // controllerId -> { controllerId, controllerName, airport, position, coverBelow, since }
  }

  /**
   * Logs a controller on to a position, replacing any position they were
   * already logged on to (one controller works one position at a time).
   */
  logon({ controllerId, controllerName, airport, position, coverBelow = false }) {
    if (!controllerId) throw new Error('logon requires a controllerId');
    if (!airport || !position) throw new Error('logon requires an airport and a position');
    this.logons.set(String(controllerId), {
      controllerId: String(controllerId),
      controllerName: controllerName || String(controllerId),
      airport: airport.toUpperCase(),
      position,
      coverBelow: Boolean(coverBelow),
      since: new Date(),
    });
    this.emit('change');
  }

  /** Returns true if that controller was logged on. */
  logoff(controllerId) {
    const removed = this.logons.delete(String(controllerId));
    if (removed) this.emit('change');
    return removed;
  }

  /** Every current log-on, oldest first. */
  list() {
    return [...this.logons.values()];
  }

  /**
   * The log-on covering this persona ({ airport, position }), or null if
   * the AI should be working it. An exact position match wins over a
   * cover-below match, so the announcement names the controller actually
   * sitting on that position when there is one.
   */
  coveringLogon(persona) {
    if (!persona?.airport || !persona?.position) return null;
    const airport = persona.airport.toUpperCase();
    let below = null;
    for (const logon of this.logons.values()) {
      if (logon.airport !== airport) continue;
      if (logon.position === persona.position) return logon;
      if (
        !below &&
        logon.coverBelow &&
        logon.position in RANK &&
        persona.position in RANK &&
        RANK[persona.position] < RANK[logon.position]
      ) {
        below = logon;
      }
    }
    return below;
  }
}

// The fleet's shared instance. Tests construct their own.
const handoffRegistry = new HandoffRegistry();

module.exports = { HandoffRegistry, handoffRegistry };
