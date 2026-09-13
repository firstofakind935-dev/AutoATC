// Polls the monitor's /api/cpdlc for one callsign - the pilot-facing half of
// the ATC bot fleet's text datalink (see src/atc/datalink.js on the bot
// side). `sinceId` lets the caller ask for only messages newer than the
// last one it already saw, so a message isn't shown twice across polls.

async function pollCpdlc({ monitorUrl, apiKey, callsign, sinceId }) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const query = `callsign=${encodeURIComponent(callsign)}&since=${encodeURIComponent(sinceId || 0)}`;
  const response = await fetch(`${monitorUrl.replace(/\/+$/, '')}/api/cpdlc?${query}`, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`CPDLC poll to ${monitorUrl} failed (${response.status}): ${text}`);
  }
  return response.json();
}

module.exports = { pollCpdlc };
