// Kokoro on speaches doesn't know OpenAI voice names: they're translated, and a lost model is re-downloaded.
const test = require('node:test');
const assert = require('node:assert');
const { synthesize, voiceFor } = require('../src/speech/providers/openaiTts');

test('OpenAI voice names become Kokoro voices only for a Kokoro model', () => {
  assert.strictEqual(voiceFor('speaches-ai/Kokoro-82M-v1.0-ONNX', 'onyx'), 'am_onyx');
  assert.strictEqual(voiceFor('speaches-ai/Kokoro-82M-v1.0-ONNX', 'shimmer'), 'af_sky');
  assert.strictEqual(voiceFor('speaches-ai/Kokoro-82M-v1.0-ONNX', 'af_heart'), 'af_heart');
  assert.strictEqual(voiceFor('gpt-4o-mini-tts', 'onyx'), 'onyx');
});

test('the request carries the Kokoro voice; a missing model is downloaded and retried', async () => {
  let installed = false;
  const sent = [];
  const fetchImpl = async (url, opts) => {
    if (url.endsWith('/v1/models/speaches-ai/Kokoro-82M-v1.0-ONNX')) { installed = true; return { ok: true, status: 201 }; }
    sent.push(JSON.parse(opts.body).voice);
    if (!installed) return { ok: false, status: 404, text: async () => '{"detail":"Model is not installed locally."}' };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const mp3 = await synthesize('Delta 123, cleared for takeoff', { baseUrl: 'http://speaches', model: 'speaches-ai/Kokoro-82M-v1.0-ONNX', voice: 'onyx', fetchImpl });
  assert.strictEqual(mp3.length, 3);
  assert.deepStrictEqual(sent, ['am_onyx', 'am_onyx']);
});
