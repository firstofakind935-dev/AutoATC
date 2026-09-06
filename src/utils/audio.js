const { Readable } = require('stream');

// Discord voice receive gives us 48kHz, 16-bit, stereo PCM once decoded from Opus.
const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const DISCORD_BITS_PER_SAMPLE = 16;

/**
 * Wraps a raw PCM buffer in a minimal WAV (RIFF) header so it can be sent
 * to speech-to-text APIs that expect a self-describing audio file.
 */
function pcmToWav(pcmBuffer, {
  sampleRate = DISCORD_SAMPLE_RATE,
  channels = DISCORD_CHANNELS,
  bitsPerSample = DISCORD_BITS_PER_SAMPLE,
} = {}) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function bufferToStream(buffer) {
  return Readable.from(buffer);
}

module.exports = {
  pcmToWav,
  bufferToStream,
  DISCORD_SAMPLE_RATE,
  DISCORD_CHANNELS,
  DISCORD_BITS_PER_SAMPLE,
};
