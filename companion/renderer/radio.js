// The in-app radio: talk to the controllers (and hear other pilots) on the frequency you're tuned to, through the
// monitor's radio hub (monitor/radio.js) instead of Discord. Hold push-to-talk (a key watched while the game has
// focus - lib/pttKey.js - or the on-screen button) to transmit on your primary radio; you hear every powered radio's
// active frequency. Audio out: 16 kHz mono 16-bit PCM, sent live. Audio in: other pilots live, controllers' replies as
// MP3 clips. Used by control.js through window.AppRadio - and, with {role: 'controller', key}, by the human
// controllers' console (monitor/console/), where takeover(freq)/handback(freq) take frequencies from the AI and back.

(function () {
  const RATE = 16000;
  const JITTER_S = 0.12; // live audio is played this far behind, so small network hiccups don't break it up

  let ws = null;
  let url = null;
  let retryMs = 2000;
  let wantOpen = false;
  let tuned = { tx: null, rx: [] };
  let transmitting = false;
  let pttHeld = false;
  let mic = null; // {stream, ctx, node, source}
  let playCtx = null;
  let volume = 1;
  const streams = new Map(); // stream id -> {freq, from, at (next play time)}
  let clipChain = Promise.resolve();
  const listeners = { status: [], log: [], stations: [], ptt: [], control: [], history: [] };
  let stations = [];

  const emit = (kind, ...args) => listeners[kind].forEach((fn) => { try { fn(...args); } catch (e) { console.error(e); } });
  const status = (state, detail) => emit('status', state, detail);

  function audioOut() {
    if (!playCtx) playCtx = new AudioContext();
    if (playCtx.state === 'suspended') playCtx.resume();
    return playCtx;
  }

  // ---- connection ----------------------------------------------------------------------------------------------
  function connect(monitorUrl, callsign, { role = 'pilot', key = '' } = {}) {
    const extra = role === 'controller' ? `&role=controller&key=${encodeURIComponent(key || '')}` : '';
    const next = `${String(monitorUrl || '').replace(/^http/, 'ws').replace(/\/+$/, '')}/radio?callsign=${encodeURIComponent(callsign || 'UNKNOWN')}${extra}`;
    if (!monitorUrl) { status('off', 'Set the Monitor URL in settings to use the radio.'); return; }
    if (ws && url === next && ws.readyState <= 1) return;
    disconnect();
    url = next;
    wantOpen = true;
    open();
  }

  function open() {
    if (!wantOpen) return;
    status('connecting');
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { retryMs = 2000; status('connected'); sendTune(); };
    ws.onclose = () => {
      stopTransmit();
      if (!wantOpen) { status('off'); return; }
      status('reconnecting');
      setTimeout(open, retryMs);
      retryMs = Math.min(30_000, retryMs * 2);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? onJson(JSON.parse(ev.data)) : onAudio(ev.data));
  }

  function disconnect() {
    wantOpen = false;
    if (ws) { try { ws.close(); } catch {} }
    ws = null;
  }

  const sendJson = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function tune(tx, rx) {
    tuned = { tx: tx ? Number(tx).toFixed(3) : null, rx: [...new Set((rx || []).filter(Boolean).map((f) => Number(f).toFixed(3)))] };
    sendTune();
  }
  function sendTune() { sendJson({ type: 'tune', tx: tuned.tx, rx: tuned.rx }); }

  function stationOn(freq) { return stations.find((s) => s.freq === freq); }

  // ---- receiving -----------------------------------------------------------------------------------------------
  function onJson(msg) {
    if (msg.type === 'hello' || msg.type === 'stations') { stations = msg.stations || []; emit('stations', stations); }
    else if (msg.type === 'takeover' || msg.type === 'handback') {
      if (msg.type === 'takeover' && msg.ok) tuned.tx = msg.freq;
      if (msg.type === 'handback' && tuned.tx === msg.freq) { stopTransmit(); tuned.tx = null; }
      emit('control', msg.type, msg.freq, msg.ok, msg.reason);
    } else if (msg.type === 'history') {
      emit('history', msg.freq, msg.lines || []);
    } else if (msg.type === 'ptt') {
      if (!msg.granted) { stopTransmit(); emit('log', { kind: 'warn', text: `Can't transmit: ${msg.reason}` }); emit('ptt', 'denied', msg.reason); }
      else emit('ptt', 'transmitting', msg.freq);
    } else if (msg.type === 'rx-start') {
      streams.set(msg.stream, { freq: msg.freq, from: msg.from, at: 0 });
      emit('log', { kind: 'rx', freq: msg.freq, from: msg.from, text: '(transmitting)' , live: true });
    } else if (msg.type === 'rx-end') {
      streams.delete(msg.stream);
    } else if (msg.type === 'rx-text') {
      emit('log', { kind: 'text', freq: msg.freq, from: msg.from, text: msg.text });
    } else if (msg.type === 'rx-clip') {
      emit('log', { kind: 'atc', freq: msg.freq, from: msg.from, text: msg.text });
      if (msg.audio) playClip(msg.audio);
    }
  }

  function onAudio(buf) {
    const view = new DataView(buf);
    const s = streams.get(view.getUint16(0, true));
    if (!s) return;
    const ctx = audioOut();
    const samples = (buf.byteLength - 2) >> 1;
    if (!samples) return;
    const audio = ctx.createBuffer(1, samples, RATE);
    const ch = audio.getChannelData(0);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(2 + i * 2, true) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = audio;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(ctx.destination);
    const startAt = Math.max(s.at, ctx.currentTime + (s.at ? 0 : JITTER_S));
    src.start(startAt);
    s.at = startAt + audio.duration;
  }

  function playClip(base64) {
    clipChain = clipChain.then(async () => {
      const ctx = audioOut();
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const audio = await ctx.decodeAudioData(bytes.buffer);
      await new Promise((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = audio;
        const gain = ctx.createGain();
        gain.gain.value = volume;
        src.connect(gain).connect(ctx.destination);
        src.onended = resolve;
        src.start();
      });
    }).catch((err) => emit('log', { kind: 'warn', text: `Could not play a reply: ${err.message}` }));
  }

  // ---- transmitting --------------------------------------------------------------------------------------------
  async function ensureMic() {
    if (mic) return mic;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    // a 16 kHz context: the browser resamples the microphone for us
    const ctx = new AudioContext({ sampleRate: RATE });
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (e) => {
      if (!transmitting || !ws || ws.readyState !== 1) return;
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
      ws.send(pcm.buffer);
    };
    source.connect(node);
    node.connect(ctx.destination); // a ScriptProcessor only runs when connected; it outputs silence
    mic = { stream, ctx, node, source };
    return mic;
  }

  async function startTransmit() {
    if (transmitting) return;
    if (!ws || ws.readyState !== 1) { emit('log', { kind: 'warn', text: 'Radio not connected.' }); return; }
    if (!tuned.tx) { emit('log', { kind: 'warn', text: 'No frequency on your primary radio.' }); return; }
    try {
      const m = await ensureMic();
      if (m.ctx.state === 'suspended') await m.ctx.resume();
    } catch (err) {
      emit('log', { kind: 'warn', text: `Microphone unavailable: ${err.message}` });
      return;
    }
    if (!pttHeld) return; // released while the microphone was starting
    transmitting = true;
    sendJson({ type: 'ptt', on: true });
    emit('ptt', 'requesting', tuned.tx);
  }

  function stopTransmit() {
    if (!transmitting) return;
    transmitting = false;
    sendJson({ type: 'ptt', on: false });
    emit('ptt', 'idle');
  }

  function setPtt(down) {
    pttHeld = down;
    if (down) startTransmit(); else stopTransmit();
  }

  window.AppRadio = {
    connect,
    disconnect,
    tune,
    setPtt,
    takeover: (freq) => sendJson({ type: 'takeover', freq }),
    handback: (freq) => sendJson({ type: 'handback', freq }),
    setVolume: (v) => { volume = Math.max(0, Math.min(2, Number(v) || 0)); },
    stationOn,
    get stations() { return stations; },
    get tuned() { return tuned; },
    on: (kind, fn) => listeners[kind].push(fn),
  };
})();
