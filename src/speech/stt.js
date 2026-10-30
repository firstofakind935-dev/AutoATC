const openaiWhisper = require('./providers/openaiWhisper');

/**
 * Speech-to-text goes through a Whisper-API-compatible endpoint -
 * OpenAI's hosted API by default, or a self-hosted server (e.g. deployed
 * on Railway) when STT_BASE_URL is set. This wrapper exists so a
 * differently-shaped STT backend can be swapped in later without
 * touching callers.
 */
async function transcribeAudio(wavBuffer) {
  return openaiWhisper.transcribe(wavBuffer, {
    apiKey: process.env.STT_API_KEY || process.env.OPENAI_API_KEY,
    baseUrl: process.env.STT_BASE_URL || undefined,
    model: process.env.STT_MODEL || 'whisper-1',
  });
}

/**
 * With a self-hosted STT server, make sure its model is downloaded before anyone calls (a restarted speaches
 * container has none). Safe to call when it's already there. No-op for OpenAI's API.
 */
async function warmUpStt() {
  if (!process.env.STT_BASE_URL) return false;
  await openaiWhisper.ensureModel({
    apiKey: process.env.STT_API_KEY || process.env.OPENAI_API_KEY,
    baseUrl: process.env.STT_BASE_URL,
    model: process.env.STT_MODEL || 'whisper-1',
  });
  return true;
}

module.exports = { transcribeAudio, warmUpStt };
