const openaiTts = require('./providers/openaiTts');

/**
 * Text-to-speech is always OpenAI today, independent of which LLM provider
 * writes the response text. Returns an MP3 Buffer.
 */
async function synthesizeSpeech(text, { voice } = {}) {
  return openaiTts.synthesize(text, {
    apiKey: process.env.OPENAI_API_KEY,
    voice,
  });
}

module.exports = { synthesizeSpeech };
