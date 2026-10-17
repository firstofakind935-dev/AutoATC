// The radio hub: pilots talk to AI (and human) controllers through the companion / pilot app instead of Discord
// voice - no 50-bot limit, every station on the frequency list can be live.
//
//   /radio?callsign=N42Y            a pilot's app (or ?role=controller&callsign=... for a human controller console)
//   /radio/worker                   the controller "brain" (the bot fleet, src/radio/), which answers on its stations
//
// Pilot <-> hub (JSON text frames, plus binary audio):
//   -> {type:'tune', tx:'121.000', rx:['121.000','120.400']}   transmit frequency and the ones being listened to
//   -> {type:'ptt', on:true}  <- {type:'ptt', granted, freq, reason?}   one transmitter per frequency, like a radio
//   -> binary: PCM 16-bit LE, mono, 16 kHz, while the PTT is granted
//   -> {type:'ptt', on:false}
//   <- {type:'rx-start', stream, freq, from}  <- binary [uint16 LE stream][PCM]  <- {type:'rx-end', stream}
//   <- {type:'rx-clip', freq, from, text, mime, audio(base64)}   a controller's reply
//   <- {type:'rx-text', freq, from, text}                       what a pilot said (transcribed), for subtitles
//   <- {type:'stations', stations:[{freq, station, callsign, staffed}]}
// Worker <-> hub:
//   -> {type:'hello', stations:[{freq, station, callsign}]}
//   <- {type:'utterance', id, freq, from, audio(base64 PCM 16k mono)}
//   -> {type:'transcript', id, freq, text}      -> {type:'reply', id, freq, from, text, mime, audio(base64)}
// A human controller on a frequency (role=controller, transmitting on it) takes it over: the AI stays quiet there.

const { WebSocketServer } = require('ws');
const { URL } = require('url');

const SAMPLE_RATE = 16000;
const MAX_UTTERANCE_S = 30;
const MAX_UTTERANCE_BYTES = SAMPLE_RATE * 2 * MAX_UTTERANCE_S;
const PTT_TIMEOUT_MS = (MAX_UTTERANCE_S + 2) * 1000; // a stuck transmitter frees the frequency
const MIN_UTTERANCE_BYTES = SAMPLE_RATE * 2 * 0.3; // shorter than 0.3 s: a click, not a call
const HUMAN_IDLE_MS = 10 * 60 * 1000; // a human controller who hasn't transmitted for 10 min hands back to the AI

const normFreq = (f) => {
  const n = Number(f);
  return Number.isFinite(n) && n >= 100 && n < 200 ? n.toFixed(3) : null;
};

function createRadioHub({ workerKey = null, logger = console } = {}) {
  const pilots = new Map(); // id -> {id, ws, callsign, role, tx, rx:Set, ptt:{freq, stream, chunks, bytes, timer}|null}
  const workers = new Set(); // {ws, stations: Map(freq -> {freq, station, callsign})}
  const busy = new Map(); // freq -> pilot id transmitting
  const humans = new Map(); // freq -> {id, at}  human controller holding the frequency
  let nextId = 1;
  let nextStream = 1;
  let nextUtterance = 1;

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg)); };
  const listeners = (freq, exceptId = null) => [...pilots.values()].filter((p) => p.id !== exceptId && p.rx.has(freq));

  function stationList() {
    const out = new Map();
    for (const w of workers) for (const s of w.stations.values()) out.set(s.freq, { ...s, ai: true });
    for (const [freq, h] of humans) {
      const p = pilots.get(h.id);
      out.set(freq, { ...(out.get(freq) || { freq, station: null }), callsign: p ? p.callsign : 'Controller', staffed: 'human' });
    }
    return [...out.values()].sort((a, b) => a.freq.localeCompare(b.freq));
  }
  const announceStations = () => { const msg = { type: 'stations', stations: stationList() }; for (const p of pilots.values()) send(p.ws, msg); };

  function workerFor(freq) {
    if (humans.has(freq)) return null; // a human has it
    for (const w of workers) if (w.stations.has(freq) && w.ws.readyState === 1) return w;
    return null;
  }

  function endPtt(pilot, reason) {
    const t = pilot.ptt;
    if (!t) return;
    pilot.ptt = null;
    clearTimeout(t.timer);
    if (busy.get(t.freq) === pilot.id) busy.delete(t.freq);
    for (const l of listeners(t.freq, pilot.id)) send(l.ws, { type: 'rx-end', stream: t.stream });
    if (pilot.role === 'controller') { humans.set(t.freq, { id: pilot.id, at: Date.now() }); return; }
    if (reason !== 'released' || t.bytes < MIN_UTTERANCE_BYTES) return;
    const worker = workerFor(t.freq);
    if (!worker) return;
    const id = nextUtterance++;
    send(worker.ws, { type: 'utterance', id, freq: t.freq, from: pilot.callsign, audio: Buffer.concat(t.chunks).toString('base64') });
  }

  function onPilotMessage(pilot, data, isBinary) {
    if (isBinary) {
      const t = pilot.ptt;
      if (!t || t.bytes + data.length > MAX_UTTERANCE_BYTES) return;
      t.chunks.push(data);
      t.bytes += data.length;
      const header = Buffer.alloc(2);
      header.writeUInt16LE(t.stream);
      const frame = Buffer.concat([header, data]);
      for (const l of listeners(t.freq, pilot.id)) send(l.ws, frame);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'tune') {
      const tx = normFreq(msg.tx);
      if (pilot.ptt && pilot.ptt.freq !== tx) endPtt(pilot, 'retuned');
      pilot.tx = tx;
      pilot.rx = new Set((Array.isArray(msg.rx) ? msg.rx : [msg.tx]).map(normFreq).filter(Boolean));
      if (tx) pilot.rx.add(tx);
      if (pilot.role === 'controller' && tx) { humans.set(tx, { id: pilot.id, at: Date.now() }); announceStations(); }
    } else if (msg.type === 'ptt') {
      if (msg.on) {
        const freq = pilot.tx;
        if (!freq) return send(pilot.ws, { type: 'ptt', granted: false, reason: 'no frequency tuned' });
        const holder = busy.get(freq);
        if (holder && holder !== pilot.id) {
          const other = pilots.get(holder);
          return send(pilot.ws, { type: 'ptt', granted: false, freq, reason: `frequency busy (${other ? other.callsign : 'someone'} transmitting)` });
        }
        if (pilot.ptt) return send(pilot.ws, { type: 'ptt', granted: true, freq });
        busy.set(freq, pilot.id);
        const stream = nextStream = (nextStream % 65535) + 1;
        pilot.ptt = { freq, stream, chunks: [], bytes: 0, timer: setTimeout(() => endPtt(pilot, 'timeout'), PTT_TIMEOUT_MS) };
        for (const l of listeners(freq, pilot.id)) send(l.ws, { type: 'rx-start', stream, freq, from: pilot.callsign, sampleRate: SAMPLE_RATE });
        send(pilot.ws, { type: 'ptt', granted: true, freq });
      } else {
        endPtt(pilot, 'released');
      }
    }
  }

  function onWorkerMessage(worker, data, isBinary) {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'hello' && Array.isArray(msg.stations)) {
      worker.stations = new Map(msg.stations.map((s) => [normFreq(s.freq), { freq: normFreq(s.freq), station: s.station, callsign: s.callsign }]).filter(([f]) => f));
      logger.info(`[radio] controller worker serving ${worker.stations.size} frequencies`);
      announceStations();
    } else if (msg.type === 'transcript') {
      const freq = normFreq(msg.freq);
      if (freq && msg.text) for (const l of listeners(freq)) send(l.ws, { type: 'rx-text', freq, from: msg.from || null, text: String(msg.text) });
    } else if (msg.type === 'reply') {
      const freq = normFreq(msg.freq);
      if (!freq || humans.has(freq)) return; // a human took the frequency meanwhile
      for (const l of listeners(freq)) send(l.ws, { type: 'rx-clip', freq, from: msg.from, text: msg.text, mime: msg.mime || 'audio/mpeg', audio: msg.audio });
    }
  }

  // humans who went quiet hand the frequency back
  const sweep = setInterval(() => {
    let changed = false;
    for (const [freq, h] of humans) if (!pilots.has(h.id) || Date.now() - h.at > HUMAN_IDLE_MS) { humans.delete(freq); changed = true; }
    if (changed) announceStations();
  }, 30_000);
  sweep.unref?.();

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/radio/worker') {
      const auth = req.headers.authorization || '';
      if (workerKey && auth !== `Bearer ${workerKey}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return true; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const worker = { ws, stations: new Map() };
        workers.add(worker);
        ws.on('message', (d, b) => onWorkerMessage(worker, d, b));
        ws.on('close', () => { workers.delete(worker); announceStations(); });
      });
      return true;
    }
    if (url.pathname === '/radio') {
      const callsign = String(url.searchParams.get('callsign') || '').trim().slice(0, 16) || 'UNKNOWN';
      const role = url.searchParams.get('role') === 'controller' ? 'controller' : 'pilot';
      wss.handleUpgrade(req, socket, head, (ws) => {
        const pilot = { id: nextId++, ws, callsign, role, tx: null, rx: new Set(), ptt: null };
        pilots.set(pilot.id, pilot);
        send(ws, { type: 'hello', id: pilot.id, sampleRate: SAMPLE_RATE, stations: stationList() });
        ws.on('message', (d, b) => onPilotMessage(pilot, d, b));
        ws.on('close', () => {
          endPtt(pilot, 'disconnected');
          pilots.delete(pilot.id);
          for (const [freq, h] of humans) if (h.id === pilot.id) humans.delete(freq);
        });
      });
      return true;
    }
    return false;
  }

  return {
    handleUpgrade,
    stats: () => ({ pilots: pilots.size, workers: workers.size, stations: stationList().length, busy: busy.size }),
    close: () => { clearInterval(sweep); for (const p of pilots.values()) p.ws.terminate(); for (const w of workers) w.ws.terminate(); },
  };
}

module.exports = { createRadioHub, SAMPLE_RATE };
