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

// Position anchors from ATC (stand / runway line-up / taxi route), see monitor/server.js's /api/anchors.
async function pollAnchors({ monitorUrl, apiKey, callsign, sinceId }) {
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const query = `callsign=${encodeURIComponent(callsign)}&since=${encodeURIComponent(sinceId || 0)}`;
  const response = await fetch(`${monitorUrl.replace(/\/+$/, '')}/api/anchors?${query}`, { headers });
  if (response.status === 404) return []; // an older monitor without anchors
  if (!response.ok) throw new Error(`Anchor poll failed (${response.status})`);
  return response.json();
}

module.exports = { pollCpdlc, pollAnchors };
