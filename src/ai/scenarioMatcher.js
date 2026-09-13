const fs = require('fs');
const path = require('path');
const { makeLogger } = require('../utils/logger');

const logger = makeLogger('scenarios');
const SCENARIOS_PATH = path.join(__dirname, '..', '..', 'data', 'scenarios.json');

// Minimum number of keyword hits before a scenario counts as "matched" -
// a single incidental keyword match (e.g. a callsign that happens to
// contain a common word) shouldn't be enough to steer the reply.
const MIN_MATCH_SCORE = 1;

let scenarios = null;

function loadScenarios() {
  if (scenarios !== null) return scenarios;
  try {
    scenarios = JSON.parse(fs.readFileSync(SCENARIOS_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`Failed to load scenario library: ${err.message}`);
    scenarios = [];
  }
  return scenarios;
}

function scenarioAppliesToPosition(scenario, position) {
  const lower = position.toLowerCase();
  return scenario.positions.includes('any') || scenario.positions.some((p) => lower.includes(p));
}

function scoreScenario(transcriptLower, scenario) {
  return scenario.keywords.reduce((score, keyword) => (transcriptLower.includes(keyword.toLowerCase()) ? score + 1 : score), 0);
}

/**
 * Finds the known scenario (from data/scenarios.json) whose keywords best
 * match a pilot transcript, scoped to the given ATC position. Returns null
 * if nothing scores above the minimum threshold - callers should just
 * proceed without a scenario hint in that case, not force a bad match.
 *
 * This is deliberately simple keyword-overlap scoring, not embeddings-based
 * similarity - fast, no extra model/infra needed, and matches on the kind
 * of explicit intent phrases ("request taxi", "cleared to land") real
 * transmissions actually contain.
 */
function findBestScenario(transcript, position) {
  const transcriptLower = transcript.toLowerCase();
  let best = null;
  let bestScore = 0;
  let tied = false;

  for (const scenario of loadScenarios()) {
    if (!scenarioAppliesToPosition(scenario, position)) continue;
    const score = scoreScenario(transcriptLower, scenario);
    if (score > bestScore) {
      bestScore = score;
      best = scenario;
      tied = false;
    } else if (score === bestScore && score > 0) {
      // Two scenarios equally match (e.g. a transmission mentioning both
      // "taxi" and "stand") - picking whichever was checked first would be
      // an arbitrary, potentially wrong steer (observed: a pilot asking to
      // taxi TO a stand got a "taxi to runway" reply instead). Safer to
      // give the model no scenario hint at all than a coin-flip one.
      tied = true;
    }
  }

  if (tied) return null;
  return bestScore >= MIN_MATCH_SCORE ? best : null;
}

/**
 * Formats a matched scenario into context text for the LLM. The template
 * uses {placeholder} slots (callsign, runway, etc.) - the model fills
 * those in from the actual transmission and available context (chart
 * data, flight plans) rather than speaking the placeholder text literally.
 */
function formatScenarioHint(scenario) {
  return (
    `This transmission closely matches a known scenario ("${scenario.situation}"). ` +
    `Use this as the correct response pattern, filling in the actual details ` +
    `(callsign, runway, altitude, etc.) from the current transmission and any ` +
    `context provided - do not speak the placeholder text literally: ` +
    `"${scenario.template}"`
  );
}

module.exports = { findBestScenario, formatScenarioHint };
