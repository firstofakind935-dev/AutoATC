const { makeLogger } = require('../utils/logger');

const logger = makeLogger('datalink');

const MONITOR_URL = process.env.MONITOR_URL || null;
const MONITOR_API_KEY = process.env.MONITOR_API_KEY || null;

const VALID_KINDS = ['contact', 'pdc', 'text'];

/**
 * Fire-and-forget push to the monitor's /api/cpdlc, which the pilot's
 * companion app polls and shows in its overlay. Must never throw or block
 * the caller - same contract as logger.js's sendToMonitor, since a monitor
 * outage should never affect the bot's own voice reply. Returns whether a
 * send was actually attempted (MONITOR_URL configured) - not whether it
 * reached the monitor, which is fire-and-forget and logged separately -
 * so a caller like the /cpdlc command can tell the human it did nothing
 * instead of falsely confirming a message that was never sent anywhere.
 */
function sendDatalinkMessage({ callsign, kind, fromPosition, facility, frequency, clearance, text }) {
  if (!MONITOR_URL) return false;
  const headers = { 'Content-Type': 'application/json' };
  if (MONITOR_API_KEY) headers.Authorization = `Bearer ${MONITOR_API_KEY}`;

  fetch(`${MONITOR_URL.replace(/\/+$/, '')}/api/cpdlc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ callsign, kind, fromPosition, facility, frequency, clearance, text }),
  })
    .then(async (response) => {
      // fetch() only rejects on a network-level failure - a non-2xx HTTP
      // response (e.g. 401 from a mismatched MONITOR_API_KEY, 400 from a
      // bad payload) resolves normally and would otherwise pass through
      // completely unlogged, silently dropping the message.
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(`CPDLC/PDC message for ${callsign} rejected by monitor (${response.status}): ${body}`);
      }
    })
    .catch((err) => logger.warn(`Failed to send CPDLC/PDC message for ${callsign}: ${err.message}`));
  return true;
}

/**
 * Fire-and-forget push to the monitor's /api/cpdlc/broadcast - reaches
 * every pilot currently polling, not just one callsign. Used for moderator
 * announcements/news (see the /broadcast slash command), never by the LLM
 * itself - a "contact"/"pdc" message is inherently addressed to one
 * aircraft, so only free text makes sense to broadcast fleet-wide. Return
 * value has the same "attempted, not confirmed" meaning as
 * sendDatalinkMessage above.
 */
function sendBroadcastMessage({ fromPosition, text }) {
  if (!MONITOR_URL) return false;
  const headers = { 'Content-Type': 'application/json' };
  if (MONITOR_API_KEY) headers.Authorization = `Bearer ${MONITOR_API_KEY}`;

  fetch(`${MONITOR_URL.replace(/\/+$/, '')}/api/cpdlc/broadcast`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fromPosition, text }),
  })
    .then(async (response) => {
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        logger.warn(`CPDLC broadcast rejected by monitor (${response.status}): ${body}`);
      }
    })
    .catch((err) => logger.warn(`Failed to send CPDLC broadcast: ${err.message}`));
  return true;
}

/**
 * Parses a trailing "CPDLC: {...}" line off a raw model reply (see
 * systemPrompt.js's output contract) and forwards it to the monitor.
 * Returns the reply text with that line removed - like STRIP, it's never
 * spoken aloud. Must run before applyStripDirective, since CPDLC is always
 * the true trailing line (after STRIP, if both are present) - stripping it
 * first leaves a clean remainder for applyStripDirective to parse.
 * Malformed JSON is logged and dropped rather than breaking the reply.
 */
function applyDatalinkDirective(replyText, fromPosition) {
  const match = replyText.match(/\n?CPDLC:\s*([\s\S]*)$/i);
  if (!match) return replyText;

  const spoken = replyText.slice(0, match.index).trim();
  try {
    const directive = JSON.parse(match[1].trim());
    if (!directive.callsign || !VALID_KINDS.includes(directive.kind)) {
      logger.warn(`Dropped CPDLC directive missing callsign or a valid kind: ${match[1]}`);
    } else {
      sendDatalinkMessage({ ...directive, fromPosition });
    }
  } catch (err) {
    logger.warn(`Failed to parse CPDLC directive: ${err.message} - raw: ${match[1]}`);
  }
  return spoken;
}

module.exports = { applyDatalinkDirective, sendDatalinkMessage, sendBroadcastMessage, VALID_KINDS };
