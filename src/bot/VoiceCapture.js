const { EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const { DISCORD_SAMPLE_RATE, DISCORD_CHANNELS } = require('../utils/audio');

const SILENCE_DURATION_MS = 1000; // stop capturing after this much silence
const MAX_UTTERANCE_MS = 20000; // hard cap so a stuck-open mic can't run forever
const MIN_UTTERANCE_BYTES = DISCORD_SAMPLE_RATE * DISCORD_CHANNELS * 2 * 0.3; // ~0.3s of audio

/**
 * Listens for users speaking on a voice connection and delivers a raw PCM
 * buffer per utterance via onUtterance(userId, pcmBuffer). Ignores bots.
 */
class VoiceCapture {
  constructor(connection, { getUserIsBot, logger } = {}) {
    this.connection = connection;
    this.getUserIsBot = getUserIsBot || (() => false);
    this.logger = logger;
    this.activeUsers = new Set();
    this._onSpeakingStart = this._onSpeakingStart.bind(this);
  }

  start(onUtterance) {
    this.onUtterance = onUtterance;
    this.connection.receiver.speaking.on('start', this._onSpeakingStart);
  }

  stop() {
    this.connection.receiver.speaking.off('start', this._onSpeakingStart);
    this.activeUsers.clear();
  }

  async _onSpeakingStart(userId) {
    if (this.activeUsers.has(userId)) return;
    this.activeUsers.add(userId); // claim immediately - getUserIsBot below is async

    if (await this.getUserIsBot(userId)) {
      this.activeUsers.delete(userId);
      return;
    }

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_DURATION_MS },
    });

    const decoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: 960,
    });

    const chunks = [];
    let totalBytes = 0;
    const hardStop = setTimeout(() => opusStream.destroy(), MAX_UTTERANCE_MS);

    opusStream.pipe(decoder);

    decoder.on('data', (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
    });

    const finish = () => {
      clearTimeout(hardStop);
      this.activeUsers.delete(userId);
      if (totalBytes >= MIN_UTTERANCE_BYTES && this.onUtterance) {
        this.onUtterance(userId, Buffer.concat(chunks));
      }
    };

    decoder.on('end', finish);
    decoder.on('error', (err) => {
      if (this.logger) this.logger.warn(`Opus decode error for user ${userId}: ${err.message}`);
      finish();
    });
    opusStream.on('error', (err) => {
      if (this.logger) this.logger.warn(`Voice receive error for user ${userId}: ${err.message}`);
    });
  }
}

module.exports = { VoiceCapture };
