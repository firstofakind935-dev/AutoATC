const { joinVoiceChannel, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { Status } = require('discord.js');

const SHARD_READY_POLL_MS = 100;
const SHARD_READY_TIMEOUT_MS = 10_000;
const VOICE_JOIN_MAX_ATTEMPTS = 3;
const VOICE_JOIN_TIMEOUT_MS = 15_000;
const VOICE_JOIN_RETRY_DELAY_MS = 3_000;

/**
 * Joins a voice channel, retrying a few times on failure. Real-world
 * testing showed an occasional transient hang (Discord never responding
 * with voice server info in time) immediately after a run that had
 * succeeded in under 200ms moments earlier, with no code change in
 * between - a one-off Discord-side hiccup rather than a persistent bug.
 * Recovering from that shouldn't require a full manual bot restart.
 */
async function joinVoiceWithRetry(joinOptions, logger) {
  let lastError;
  for (let attempt = 1; attempt <= VOICE_JOIN_MAX_ATTEMPTS; attempt++) {
    const connection = joinVoiceChannel(joinOptions);
    // Logged immediately (not just on future transitions) since a failed
    // sendPayload can flip the state synchronously during construction,
    // before any 'stateChange' listener could be attached to see it.
    logger.info(`Voice connection initial state (attempt ${attempt}): ${connection.state.status}`);
    connection.on('stateChange', (oldState, newState) => {
      logger.info(`Voice connection state: ${oldState.status} -> ${newState.status}`);
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, VOICE_JOIN_TIMEOUT_MS);
      return connection;
    } catch (err) {
      lastError = err;
      logger.warn(`Voice join attempt ${attempt}/${VOICE_JOIN_MAX_ATTEMPTS} failed: ${err.message}`);
      connection.destroy();
      if (attempt < VOICE_JOIN_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, VOICE_JOIN_RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}

/**
 * Polls until the guild's gateway shard reports Ready status. Needed
 * because discord.js's voiceAdapterCreator silently refuses to send the
 * join request at all if the shard isn't Ready yet (Guild.js: `if
 * (this.shard.status !== Status.Ready) return false`), and the client's
 * own 'ready'/'clientReady' event can fire a beat before that internal
 * flag flips - joining voice directly inside that handler can lose the
 * race, dropping the connection straight to "disconnected"
 * (AdapterUnavailable) before any listener can observe it.
 */
async function waitForShardReady(shard, timeoutMs = SHARD_READY_TIMEOUT_MS) {
  const start = Date.now();
  while (shard.status !== Status.Ready) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Shard did not reach Ready status within ${timeoutMs}ms (currently: ${shard.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, SHARD_READY_POLL_MS));
  }
}

module.exports = { joinVoiceWithRetry, waitForShardReady };
