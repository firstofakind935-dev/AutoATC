// Posts one position report to the monitor service's /api/position (see
// monitor/server.js). Matches the shape src/atc/positions.js expects on the
// bot side, so that module can render it without guessing at fields.

async function uploadPosition({
  monitorUrl,
  apiKey,
  callsign,
  aircraftType,
  speed,
  distanceNm,
  bearingDeg,
  referenceAirport,
  altitudeFt,
  headingDeg,
  fixAgeSec,
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const body = {
    callsign,
    aircraftType: aircraftType || null,
    speed: typeof speed === 'number' ? speed : null,
    position: {
      distanceNm: Math.round(distanceNm * 10) / 10,
      bearingDeg: Math.round(bearingDeg),
      referenceAirport,
      // altitudeFt/headingDeg come straight off the HUD each frame, so
      // they're as fresh as the report itself - only the distance/bearing
      // is a dead-reckoning estimate that grows less certain with fixAgeSec
      // (seconds since the last minimap correction click).
      altitudeFt: typeof altitudeFt === 'number' ? Math.round(altitudeFt) : null,
      headingDeg: typeof headingDeg === 'number' ? Math.round(headingDeg) : null,
      fixAgeSec: typeof fixAgeSec === 'number' ? Math.round(fixAgeSec) : null,
    },
  };

  const response = await fetch(`${monitorUrl.replace(/\/+$/, '')}/api/position`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Position upload to ${monitorUrl} failed (${response.status}): ${text}`);
  }
}

module.exports = { uploadPosition };
