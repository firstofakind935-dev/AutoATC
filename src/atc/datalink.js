const { makeLogger } = require('../utils/logger');

const logger = makeLogger('datalink');

const MONITOR_URL = process.env.MONITOR_URL || null;
const MONITOR_API_KEY = process.env.MONITOR_API_KEY || null;

const VALID_KINDS = ['contact', 'pdc', 'text'];

/**
 * Fire-and-forget push to the monitor's /api/cpdlc, which the pilot's
 * companion app polls and shows in its overlay. Must never throw or block
 * the caller - same contract as logger.js's sendToMonitor, since a monitor
 * outage should never affect the bot's own voice reply.
 */
function sendDatalinkMessage({ callsign, kind, fromPosition, facility, frequency, clearance, text }) {
  if (!MONITOR_URL) return;
  const headers = { 'Content-Type': 'application/json' };
  if (MONITOR_API_KEY) headers.Authorization = `Bearer ${MONITOR_API_KEY}`;

  fetch(`${MONITOR_URL.replace(/\/+$/, '')}/api/cpdlc`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ callsign, kind, fromPosition, facility, frequency, clearance, text }),
  }).catch((err) => logger.warn(`Failed to send CPDLC/PDC message for ${callsign}: ${err.message}`));
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

module.exports = { applyDatalinkDirective };
