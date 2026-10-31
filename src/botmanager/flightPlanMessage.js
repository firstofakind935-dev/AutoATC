// Reads a flight plan out of a Discord message in the flight-plan channel (Bot Manager, FPL_CHANNEL_ID). People write
// them in all sorts of ways, so it takes either labelled lines
//     Callsign: DAL123 / Aircraft: B738 / Departure: Rockford / Arrival: ITKO   (one per line, any order)
// or a single line like "DAL123 B738 IRFD-ITKO". Airport names are resolved to ICAO codes by the monitor.
const LABELS = {
  callsign: ['callsign', 'call sign', 'cs', 'flight', 'flight number', 'flight no'],
  aircraft: ['aircraft', 'aircraft type', 'type', 'acft', 'plane', 'ac'],
  dep: ['departure', 'departing', 'dep', 'from', 'origin', 'departure airport', 'leaving'],
  arr: ['arrival', 'arriving', 'arr', 'to', 'destination', 'dest', 'arrival airport', 'going to'],
  // optional extras, passed on to the AI
  gate: ['gate', 'stand', 'parking', 'gate number', 'stand number'],
  rules: ['flight rules', 'rules', 'flight type'],
  filedRoute: ['route', 'filed route', 'routing'],
  cruise: ['altitude', 'cruise', 'cruising altitude', 'cruise altitude', 'flight level', 'fl'],
};

const clean = (s) => String(s || '').replace(/[*_`~>|]/g, ' ').replace(/<[@#:!&][^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

/** -> {callsign, aircraft, dep, arr} with whatever it found (missing fields are undefined). */
function parseFlightPlanMessage(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n|\s\/\s|;/).map(clean).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^([a-z][a-z .]{0,20}?)\s*[:=\-–]\s*(.+)$/i);
    if (!m) continue;
    const label = m[1].toLowerCase().replace(/\./g, '').trim();
    for (const [field, names] of Object.entries(LABELS)) {
      if (!out[field] && names.includes(label)) out[field] = m[2].trim();
    }
  }
  if (out.callsign && out.aircraft && out.dep && out.arr) return out;

  // one line: "DAL123 B738 IRFD-ITKO", "DAL123, A320, IRFD to ITKO"
  const words = clean(text).toUpperCase().split(/[\s,]+|(?<=[A-Z]{4})-(?=[A-Z]{4})|->|→/).filter(Boolean).filter((w) => !['TO', 'FROM', '-', 'VIA'].includes(w));
  const icaos = words.filter((w) => /^I[A-Z]{3}$/.test(w)); // PTFS airport codes start with I
  if (!out.dep && icaos[0]) out.dep = icaos[0];
  if (!out.arr && icaos[1]) out.arr = icaos[1];
  const rest = words.filter((w) => !icaos.includes(w));
  if (!out.callsign) out.callsign = rest.find((w) => /^[A-Z]{2,3}\d{1,4}[A-Z]?$|^N\d{1,5}[A-Z]{0,2}$/.test(w));
  if (!out.aircraft) out.aircraft = rest.find((w) => w !== out.callsign && /^[A-Z]{1,3}\d{1,3}[A-Z]?$|^[A-Z]{3,5}\d?$/.test(w) && w.length <= 6);
  return out;
}

module.exports = { parseFlightPlanMessage };
