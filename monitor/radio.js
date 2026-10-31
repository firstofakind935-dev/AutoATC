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
//   -> {type:'say', text}   a typed call on the transmit frequency (when the radio can't hear you): shown to the
//                           frequency as rx-text and answered like a spoken one
//   <- {type:'rx-notice', freq, text}   ATC didn't get your transmission (its speech recognition failed): say again or type it
//   <- {type:'rx-start', stream, freq, from}  <- binary [uint16 LE stream][PCM]  <- {type:'rx-end', stream}
//   <- {type:'rx-clip', freq, from, text, mime, audio(base64)}   a controller's reply
//   <- {type:'rx-text', freq, from, text}                       what a pilot said (transcribed), for subtitles
//   <- {type:'stations', stations:[{freq, station, callsign, ai, staffed?:'human', controller?}]}
// Worker <-> hub:
//   -> {type:'hello', stations:[{freq, station, callsign}]}
//   <- {type:'utterance', id, freq, from, audio(base64 PCM 16k mono)}
//      (or {type:'utterance', id, freq, from, text} for a typed call - no audio)
//   -> {type:'transcript', id, freq, text}      -> {type:'reply', id, freq, from, text, mime, audio(base64)}
//   -> {type:'unheard', id, freq, reason}       the transmission couldn't be transcribed
// Human controllers (/radio?role=controller&callsign=...&key=CONTROLLER_KEY - the console at /console):
//   -> {type:'takeover', freq}   the AI stops answering there at once; the controller gets the frequency's recent
//                                transcript <- {type:'history', freq, lines:[{at, from, text}]} and transmits on it
//   -> {type:'handback', freq}   back to the AI (also when the controller disconnects)
//   -> {type:'broadcast', text}  to every connected pilot on every frequency <- {type:'broadcast', from, text, at}
// Admins (/radio?role=controller&admin=1&key=ADMIN_KEY - the admin console at /console/admin.html; ADMIN_KEY falls back
// to CONTROLLER_KEY): everything a controller can do, plus transmit on ANY tuned frequency without taking it over
// (the AI keeps answering there and hears what the admin said).  <- {type:'role', admin:true}
//                                (apps show it as a banner and read it out with the device's own voice)
// While a human holds a frequency, transmissions there are still transcribed (listenOnly) - for the transcript, and
// so the AI knows what happened when it gets the frequency back.

const { WebSocketServer } = require('ws');
const { URL } = require('url');

const SAMPLE_RATE = 16000;
const MAX_UTTERANCE_S = 30;
const MAX_UTTERANCE_BYTES = SAMPLE_RATE * 2 * MAX_UTTERANCE_S;
const PTT_TIMEOUT_MS = (MAX_UTTERANCE_S + 2) * 1000; // a stuck transmitter frees the frequency
const MIN_UTTERANCE_BYTES = SAMPLE_RATE * 2 * 0.3; // shorter than 0.3 s: a click, not a call
const HISTORY_LINES = 40; // per frequency, sent to a controller who takes it over
const HISTORY_MS = 20 * 60 * 1000;
const MAX_SAY_CHARS = 300;
const UTTERANCE_TTL_MS = 2 * 60 * 1000; // how long we remember who sent an utterance, to tell them if it was lost

const normFreq = (f) => {
  const n = Number(f);
  return Number.isFinite(n) && n >= 100 && n < 200 ? n.toFixed(3) : null;
};

function createRadioHub({ workerKey = null, controllerKey = null, adminKey = null, logger = console } = {}) {
  const adminPass = adminKey || controllerKey; // with no ADMIN_KEY, the controller key unlocks admin too
  const pilots = new Map(); // id -> {id, ws, callsign, role, tx, rx:Set, ptt:{freq, stream, chunks, bytes, timer}|null}
  const workers = new Set(); // {ws, stations: Map(freq -> {freq, station, callsign})}
  const busy = new Map(); // freq -> pilot id transmitting
  const humans = new Map(); // freq -> {id, at}  human controller holding the frequency
  const history = new Map(); // freq -> [{at, from, text}]  what was said there lately

  function remember(freq, from, text) {
    const now = Date.now();
    const lines = (history.get(freq) || []).filter((l) => now - l.at < HISTORY_MS);
    lines.push({ at: now, from, text });
    history.set(freq, lines.slice(-HISTORY_LINES));
  }
  let nextId = 1;
  let nextStream = 1;
  let nextUtterance = 1;
  const sentBy = new Map(); // utterance id -> {pilotId, freq, at}

  function forward(worker, utterance, pilot) {
    sentBy.set(utterance.id, { pilotId: pilot.id, freq: utterance.freq, at: Date.now() });
    for (const [id, u] of sentBy) if (Date.now() - u.at > UTTERANCE_TTL_MS) sentBy.delete(id);
    send(worker.ws, utterance);
  }
  const NOT_HEARD = 'ATC did not receive that (radio problem). Say again, or type your message.';

  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg)); };
  const listeners = (freq, exceptId = null) => [...pilots.values()].filter((p) => p.id !== exceptId && p.rx.has(freq));

  function stationList() {
    const out = new Map();
    for (const w of workers) for (const s of w.stations.values()) out.set(s.freq, { ...s, ai: true });
    for (const [freq, h] of humans) {
      const p = pilots.get(h.id);
      const base = out.get(freq) || { freq, station: null, callsign: null };
      out.set(freq, { ...base, staffed: 'human', controller: p ? p.callsign : 'Controller' }); // the station keeps its callsign
    }
    return [...out.values()].sort((a, b) => a.freq.localeCompare(b.freq));
  }
  const announceStations = () => { const msg = { type: 'stations', stations: stationList() }; for (const p of pilots.values()) send(p.ws, msg); };

  function anyWorkerFor(freq) {
    for (const w of workers) if (w.stations.has(freq) && w.ws.readyState === 1) return w;
    for (const w of workers) if (w.ws.readyState === 1) return w; // to transcribe a frequency no AI serves
    return null;
  }

  function endPtt(pilot, reason) {
    const t = pilot.ptt;
    if (!t) return;
    pilot.ptt = null;
    clearTimeout(t.timer);
    if (busy.get(t.freq) === pilot.id) busy.delete(t.freq);
    for (const l of listeners(t.freq, pilot.id)) send(l.ws, { type: 'rx-end', stream: t.stream });
    if (reason !== 'released' || t.bytes < MIN_UTTERANCE_BYTES) return;
    // with a human on the frequency (or a controller talking) the AI only listens: it transcribes, never answers
    const listenOnly = pilot.role === 'controller' || humans.has(t.freq);
    const worker = anyWorkerFor(t.freq);
    if (!worker) {
      if (!listenOnly) send(pilot.ws, { type: 'rx-notice', freq: t.freq, text: 'No AI controller is connected right now.' });
      return;
    }
    const id = nextUtterance++;
    forward(worker, { type: 'utterance', id, freq: t.freq, from: pilot.callsign, speaker: pilot.role, listenOnly,
      audio: Buffer.concat(t.chunks).toString('base64') }, pilot);
  }

  // a typed call: everyone on the frequency sees it, and the AI answers it like a spoken one
  function say(pilot, text) {
    const freq = pilot.tx;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_SAY_CHARS);
    if (!freq) return send(pilot.ws, { type: 'rx-notice', freq: null, text: 'Tune a frequency first.' });
    if (!clean) return;
    if (pilot.role === 'controller' && !pilot.admin && (humans.get(freq) || {}).id !== pilot.id) {
      return send(pilot.ws, { type: 'rx-notice', freq, text: 'Take the frequency over first.' });
    }
    remember(freq, pilot.callsign, clean);
    for (const l of listeners(freq)) send(l.ws, { type: 'rx-text', freq, from: pilot.callsign, text: clean, typed: true });
    const listenOnly = pilot.role === 'controller' || humans.has(freq);
    const worker = anyWorkerFor(freq);
    if (!worker) {
      if (!listenOnly) send(pilot.ws, { type: 'rx-notice', freq, text: 'No AI controller is connected right now.' });
      return;
    }
    forward(worker, { type: 'utterance', id: nextUtterance++, freq, from: pilot.callsign, speaker: pilot.role, listenOnly, text: clean }, pilot);
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
    } else if (msg.type === 'takeover' && pilot.role === 'controller') {
      const freq = normFreq(msg.freq);
      if (!freq) return;
      const holder = humans.get(freq);
      if (holder && holder.id !== pilot.id && pilots.has(holder.id)) {
        return send(pilot.ws, { type: 'takeover', freq, ok: false, reason: `${pilots.get(holder.id).callsign} already has it` });
      }
      humans.set(freq, { id: pilot.id, at: Date.now() });
      pilot.tx = freq;
      pilot.rx.add(freq);
      send(pilot.ws, { type: 'takeover', freq, ok: true });
      send(pilot.ws, { type: 'history', freq, lines: history.get(freq) || [] });
      logger.info(`[radio] ${pilot.callsign} took over ${freq}`);
      announceStations();
    } else if (msg.type === 'handback' && pilot.role === 'controller') {
      const freq = normFreq(msg.freq);
      const holder = humans.get(freq);
      if (holder && holder.id === pilot.id) {
        humans.delete(freq);
        if (pilot.ptt && pilot.ptt.freq === freq) endPtt(pilot, 'handback');
        if (pilot.tx === freq) pilot.tx = null;
        logger.info(`[radio] ${pilot.callsign} handed ${freq} back to the AI`);
        announceStations();
      }
      send(pilot.ws, { type: 'handback', freq, ok: true });
    } else if (msg.type === 'broadcast' && pilot.role === 'controller') {
      const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!text) return;
      const out = { type: 'broadcast', from: pilot.callsign, text, at: new Date().toISOString() };
      let n = 0;
      for (const p of pilots.values()) { send(p.ws, out); if (p.role !== 'controller') n++; }
      send(pilot.ws, { type: 'broadcast-sent', text, pilots: n });
      logger.info(`[radio] broadcast from ${pilot.callsign} to ${n} pilots: ${text}`);
    } else if (msg.type === 'say') {
      say(pilot, msg.text);
    } else if (msg.type === 'ptt') {
      if (msg.on) {
        const freq = pilot.tx;
        if (!freq) return send(pilot.ws, { type: 'ptt', granted: false, reason: 'no frequency tuned' });
        if (pilot.role === 'controller' && !pilot.admin && (humans.get(freq) || {}).id !== pilot.id) {
          return send(pilot.ws, { type: 'ptt', granted: false, freq, reason: 'take the frequency over first' });
        }
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
    } else if (msg.type === 'unheard') {
      const u = sentBy.get(msg.id);
      sentBy.delete(msg.id);
      const pilot = u && pilots.get(u.pilotId);
      if (pilot) send(pilot.ws, { type: 'rx-notice', freq: u.freq, text: NOT_HEARD });
    } else if (msg.type === 'transcript') {
      sentBy.delete(msg.id);
      const freq = normFreq(msg.freq);
      if (freq && msg.text) {
        remember(freq, msg.from || null, String(msg.text));
        for (const l of listeners(freq)) send(l.ws, { type: 'rx-text', freq, from: msg.from || null, text: String(msg.text) });
      }
    } else if (msg.type === 'reply') {
      const freq = normFreq(msg.freq);
      if (!freq || humans.has(freq)) return; // a human took the frequency meanwhile
      remember(freq, msg.from, msg.text);
      for (const l of listeners(freq)) send(l.ws, { type: 'rx-clip', freq, from: msg.from, text: msg.text, mime: msg.mime || 'audio/mpeg', audio: msg.audio });
    }
  }

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
      const key = url.searchParams.get('key');
      const wantsAdmin = role === 'controller' && url.searchParams.get('admin') === '1';
      const ok = wantsAdmin ? (!adminPass || key === adminPass) : (role !== 'controller' || !controllerKey || key === controllerKey);
      if (!ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const pilot = { id: nextId++, ws, callsign, role, admin: wantsAdmin, tx: null, rx: new Set(), ptt: null };
        pilots.set(pilot.id, pilot);
        send(ws, { type: 'hello', id: pilot.id, sampleRate: SAMPLE_RATE, stations: stationList() });
        if (wantsAdmin) { send(ws, { type: 'role', admin: true }); logger.info(`[radio] admin ${callsign} connected`); }
        ws.on('message', (d, b) => onPilotMessage(pilot, d, b));
        ws.on('close', () => {
          endPtt(pilot, 'disconnected');
          pilots.delete(pilot.id);
          let handed = false;
          for (const [freq, h] of humans) if (h.id === pilot.id) { humans.delete(freq); handed = true; }
          if (handed) announceStations();
        });
      });
      return true;
    }
    return false;
  }

  return {
    handleUpgrade,
    stats: () => ({ pilots: pilots.size, workers: workers.size, stations: stationList().length, busy: busy.size }),
    close: () => { for (const p of pilots.values()) p.ws.terminate(); for (const w of workers) w.ws.terminate(); },
  };
}

module.exports = { createRadioHub, SAMPLE_RATE };
