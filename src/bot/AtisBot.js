const { Client, GatewayIntentBits } = require('discord.js');
const { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus } = require('@discordjs/voice');

const { joinVoiceWithRetry, waitForShardReady } = require('./voiceConnect');
const { bufferToStream } = require('../utils/audio');
const { synthesizeSpeech } = require('../speech/tts');
const { getAtis } = require('../flightradar365/client');
const { makeLogger } = require('../utils/logger');

const POLL_INTERVAL_MS = 60_000; // how often to check for a new ATIS report
const LOOP_GAP_MS = 2_000; // brief pause between repeats, like a real ATIS loop

/**
 * A dedicated bot for one airport's ATIS frequency - joins its own voice
 * channel and continuously loops the current ATIS report, re-synthesizing
 * only when the content actually changes (polled from the flightradar365
 * API). No STT or LLM involved at all - this bot never listens, it only
 * broadcasts, same as a real ATIS frequency.
 */
class AtisBot {
  constructor(config) {
    this.config = config;
    this.logger = makeLogger(config.name);
    this.player = createAudioPlayer();
    this.connection = null;
    this.currentText = null; // last broadcast text, for change detection
    this.currentAudioBuffer = null; // cached synthesized audio, reused every loop until content changes
    this.pollInterval = null;

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    this.client.on('ready', () => this._onReady().catch((err) => this.logger.error('Startup failed:', err)));
    this.client.on('error', (err) => this.logger.error('Discord client error:', err));
    this.player.on('error', (err) => this.logger.error('Audio player error:', err));
    this.player.on(AudioPlayerStatus.Idle, () => {
      setTimeout(() => this._playLoop(), LOOP_GAP_MS);
    });
  }

  async start() {
    await this.client.login(this.config.token);
  }

  async _onReady() {
    this.logger.info(`Logged in as ${this.client.user.tag}`);

    const guild = await this.client.guilds.fetch(this.config.guildId);
    await waitForShardReady(guild.shard);

    const joinOptions = {
      channelId: this.config.voiceChannelId,
      guildId: this.config.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true, // never needs to hear anything
      selfMute: false,
    };
    this.connection = await joinVoiceWithRetry(joinOptions, this.logger);
    this.connection.subscribe(this.player);
    this.logger.info(`Joined ATIS voice channel ${this.config.voiceChannelId}`);

    await this._refreshAtis();
    this.pollInterval = setInterval(() => {
      this._refreshAtis().catch((err) => this.logger.error('ATIS refresh failed:', err.message));
    }, POLL_INTERVAL_MS);
  }

  async _refreshAtis() {
    let response;
    try {
      response = await getAtis();
    } catch (err) {
      this.logger.warn(`Failed to fetch ATIS: ${err.message}`);
      return;
    }

    const entry = findAtisForAirport(response, this.config.persona.airport);
    if (!entry) {
      this.logger.warn(`No ATIS entry found for airport ${this.config.persona.airport}`);
      return;
    }

    const text = formatAtisBroadcast(entry);
    if (!text) {
      this.logger.warn(`ATIS entry for ${this.config.persona.airport} had no usable content - raw keys: ${Object.keys(entry).join(', ')}`);
      return;
    }

    if (text === this.currentText) return; // unchanged, keep looping the cached audio

    this.currentText = text;
    this.logger.info(`ATIS updated: ${text}`);

    try {
      this.currentAudioBuffer = await synthesizeSpeech(text, { voice: this.config.persona.ttsVoice });
    } catch (err) {
      this.logger.error('ATIS speech synthesis failed:', err.message);
      return;
    }

    if (this.player.state.status === AudioPlayerStatus.Idle) {
      this._playLoop();
    }
  }

  _playLoop() {
    if (!this.currentAudioBuffer) return;
    const resource = createAudioResource(bufferToStream(this.currentAudioBuffer), {
      inputType: StreamType.Arbitrary,
    });
    this.player.play(resource);
  }
}

/**
 * The exact response envelope from GET .../data?resource=atis isn't
 * confirmed against real API docs - this handles a few reasonable shapes
 * (bare array, {data: [...]}, {atis: [...]}, or a single object already
 * scoped to one airport) and matches on a likely ICAO field, falling back
 * to the whole response if nothing looks array-shaped.
 */
function findAtisForAirport(response, icao) {
  const rows = Array.isArray(response)
    ? response
    : Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.atis)
        ? response.atis
        : null;

  if (!rows) return response || null; // assume already single-airport-scoped

  const upperIcao = (icao || '').toUpperCase();
  return rows.find((row) => [row.icao, row.airport, row.airport_icao].some((v) => v && v.toUpperCase() === upperIcao)) || null;
}

/**
 * Builds the spoken ATIS text. Prefers a ready-made broadcast string if
 * the API provides one; otherwise assembles standard ATIS phraseology
 * from whatever individual fields are present (identifier, wind,
 * altimeter, active runway, remarks) - same defensive-field-name pattern
 * as src/flightplans/store.js, since the real field names aren't
 * confirmed yet either.
 */
function formatAtisBroadcast(entry) {
  const readyMade = entry.text || entry.broadcast || entry.message;
  if (typeof readyMade === 'string' && readyMade.trim()) return readyMade.trim();

  const parts = [];
  const identifier = entry.identifier || entry.letter || entry.info;
  if (identifier) parts.push(`Information ${identifier}.`);
  if (entry.wind) parts.push(`Wind ${entry.wind}.`);
  if (entry.visibility) parts.push(`Visibility ${entry.visibility}.`);
  if (entry.altimeter) parts.push(`Altimeter ${entry.altimeter}.`);
  const runway = entry.activeRunway || entry.active_runway || entry.runway;
  if (runway) parts.push(`Landing and departing runway ${runway}.`);
  if (entry.remarks || entry.notes) parts.push(entry.remarks || entry.notes);

  return parts.length > 0 ? parts.join(' ') : null;
}

module.exports = { AtisBot };
