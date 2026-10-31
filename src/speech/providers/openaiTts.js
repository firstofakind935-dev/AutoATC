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
// Stations are configured with OpenAI voice names. Kokoro (e.g. speaches' speaches-ai/Kokoro-82M-v1.0-ONNX) rejects
// those with a 422, so use its nearest voice of the same name - it ships af_alloy, am_echo, bm_fable, am_onyx, af_nova.
const KOKORO_VOICES = { alloy: 'af_alloy', echo: 'am_echo', fable: 'bm_fable', onyx: 'am_onyx', nova: 'af_nova', shimmer: 'af_sky' };

function voiceFor(model, voice) {
  if (process.env.TTS_VOICE) return process.env.TTS_VOICE; // one voice for every station
  if (/kokoro/i.test(model || '')) return KOKORO_VOICES[voice] || voice;
  return voice;
}

async function synthesize(text, opts = {}) {
  try {
    return await synthesizeOnce(text, opts);
  } catch (e) {
    // a restarted speaches server forgets its models; have it download this one and try again
    if (!e.missingModel || !opts.baseUrl) throw e;
    const headers = opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {};
    const r = await (opts.fetchImpl || fetch)(`${opts.baseUrl.replace(/\/+$/, '')}/v1/models/${opts.model}`, { method: 'POST', headers });
    if (!r.ok && r.status !== 409) throw e;
    return synthesizeOnce(text, opts);
  }
}

async function synthesizeOnce(text, { apiKey, baseUrl = DEFAULT_BASE_URL, model = 'gpt-4o-mini-tts', voice = 'alloy', fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      voice: voiceFor(model, voice),
      input: text,
      response_format: 'mp3',
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`TTS request to ${baseUrl} failed (${response.status}): ${body}`);
    err.missingModel = response.status === 404 && /not installed locally/i.test(body);
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { synthesize, voiceFor, DEFAULT_BASE_URL };
