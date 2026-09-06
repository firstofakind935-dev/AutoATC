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

module.exports = { transcribeAudio };
