const openaiWhisper = require('./providers/openaiWhisper');

/**
 * Speech-to-text is always OpenAI Whisper today, independent of which LLM
 * provider is chosen for generating ATC responses. This wrapper exists so
 * a different STT backend can be swapped in later without touching callers.
 */
async function transcribeAudio(wavBuffer) {
  return openaiWhisper.transcribe(wavBuffer, {
    apiKey: process.env.OPENAI_API_KEY,
  });
}

module.exports = { transcribeAudio };
