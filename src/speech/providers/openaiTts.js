const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';

/**
 * Synthesizes speech audio (mp3) for the given text via OpenAI TTS.
 * Returns a Buffer of MP3 audio.
 */
async function synthesize(text, { apiKey, model = 'tts-1', voice = 'alloy' } = {}) {
  const response = await fetch(OPENAI_SPEECH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS failed (${response.status}): ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { synthesize };
