// The controller side of the in-app radio. Connects to the monitor's radio hub (monitor/radio.js) and answers on
// EVERY station in data/frequencies.json - no Discord accounts involved, so no 50-bots-per-server limit. A pilot's
// finished transmission arrives as 16 kHz mono PCM; it is transcribed, answered by that station's brain
// (ControllerBrain - same prompts and models as the Discord bots), spoken, and the audio sent back for everyone on
// the frequency. Stations answer one transmission at a time each, in order.

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { ControllerBrain } = require('./ControllerBrain');
const { pcmToWav } = require('../utils/audio');
const { transcribeAudio } = require('../speech/stt');
const { synthesizeSpeech } = require('../speech/tts');
const { makeLogger } = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const SAMPLE_RATE = 16000;
const MIN_TRANSCRIPT_LENGTH = 2;
const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];

// Station code suffix -> position name the prompts understand.
function positionFor(station) {
  const s = station.toUpperCase();
  if (/\bTWR\b/.test(s)) return 'Tower';
  if (/\bGND\b/.test(s)) return 'Ground';
  if (/\bDEL\b/.test(s)) return 'Delivery';
  if (/\bAPP\b/.test(s)) return 'Approach';
  if (/\bDEP\b/.test(s)) return 'Departure';
  if (/\bAPRON\b/.test(s)) return 'Apron';
  if (/\bOCC\b/.test(s) && /\s/.test(s)) return 'Oceanic'; // "Shanwick OCC"
  return 'Center'; // IRCC, IOCC, ICCC, EGCC, IRTC...
}

/**
 * Every station on the frequency list, with its persona: from config/bots.json where a Discord bot exists for it
 * (same callsign, voice and model), else made up from the list (position from the station code).
 * -> [{freq, station, persona, ai}]
 */
function loadStations({ frequencies = null, bots = null } = {}) {
  frequencies = frequencies || JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'frequencies.json'), 'utf8'));
  bots = bots || JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'bots.json'), 'utf8'));
  const voiceBots = bots.filter((b) => b.type !== 'botmanager' && b.persona);
  const defaultAi = (voiceBots.find((b) => b.ai) || {}).ai || { provider: 'anthropic', model: 'claude-haiku-4-5' };
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return frequencies.map((f, i) => {
    const bot = voiceBots.find((b) => b.station && key(b.station) === key(f.station))
      || voiceBots.find((b) => key(b.persona.callsign) === key(f.callsign) && !voiceBots.some((o) => o !== b && key(o.persona.callsign) === key(f.callsign)));
    const airport = (f.station.match(/^[A-Z]{3,4}\b/) || [])[0];
    const persona = bot ? { ...bot.persona } : {
      position: positionFor(f.station),
      callsign: f.callsign.trim(),
      airport: /\s/.test(f.station) && !/OCC$/i.test(f.station) ? airport : undefined,
      ttsVoice: VOICES[i % VOICES.length],
    };
    return { freq: Number(f.frequency).toFixed(3), station: f.station.trim(), persona, ai: (bot && bot.ai) || defaultAi };
  });
}

function startRadioWorker({ monitorUrl = process.env.MONITOR_URL, apiKey = process.env.MONITOR_API_KEY, stations = null } = {}) {
  const logger = makeLogger('radio');
  if (!monitorUrl) { logger.warn('MONITOR_URL is not set - the in-app radio has no hub to connect to.'); return null; }
  const list = stations || loadStations();
  // two stations sharing a frequency (the sheet has a few) would answer over each other: the first one keeps it
  const byFreq = new Map();
  for (const s of list) {
    if (byFreq.has(s.freq)) { logger.warn(`${s.station} shares ${s.freq} with ${byFreq.get(s.freq).station} - only ${byFreq.get(s.freq).station} answers there.`); continue; }
    byFreq.set(s.freq, s);
  }
  const brains = new Map(); // freq -> ControllerBrain (made on first use)
  const queues = new Map(); // freq -> Promise chain
  const url = `${monitorUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/radio/worker`;
  let ws = null;
  let retryMs = 2000;
  let stopped = false;

  const brainFor = (s) => {
    if (!brains.has(s.freq)) brains.set(s.freq, new ControllerBrain({ persona: s.persona, ai: s.ai, logger: makeLogger(s.persona.callsign) }));
    return brains.get(s.freq);
  };
  const send = (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  async function handle(msg) {
    const s = byFreq.get(msg.freq);
    if (!s) return;
    let transcript;
    try {
      transcript = await transcribeAudio(pcmToWav(Buffer.from(msg.audio, 'base64'), { sampleRate: SAMPLE_RATE, channels: 1, bitsPerSample: 16 }));
    } catch (err) {
      logger.error(`Transcription failed on ${s.freq}: ${err.message}`);
      return;
    }
    if (!transcript || transcript.trim().length < MIN_TRANSCRIPT_LENGTH) return;
    send({ type: 'transcript', id: msg.id, freq: s.freq, from: msg.from, text: transcript });
    logger.info(`${s.freq} ${msg.from}: ${transcript}`);
    const reply = await brainFor(s).respond(transcript, { from: msg.from });
    if (!reply) return;
    logger.info(`${s.freq} ${s.persona.callsign}: ${reply}`);
    let audio = null;
    try {
      audio = (await synthesizeSpeech(reply, { voice: s.persona.ttsVoice })).toString('base64');
    } catch (err) {
      logger.error(`Speech synthesis failed on ${s.freq}: ${err.message}`); // still send the text
    }
    send({ type: 'reply', id: msg.id, freq: s.freq, from: s.persona.callsign, text: reply, mime: 'audio/mpeg', audio });
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocket(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    ws.on('open', () => {
      retryMs = 2000;
      send({ type: 'hello', stations: [...byFreq.values()].map((s) => ({ freq: s.freq, station: s.station, callsign: s.persona.callsign })) });
      logger.info(`In-app radio: answering on ${byFreq.size} frequencies.`);
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== 'utterance') return;
      const prev = queues.get(msg.freq) || Promise.resolve();
      const next = prev.then(() => handle(msg)).catch((err) => logger.error(`Radio reply failed: ${err.message}`));
      queues.set(msg.freq, next);
    });
    ws.on('close', () => {
      if (stopped) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(60_000, retryMs * 2);
    });
    ws.on('error', (err) => logger.warn(`Radio hub connection: ${err.message}`));
  }
  connect();
  return { stop: () => { stopped = true; if (ws) ws.close(); }, stations: byFreq };
}

module.exports = { startRadioWorker, loadStations, positionFor };
