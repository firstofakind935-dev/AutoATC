const openaiTts = require('./providers/openaiTts');

/**
 * Text-to-speech goes through an OpenAI-speech-API-compatible endpoint -
 * OpenAI's hosted API by default, or a self-hosted server (e.g. deployed
 * on Railway) when TTS_BASE_URL is set. Returns an MP3 Buffer.
 */
async function synthesizeSpeech(text, { voice } = {}) {
  return openaiTts.synthesize(text, {
    apiKey: process.env.TTS_API_KEY || process.env.OPENAI_API_KEY,
    baseUrl: process.env.TTS_BASE_URL || undefined,
    model: process.env.TTS_MODEL || 'tts-1',
    voice,
  });
}

module.exports = { synthesizeSpeech };
