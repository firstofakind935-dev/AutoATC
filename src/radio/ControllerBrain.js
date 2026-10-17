// One ATC position's "brain" without Discord: a pilot's words in, the controller's reply out. The same prompt,
// context (charts, oceanic tracks, frequencies, flight plans, strips, live positions, scenario hints) and model calls
// as the Discord bots (src/bot/AtcBot.js) - used by the in-app radio (src/radio/radioWorker.js).

const { generateAtcReplyWithFallback, ConversationHistory } = require('../ai/llmProvider');
const { buildAtcSystemPrompt } = require('../ai/systemPrompt');
const { findBestScenario, formatScenarioHint } = require('../ai/scenarioMatcher');
const { getFlightPlanContext } = require('../flightplans/store');
const { getChartContext } = require('../charts/store');
const { getOceanicTracksContext } = require('../charts/oceanicTracks');
const { getFrequencyContext } = require('../charts/frequencies');
const { formatStripsContext } = require('../atc/flightStrips');
const { getPositionsContext } = require('../atc/positions');

let shared = null; // fleet-wide static context, loaded once
function sharedContext() {
  if (!shared) shared = { oceanic: getOceanicTracksContext(), frequencies: getFrequencyContext() };
  return shared;
}

class ControllerBrain {
  /** persona: {position, callsign, airport, ttsVoice}; ai: {provider, model, fallback} */
  constructor({ persona, ai, logger }) {
    this.persona = persona;
    this.ai = ai;
    this.logger = logger;
    this.systemPrompt = buildAtcSystemPrompt(persona);
    this.chartContext = persona.airport ? getChartContext(persona.airport) : null;
    this.history = new ConversationHistory();
  }

  /**
   * Something said on the frequency while a human controller had it: kept in this position's conversation, so the AI
   * knows the traffic situation when the frequency is handed back. Nothing is generated.
   */
  observe(text, { speaker }) {
    if (speaker === 'controller') this.history.addAtcReply(text);
    else this.history.addPilotTransmission(text);
  }

  /**
   * The controller's reply to one transmission, or '' when none is needed (the model says NO_RESPONSE_NEEDED, or
   * generation failed - logged). `from` is the callsign the pilot's app reports, given to the model as context.
   */
  async respond(transcript, { from } = {}) {
    const { oceanic, frequencies } = sharedContext();
    this.history.addPilotTransmission(transcript);
    const scenario = findBestScenario(transcript, this.persona.position);
    const turnContext = [
      this.chartContext,
      oceanic,
      frequencies,
      await getFlightPlanContext(),
      formatStripsContext(this.persona.position),
      await getPositionsContext(),
      scenario ? formatScenarioHint(scenario) : null,
      from ? `The transmitting aircraft's radio identifies it as "${from}" (the pilot's own callsign as set in their app).` : null,
    ].filter(Boolean).join('\n\n') || undefined;

    let reply;
    try {
      reply = await generateAtcReplyWithFallback({
        provider: this.ai.provider,
        model: this.ai.model,
        fallback: this.ai.fallback,
        systemPrompt: this.systemPrompt,
        history: this.history.toArray({ contextForLastTurn: turnContext }),
        position: this.persona.position,
        airport: this.persona.airport,
      }, this.logger);
    } catch (err) {
      const cause = err.cause ? ` (cause: ${err.cause.code || err.cause.message || err.cause})` : '';
      this.logger.error(`LLM generation failed: ${err.message}${cause}`);
      return '';
    }
    if (reply) this.history.addAtcReply(reply);
    return reply || '';
  }
}

module.exports = { ControllerBrain };
