const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * Synthesizes speech audio (mp3) for the given text via a TTS endpoint.
 * Defaults to OpenAI's hosted API, but baseUrl can point at any
 * self-hosted server that implements the same /v1/audio/speech contract
 * (JSON { model, voice, input } -> audio bytes) - several self-hostable
 * TTS servers are built to be drop-in compatible.
 * Returns a Buffer of MP3 audio.
 */
async function synthesize(text, { apiKey, baseUrl = DEFAULT_BASE_URL, model = 'tts-1', voice = 'alloy' } = {}) {
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
