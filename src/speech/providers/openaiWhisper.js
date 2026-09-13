const DEFAULT_BASE_URL = 'https://api.openai.com';

/**
 * Sends a WAV buffer to a Whisper-compatible transcription endpoint.
 * Defaults to OpenAI's hosted API, but baseUrl can point at any
 * self-hosted server that implements the same /v1/audio/transcriptions
 * contract (multipart file upload, JSON { text } response) - many
 * self-hostable Whisper servers are built to be drop-in compatible.
 * Returns the transcript text, or an empty string if nothing was said.
 */
// Whisper has no way to know this is aviation radio traffic unless told -
// without it, airline ICAO codes and phraseology get transcribed as the
// nearest everyday English word/name they sound like (observed: "KLM"
// heard as "Caleb"). Whisper's prompt doesn't enforce output, it just
// biases decoding toward this vocabulary/style, so it helps without
// constraining what can actually be transcribed.
const AVIATION_PROMPT =
  'Air traffic control radio transmission. Aircraft callsigns are often ' +
  'ICAO airline codes (KLM, UAL, DAL, AAL, BAW, DLH, AFR, ANA, JAL) ' +
  'followed by a flight number, or general aviation tail numbers spoken ' +
  'phonetically (e.g. "Cessna 42 Yankee" for N42Y). Standard ICAO ' +
  'phraseology: taxi, pushback, cleared for takeoff, cleared to land, ' +
  'runway, hold short, roger, wilco, squawk, contact.';

async function transcribe(wavBuffer, { apiKey, baseUrl = DEFAULT_BASE_URL, model = 'whisper-1', language } = {}) {
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', model);
  form.append('prompt', AVIATION_PROMPT);
  if (language) form.append('language', language);

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Transcription request to ${baseUrl} failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}

module.exports = { transcribe, DEFAULT_BASE_URL };
