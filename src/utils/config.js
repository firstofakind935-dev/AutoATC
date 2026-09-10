const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'bots.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'bots.example.json');

const VALID_PROVIDERS = new Set(['anthropic', 'openai']);
const VALID_TYPES = new Set(['atc', 'atis']);

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

  return parsed.map((entry, index) => validateEntry(entry, index));
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

  const required = ['name', 'tokenEnv', 'guildId', 'voiceChannelId', 'persona'];
  for (const field of required) {
    if (!entry || entry[field] === undefined || entry[field] === null || entry[field] === '') {
      throw new Error(`${where} is missing required field "${field}".`);
    }
  }

  const token = process.env[entry.tokenEnv];
  if (!token) {
    throw new Error(
      `${where} references env var "${entry.tokenEnv}" for its Discord bot token, ` +
        `but it is not set. Add it to your .env file.`
    );
  }

  const { persona } = entry;

  const base = {
    name: entry.name,
    type,
    token,
    guildId: String(entry.guildId),
    voiceChannelId: String(entry.voiceChannelId),
    logChannelId: entry.logChannelId ? String(entry.logChannelId) : null,
  };

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

  return {
    ...base,
    commandPrefix: entry.commandPrefix || null,
    persona: {
      position: persona.position,
      callsign: persona.callsign,
      airport: persona.airport || null,
      ttsVoice: persona.ttsVoice || 'alloy',
    },
    ai: {
      provider: ai.provider,
      model: ai.model,
    },
  };
}

module.exports = { loadFleetConfig, DEFAULT_CONFIG_PATH, EXAMPLE_CONFIG_PATH };
