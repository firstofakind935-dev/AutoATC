const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

/**
 * Sends a WAV buffer to OpenAI's Whisper transcription endpoint.
 * Returns the transcript text, or an empty string if nothing was said.
 */
async function transcribe(wavBuffer, { apiKey, model = 'whisper-1', language } = {}) {
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', model);
  if (language) form.append('language', language);

  const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`OpenAI transcription failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.text || '').trim();
}

module.exports = { transcribe };
