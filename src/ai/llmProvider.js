const anthropicProvider = require('./providers/anthropic');
const openaiProvider = require('./providers/openai');

const PROVIDERS = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

const MAX_HISTORY_TURNS = 12; // 6 pilot/ATC exchanges of context

/**
 * Keeps a short rolling transcript of pilot transmissions and ATC replies
 * for one voice channel, so responses stay consistent within a session.
 */
class ConversationHistory {
  constructor() {
    this.turns = [];
  }

  addPilotTransmission(text) {
    this.turns.push({ role: 'user', content: text });
    this._trim();
  }

  addAtcReply(text) {
    this.turns.push({ role: 'assistant', content: text });
    this._trim();
  }

  _trim() {
    if (this.turns.length > MAX_HISTORY_TURNS) {
      this.turns = this.turns.slice(this.turns.length - MAX_HISTORY_TURNS);
    }
  }

  /**
   * Returns the turns for an API call. When contextForLastTurn is given,
   * it's prepended to the most recent pilot transmission for this request
   * only - stored history stays as the plain transcript, so context (e.g.
   * a currently-filed-flight-plans list) doesn't pollute earlier turns or
   * get repeated back at the model on every subsequent request.
   */
  toArray({ contextForLastTurn } = {}) {
    const turns = [...this.turns];
    if (contextForLastTurn) {
      const lastIndex = turns.length - 1;
      if (lastIndex >= 0 && turns[lastIndex].role === 'user') {
        turns[lastIndex] = {
          role: 'user',
          content: `${contextForLastTurn}\n\nPilot transmission: ${turns[lastIndex].content}`,
        };
      }
    }
    return turns;
  }
}

/**
 * Reasoning models (e.g. Qwen3) can emit a <think>...</think> block before
 * the actual reply even when reasoning_effort/think=false is requested -
 * confirmed unreliable across models/versions during testing. This is a
 * safety net independent of that setting: strip complete <think> blocks,
 * and if an unclosed <think> tag remains (the response got cut off
 * mid-thought, e.g. by max_tokens, before ever reaching a real answer),
 * drop everything from that point on rather than speaking a truncated
 * internal monologue aloud over voice chat.
 */
function stripThinkingBlocks(text) {
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const unclosedIndex = cleaned.search(/<think>/i);
  if (unclosedIndex !== -1) {
    cleaned = cleaned.slice(0, unclosedIndex);
  }
  return cleaned.trim();
}

// Matches the instruction in systemPrompt.js for a correct readback of an
// instruction already given - a real controller stays silent rather than
// re-transmitting it, which otherwise gets read back again and loops.
const NO_RESPONSE_SENTINEL = 'NO_RESPONSE_NEEDED';

async function generateAtcReply({ provider, apiKey, baseUrl, model, systemPrompt, history }) {
  const impl = PROVIDERS[provider];
  if (!impl) {
    throw new Error(`Unknown AI provider "${provider}". Expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const reply = await impl.generateReply({ apiKey, baseUrl, model, systemPrompt, history });
  const cleaned = stripThinkingBlocks(reply);
  return cleaned.toUpperCase().includes(NO_RESPONSE_SENTINEL) ? '' : cleaned;
}

/**
 * Same as generateAtcReply, but if the primary provider/model fails for any
 * reason (out of API credits, invalid key, provider outage, network error)
 * and a fallback provider/model is configured, retries once against the
 * fallback instead of leaving the bot silent for that transmission - e.g.
 * falling back from a paid Anthropic model to a self-hosted Ollama model
 * once the API key's balance runs out.
 */
async function generateAtcReplyWithFallback({ provider, model, fallback, systemPrompt, history }, logger) {
  try {
    return await generateAtcReply({
      provider,
      apiKey: apiKeyForProvider(provider),
      baseUrl: baseUrlForProvider(provider),
      model,
      systemPrompt,
      history,
    });
  } catch (err) {
    if (!fallback) throw err;
    logger?.warn(
      `Primary AI provider (${provider}/${model}) failed, falling back to ` +
        `${fallback.provider}/${fallback.model}: ${err.message}`
    );
    return generateAtcReply({
      provider: fallback.provider,
      apiKey: apiKeyForProvider(fallback.provider),
      baseUrl: baseUrlForProvider(fallback.provider),
      model: fallback.model,
      systemPrompt,
      history,
    });
  }
}

function apiKeyForProvider(provider) {
  if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
  if (provider === 'openai') return process.env.OPENAI_API_KEY;
  throw new Error(`Unknown AI provider "${provider}"`);
}

/**
 * Only meaningful for the "openai" provider today - lets it target a
 * self-hosted, OpenAI-API-compatible LLM server (e.g. Ollama, llama.cpp)
 * instead of OpenAI's hosted API. Anthropic's Claude API isn't reachable
 * through a self-hosted drop-in the same way, so this is undefined there.
 */
function baseUrlForProvider(provider) {
  if (provider === 'openai') return process.env.OPENAI_BASE_URL || undefined;
  return undefined;
}

module.exports = { generateAtcReply, generateAtcReplyWithFallback, apiKeyForProvider, baseUrlForProvider, ConversationHistory };
