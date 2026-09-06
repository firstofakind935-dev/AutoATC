const fs = require('fs');
const path = require('path');
require('dotenv').config();

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'bots.json');
const EXAMPLE_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'bots.example.json');

const VALID_PROVIDERS = new Set(['anthropic', 'openai']);

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

  return parsed.map((entry, index) => validateEntry(entry, index));
}

function validateEntry(entry, index) {
  const where = `config/bots.json entry #${index + 1} (${entry && entry.name ? entry.name : 'unnamed'})`;

  const required = ['name', 'tokenEnv', 'guildId', 'voiceChannelId', 'persona', 'ai'];
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

  const { persona, ai } = entry;
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
  if (ai.provider === 'openai' && !process.env.OPENAI_API_KEY) {
    throw new Error(`${where} uses ai.provider "openai" but OPENAI_API_KEY is not set.`);
  }

  // Speech-to-text and text-to-speech always go through OpenAI today,
  // regardless of which provider writes the actual ATC response text.
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      `OPENAI_API_KEY is required for all bots because speech-to-text and ` +
        `text-to-speech both call OpenAI, even when ai.provider is "anthropic".`
    );
  }

  return {
    name: entry.name,
    token,
    guildId: String(entry.guildId),
    voiceChannelId: String(entry.voiceChannelId),
    logChannelId: entry.logChannelId ? String(entry.logChannelId) : null,
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
