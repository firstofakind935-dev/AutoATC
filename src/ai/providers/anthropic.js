const Anthropic = require('@anthropic-ai/sdk');
const { makeLogger } = require('../../utils/logger');

const logger = makeLogger('anthropic-cost');

let client = null;
function getClient(apiKey) {
  if (!client) client = new Anthropic({ apiKey });
  return client;
}

// $ per million tokens, base input/output rates - confirmed current as of
// 2026-09. Check Anthropic's pricing page if these look stale; this is only
// used for the cost-per-call estimate logged below, never sent to the API.
const PRICING_PER_MTOK = {
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};
// Standard Anthropic cache multipliers of the base input rate.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

function estimateCostUsd(model, usage) {
  const pricing = PRICING_PER_MTOK[model];
  if (!pricing || !usage) return null;
  const perInputToken = pricing.input / 1e6;
  const perOutputToken = pricing.output / 1e6;
  return (
    (usage.input_tokens || 0) * perInputToken +
    (usage.output_tokens || 0) * perOutputToken +
    (usage.cache_read_input_tokens || 0) * perInputToken * CACHE_READ_MULTIPLIER +
    (usage.cache_creation_input_tokens || 0) * perInputToken * CACHE_WRITE_MULTIPLIER
  );
}

async function generateReply({ apiKey, model, systemPrompt, history }) {
  const anthropic = getClient(apiKey);
  const response = await anthropic.messages.create({
    model,
    max_tokens: 200,
    // Low temperature: ATC phraseology should be consistent and rule-
    // following, not creative - see openai.js for the observed variance
    // this addresses.
    temperature: 0.2,
    // Cached: the system prompt is identical on every single call for this
    // bot's lifetime (position rules, phraseology examples, redirect
    // templates never change), so marking it cacheable turns repeat calls
    // into ~10% of the input price for this block instead of full price
    // every turn. The per-turn context (chart/frequency/flight-plan data)
    // isn't cached here since it's concatenated into the varying last user
    // message, not a stable prefix.
    system: [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: history.map((turn) => ({ role: turn.role, content: turn.content })),
    // Same safety net as the openai provider: stop before the model can
    // hallucinate a second "Pilot transmission:" turn and answer itself,
    // or ramble into a second paragraph.
    stop_sequences: ['\n\n', 'Pilot transmission:'],
  });

  const cost = estimateCostUsd(model, response.usage);
  if (cost !== null) {
    logger.info(
      `${model}: in=${response.usage.input_tokens} out=${response.usage.output_tokens} ` +
        `cache_read=${response.usage.cache_read_input_tokens || 0} ` +
        `cache_write=${response.usage.cache_creation_input_tokens || 0} ` +
        `~$${cost.toFixed(6)}`
    );
  }

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text.trim() : '';
}

module.exports = { generateReply };
