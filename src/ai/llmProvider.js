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

  toArray() {
    return [...this.turns];
  }
}

async function generateAtcReply({ provider, apiKey, baseUrl, model, systemPrompt, history }) {
  const impl = PROVIDERS[provider];
  if (!impl) {
    throw new Error(`Unknown AI provider "${provider}". Expected one of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  return impl.generateReply({ apiKey, baseUrl, model, systemPrompt, history });
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

module.exports = { generateAtcReply, apiKeyForProvider, baseUrlForProvider, ConversationHistory };
