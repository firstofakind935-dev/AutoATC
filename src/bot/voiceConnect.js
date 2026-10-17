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
      // Same-state updates (ready -> ready on every voice server refresh) were ~2,000 log lines an hour across the
      // fleet and buried the useful ones; only real transitions are logged.
      if (oldState.status !== newState.status) logger.info(`Voice connection state: ${oldState.status} -> ${newState.status}`);
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
const GUILD_RETRY_MS = 30_000;
const NOT_IN_GUILD = new Set([10004, 50001]); // Unknown Guild, Missing Access: the bot isn't in that server (yet)

/**
 * The bot's configured server, waiting for it when the bot hasn't been added yet. It used to fail once ("Unknown
 * Guild") and stay offline until the next redeploy - with 60 bots, invites get rate-limited and some always land
 * late. Now it says so once (with how to invite it) and checks again every 30 s, or at once when it is added
 * (guildCreate), then carries on with startup by itself. Other errors are thrown as before.
 */
async function fetchGuildWhenAdded(client, guildId, logger) {
  let told = false;
  for (;;) {
    try {
      return await client.guilds.fetch(guildId);
    } catch (err) {
      if (!NOT_IN_GUILD.has(err.code)) throw err;
      if (!told) {
        told = true;
        logger.warn(`Not in server ${guildId} yet - invite this bot (monitor /invite page, or the INVITE LINKS block in the logs). ` +
          'It will join by itself once it has been added.');
      }
      await new Promise((resolve) => {
        const onAdd = (guild) => { if (guild.id === guildId) done(); };
        const timer = setTimeout(() => done(), GUILD_RETRY_MS);
        function done() { clearTimeout(timer); client.off('guildCreate', onAdd); resolve(); }
        client.on('guildCreate', onAdd);
      });
    }
  }
}

/**
 * Runs `join` until it succeeds, waiting between tries - a voice join that fails all of joinVoiceWithRetry's quick
 * attempts (rate-limited, Discord hiccup) used to leave the bot logged in but outside its channel for good.
 */
async function keepTrying(join, logger, what = 'join the voice channel') {
  for (let attempt = 1; ; attempt++) {
    try {
      return await join();
    } catch (err) {
      const waitS = Math.min(300, 15 * attempt);
      logger.warn(`Could not ${what} (${err.message}) - trying again in ${waitS}s.`);
      await new Promise((resolve) => setTimeout(resolve, waitS * 1000));
    }
  }
}

/** "IRFD TWR", "irfd-twr", "IRFD_TWR", "🎧 IRFD TWR" all compare equal. */
const channelKey = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The voice channel to join: the one NAMED after this position's station (config "station", e.g. "IRFD TWR"), if
 * the server has exactly one; otherwise the configured voiceChannelId. Channel IDs copied from a spreadsheet can be
 * on the wrong row (Rockford Center's ID turned out to be the "IBTH TWR" channel), while the names are what people
 * see - so the name wins, and the log says when the two disagree.
 */
async function resolveVoiceChannelId(guild, config, logger) {
  if (!config.station) return config.voiceChannelId;
  let channels;
  try {
    channels = await guild.channels.fetch();
  } catch (err) {
    logger.warn(`Could not list the server's channels (${err.message}) - using the configured channel ${config.voiceChannelId}.`);
    return config.voiceChannelId;
  }
  const want = channelKey(config.station);
  const named = [...channels.values()].filter((c) => c && c.isVoiceBased && c.isVoiceBased() && channelKey(c.name) === want);
  if (named.length === 1) {
    if (named[0].id !== config.voiceChannelId) {
      const configured = channels.get(config.voiceChannelId);
      logger.warn(`Joining "${named[0].name}" (${named[0].id}) by name - the configured channel ${config.voiceChannelId}` +
        `${configured ? ` is "${configured.name}"` : ' is not in this server'}.`);
    }
    return named[0].id;
  }
  if (named.length > 1) logger.warn(`${named.length} voice channels are named "${config.station}" - using the configured one.`);
  return config.voiceChannelId;
}

async function waitForShardReady(shard, timeoutMs = SHARD_READY_TIMEOUT_MS) {
  const start = Date.now();
  while (shard.status !== Status.Ready) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Shard did not reach Ready status within ${timeoutMs}ms (currently: ${shard.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, SHARD_READY_POLL_MS));
  }
}

module.exports = { resolveVoiceChannelId, channelKey, fetchGuildWhenAdded, keepTrying, joinVoiceWithRetry, waitForShardReady };
