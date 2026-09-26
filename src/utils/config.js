const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { makeLogger } = require('./logger');

const logger = makeLogger('fleet-config');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'bots.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'bots.example.json');

const VALID_PROVIDERS = new Set(['anthropic', 'openai']);
const VALID_TYPES = new Set(['atc', 'atis', 'botmanager']);

function loadFleetConfig(configPath = DEFAULT_CONFIG_PATH) {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No fleet config found at ${configPath}. Copy config/bots.example.json to ` +
        `config/bots.json and fill in your guild/channel/token details.\n` +
        `Example file: ${EXAMPLE_CONFIG_PATH}`
    );
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${err.message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${configPath} must contain a non-empty JSON array of bot configs.`);
  }

  validateSpeechConfig();

  const configs = [];
  parsed.forEach((entry, index) => {
    const where = `config/bots.json entry #${index + 1} (${entry && entry.name ? entry.name : 'unnamed'})`;
    if (!entry || !entry.tokenEnv) {
      throw new Error(`${where} is missing required field "tokenEnv".`);
    }
    if (!process.env[entry.tokenEnv]) {
      // Not every position needs to be running at once - list every
      // position the fleet might use in bots.json, and only the ones
      // whose token env var is actually set in .env come online. Skip
      // rather than crash the whole fleet over one unconfigured bot.
      logger.warn(`Skipping ${where}: env var "${entry.tokenEnv}" is not set.`);
      return;
    }
    try {
      configs.push(validateEntry(entry, index));
    } catch (err) {
      // A token being set doesn't mean the rest of the entry is actually
      // ready yet - e.g. mid-rollout, a Discord application was created
      // and its token added before config/bots.json's voiceChannelId was
      // filled in (scripts/create-voice-channels.js) for it. Same spirit
      // as the missing-token skip above: one not-yet-finished bot
      // shouldn't take the rest of an already-working fleet down with it.
      logger.warn(`Skipping ${where}: ${err.message}`);
    }
  });

  return configs;
}

function validateSpeechConfig() {
  // STT/TTS default to OpenAI's hosted API and need OPENAI_API_KEY (or the
  // more specific STT_API_KEY/TTS_API_KEY) unless a self-hosted server is
  // configured via STT_BASE_URL/TTS_BASE_URL, which may not require a key.
  const usingDefaultStt = !process.env.STT_BASE_URL;
  const usingDefaultTts = !process.env.TTS_BASE_URL;

  if (usingDefaultStt && !process.env.STT_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error(
      `No STT_BASE_URL is set, so speech-to-text will use OpenAI's hosted Whisper API, ` +
        `which requires OPENAI_API_KEY (or STT_API_KEY) to be set.`
    );
  }
  if (usingDefaultTts && !process.env.TTS_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error(
      `No TTS_BASE_URL is set, so text-to-speech will use OpenAI's hosted TTS API, ` +
        `which requires OPENAI_API_KEY (or TTS_API_KEY) to be set.`
    );
  }
}

function validateEntry(entry, index) {
  const where = `config/bots.json entry #${index + 1} (${entry && entry.name ? entry.name : 'unnamed'})`;
  const type = entry && entry.type ? entry.type : 'atc';
  if (!VALID_TYPES.has(type)) {
    throw new Error(`${where}.type must be one of: ${[...VALID_TYPES].join(', ')}`);
  }

  // Bot Manager isn't an ATC voice position - it never joins a channel of
  // its own (only moves other members between the fleet's channels, and
  // occasionally stands in as Center - see src/bot/BotManagerBot.js), so it
  // doesn't need voiceChannelId/persona the way every other type does.
  const required = type === 'botmanager' ? ['name', 'tokenEnv', 'guildId'] : ['name', 'tokenEnv', 'guildId', 'voiceChannelId', 'persona'];
  for (const field of required) {
    if (!entry || entry[field] === undefined || entry[field] === null || entry[field] === '') {
      throw new Error(`${where} is missing required field "${field}".`);
    }
  }

  // Presence of the token itself was already checked by loadFleetConfig
  // (which skips - rather than fails - an entry with no token configured).
  const token = process.env[entry.tokenEnv];

  const { persona } = entry;

  const base = {
    name: entry.name,
    type,
    token,
    guildId: String(entry.guildId),
    voiceChannelId: entry.voiceChannelId ? String(entry.voiceChannelId) : null,
    logChannelId: entry.logChannelId ? String(entry.logChannelId) : null,
  };

  if (type === 'botmanager') {
    return {
      ...base,
      flightPlansChannelId: entry.flightPlansChannelId ? String(entry.flightPlansChannelId) : null,
    };
  }

  if (type === 'atis') {
    // No LLM/STT involved at all - this bot only broadcasts, it never
    // listens, so it needs none of the "ai" config or a position/callsign
    // to roleplay - just the airport to look up the right ATIS entry for.
    if (!persona.airport) {
      throw new Error(`${where}.persona.airport is required for an "atis" bot (used to match the right ATIS entry).`);
    }
    return {
      ...base,
      persona: {
        airport: persona.airport,
        callsign: persona.callsign || `${persona.airport} ATIS`,
        ttsVoice: persona.ttsVoice || 'alloy',
      },
    };
  }

  const { ai } = entry;
  if (!ai) {
    throw new Error(`${where} is missing required field "ai".`);
  }
  if (!persona.position || !persona.callsign) {
    throw new Error(`${where}.persona must include at least "position" and "callsign".`);
  }
  if (!VALID_PROVIDERS.has(ai.provider)) {
    throw new Error(`${where}.ai.provider must be one of: ${[...VALID_PROVIDERS].join(', ')}`);
  }
  if (!ai.model) {
    throw new Error(`${where}.ai.model is required.`);
  }
  if (ai.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(`${where} uses ai.provider "anthropic" but ANTHROPIC_API_KEY is not set.`);
  }
  if (ai.provider === 'openai' && !process.env.OPENAI_BASE_URL && !process.env.OPENAI_API_KEY) {
    throw new Error(
      `${where} uses ai.provider "openai" with no OPENAI_BASE_URL set, so it will call ` +
        `OpenAI's hosted API, which requires OPENAI_API_KEY to be set. If you meant to use ` +
        `a self-hosted LLM server, set OPENAI_BASE_URL to its URL.`
    );
  }

  const fallback = validateFallback(ai.fallback, where);

  return {
    ...base,
    persona: {
      position: persona.position,
      callsign: persona.callsign,
      airport: persona.airport || null,
      ttsVoice: persona.ttsVoice || 'alloy',
    },
    ai: {
      provider: ai.provider,
      model: ai.model,
      fallback,
    },
  };
}

/**
 * Optional ai.fallback: { provider, model } - used when the primary
 * provider/model call fails (e.g. an Anthropic key runs out of credits),
 * so the bot switches to a backup (typically a self-hosted Ollama model)
 * instead of going silent. Same validation as the primary ai block.
 */
function validateFallback(fallback, where) {
  if (!fallback) return null;

  if (!VALID_PROVIDERS.has(fallback.provider)) {
    throw new Error(`${where}.ai.fallback.provider must be one of: ${[...VALID_PROVIDERS].join(', ')}`);
  }
  if (!fallback.model) {
    throw new Error(`${where}.ai.fallback.model is required when ai.fallback is set.`);
  }
  if (fallback.provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(`${where}.ai.fallback uses provider "anthropic" but ANTHROPIC_API_KEY is not set.`);
  }
  if (fallback.provider === 'openai' && !process.env.OPENAI_BASE_URL && !process.env.OPENAI_API_KEY) {
    throw new Error(
      `${where}.ai.fallback uses provider "openai" with no OPENAI_BASE_URL set, so it will call ` +
        `OpenAI's hosted API, which requires OPENAI_API_KEY to be set. If you meant to use ` +
        `a self-hosted LLM server, set OPENAI_BASE_URL to its URL.`
    );
  }

  return { provider: fallback.provider, model: fallback.model };
}

module.exports = { loadFleetConfig, DEFAULT_CONFIG_PATH, EXAMPLE_CONFIG_PATH };
