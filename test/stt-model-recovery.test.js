// A restarted speaches server has lost its model: the fleet asks it to download the model and retries.
const test = require('node:test');
const assert = require('node:assert');
const { transcribe, ensureModel } = require('../src/speech/providers/openaiWhisper');

test('missing model: download it, then the transcription goes through', async () => {
  let installed = false;
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(`${opts.method} ${url}`);
    if (url.endsWith('/v1/models/Systran/faster-whisper-large-v3')) { installed = true; return { ok: true, status: 201, text: async () => '' }; }
    if (!installed) return { ok: false, status: 404, text: async () => '{"detail":"Model \'Systran/faster-whisper-large-v3\' is not installed locally."}' };
    return { ok: true, status: 200, json: async () => ({ text: ' Rockford Tower, DAL123 ' }) };
  };
  const text = await transcribe(Buffer.alloc(10), { baseUrl: 'http://speaches/', model: 'Systran/faster-whisper-large-v3', fetchImpl });
  assert.strictEqual(text, 'Rockford Tower, DAL123');
  assert.deepStrictEqual(calls, [
    'POST http://speaches/v1/audio/transcriptions',
    'POST http://speaches/v1/models/Systran/faster-whisper-large-v3',
    'POST http://speaches/v1/audio/transcriptions',
  ]);
});

test('other errors are not retried; concurrent callers share one download', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  await assert.rejects(transcribe(Buffer.alloc(1), { baseUrl: 'http://s', model: 'm', fetchImpl }), /500/);
  let downloads = 0;
  const slow = async () => { downloads++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, status: 200 }; };
  await Promise.all([ensureModel({ baseUrl: 'http://s', model: 'm', fetchImpl: slow }), ensureModel({ baseUrl: 'http://s', model: 'm', fetchImpl: slow })]);
  assert.strictEqual(downloads, 1);
});
