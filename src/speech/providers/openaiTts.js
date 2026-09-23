const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * Synthesizes speech audio (mp3) for the given text via a TTS endpoint.
 * Defaults to OpenAI's hosted API and gpt-4o-mini-tts - noticeably more
 * natural-sounding than the older tts-1 it replaces, on the same /v1/audio/
 * speech endpoint and request shape (no code change needed to swap either
 * way, just the "model" value). baseUrl can point at any self-hosted
 * server that implements that same contract (JSON { model, voice, input }
 * -> audio bytes) - several self-hostable TTS servers are built to be
 * drop-in compatible, though at that point you'd typically set TTS_MODEL
 * back to whichever model name that server actually expects.
 * Returns a Buffer of MP3 audio.
 */
async function synthesize(text, { apiKey, baseUrl = DEFAULT_BASE_URL, model = 'gpt-4o-mini-tts', voice = 'alloy' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      voice,
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`TTS request to ${baseUrl} failed (${response.status}): ${body}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { synthesize, DEFAULT_BASE_URL };
