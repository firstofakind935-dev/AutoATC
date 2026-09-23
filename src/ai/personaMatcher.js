const fs = require('fs');
const path = require('path');

const BOTS_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'bots.json');

let allPersonasCache = null;

/**
 * Every ATC-position persona in the fleet roster (position/callsign/
 * airport/ttsVoice), regardless of whether that bot's own token is
 * currently set - this is the full "menu" a dynamic-persona test bot can
 * pick from, not just whichever bots happen to be online. Loaded once from
 * config/bots.json (the same file loadFleetConfig() reads), independent of
 * which single bot process is actually running this code.
 */
function loadAllPersonas() {
  if (allPersonasCache !== null) return allPersonasCache;

  let entries = [];
  try {
    entries = JSON.parse(fs.readFileSync(BOTS_CONFIG_PATH, 'utf8'));
  } catch (err) {
    allPersonasCache = [];
    return allPersonasCache;
  }

  allPersonasCache = entries
    .filter((e) => (e.type || 'atc') === 'atc' && e.persona && e.persona.callsign)
    .map((e) => ({
      position: e.persona.position,
      callsign: e.persona.callsign,
      airport: e.persona.airport || null,
      ttsVoice: e.persona.ttsVoice || 'alloy',
    }))
    // Longest callsign first, so a specific match ("Rockford Approach")
    // is tried before anything that could be a looser substring of it.
    .sort((a, b) => b.callsign.length - a.callsign.length);

  return allPersonasCache;
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * TEST-ONLY helper (see AtcBot's TEST_DYNAMIC_PERSONA flag): figures out
 * which real ATC position a pilot transmission is addressed to, so one
 * running bot can role-play any position in the fleet by voice alone,
 * instead of needing all ~60 positions deployed with real Discord tokens
 * to manually test each one.
 *
 * Real pilots lead a transmission with who they're calling, e.g. "Rockford
 * Ground, Cessna 42Yankee, ..." or "Izolirani Tower, N42Y, ...". Every
 * fleet callsign already bakes in its airport/carrier name (there's no
 * bare "Ground"/"Tower" callsign anywhere in config/bots.json), so a
 * substring match against the start of the transcript is enough to
 * disambiguate without needing separate airport context.
 *
 * Returns the matched persona, or null if nothing in the transcript's
 * opening matches a known callsign - callers should keep using whatever
 * persona was last active (mirrors staying on a dialed-in frequency)
 * rather than reset to some default.
 */
function resolvePersonaFromTranscript(transcript, personas = loadAllPersonas()) {
  if (!transcript) return null;
  // Only look at the leading portion - matching a callsign mentioned later
  // (e.g. "tell Rockford Tower I'll be ten minutes") would misfire.
  const lead = normalize(transcript.slice(0, 60));

  for (const persona of personas) {
    if (lead.includes(normalize(persona.callsign))) return persona;
  }
  return null;
}

module.exports = { resolvePersonaFromTranscript, loadAllPersonas };
