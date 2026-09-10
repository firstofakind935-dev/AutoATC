const { Client, GatewayIntentBits, PermissionsBitField, Status } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  StreamType,
  VoiceConnectionStatus,
  AudioPlayerStatus,
} = require('@discordjs/voice');

const { VoiceCapture } = require('./VoiceCapture');
const { HumanHandoff } = require('./HumanHandoff');
const { pcmToWav, bufferToStream } = require('../utils/audio');
const { transcribeAudio } = require('../speech/stt');
const { synthesizeSpeech } = require('../speech/tts');
const { generateAtcReply, apiKeyForProvider, baseUrlForProvider, ConversationHistory } = require('../ai/llmProvider');
const { buildAtcSystemPrompt } = require('../ai/systemPrompt');
const { getFlightPlanContext } = require('../flightplans/store');
const { getChartContext } = require('../charts/store');
const { getOceanicTracksContext } = require('../charts/oceanicTracks');
const { makeLogger } = require('../utils/logger');

const MIN_TRANSCRIPT_LENGTH = 2;
const HEARTBEAT_INTERVAL_MS = 60_000; // keeps the monitor dashboard's "online" status fresh during quiet periods

/**
 * One Discord bot identity acting as a single ATC position (e.g. one
 * airport's Tower or Ground). A fleet of these, each with its own token
 * and config entry, runs concurrently from src/index.js.
 */
class AtcBot {
  constructor(config) {
    this.config = config;
    this.logger = makeLogger(config.name);
    this.handoff = new HumanHandoff();
    this.history = new ConversationHistory();
    this.systemPrompt = buildAtcSystemPrompt(config.persona);
    this.chartContext = getChartContext(config.persona.airport); // static per airport, fetched once
    this.oceanicTracksContext = getOceanicTracksContext(); // static fleet-wide, fetched once
    this.player = createAudioPlayer();
    this.processingQueue = Promise.resolve();
    this.connection = null;
    this.capture = null;
    this.guild = null;
    this.logChannel = null;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('ready', () => this._onReady().catch((err) => this.logger.error('Startup failed:', err)));
    this.client.on('messageCreate', (message) => this._onMessage(message));
    this.client.on('voiceStateUpdate', (oldState, newState) => this._onVoiceStateUpdate(oldState, newState));
    this.client.on('error', (err) => this.logger.error('Discord client error:', err));
    this.player.on('error', (err) => this.logger.error('Audio player error:', err));
  }

  async start() {
    await this.client.login(this.config.token);
  }

  async _onReady() {
    this.logger.info(`Logged in as ${this.client.user.tag}`);

    this.guild = await this.client.guilds.fetch(this.config.guildId);

    if (this.config.logChannelId) {
      this.logChannel = await this.guild.channels.fetch(this.config.logChannelId).catch(() => null);
    }

    // discord.js's voiceAdapterCreator silently refuses to send the join
    // request at all if the gateway shard isn't in Ready status yet
    // (Guild.js: `if (this.shard.status !== Status.Ready) return false`) -
    // and the client's own 'ready'/'clientReady' event can fire a beat
    // before that internal shard flag flips, so joining voice from directly
    // inside this handler can lose the race. When it does, the connection
    // is immediately dropped to "disconnected" (AdapterUnavailable) before
    // any listener has a chance to observe the transition, which is
    // indistinguishable from a silent hang without this guard.
    await waitForShardReady(this.guild.shard);

    // Only actually join voice if a human is already there - an empty
    // channel just sits in standby (logged into the gateway, watching for
    // voiceStateUpdate) rather than holding an idle voice connection open.
    // _onVoiceStateUpdate wakes it the moment someone joins.
    const channel = await this.guild.channels.fetch(this.config.voiceChannelId);
    if (channelHasHumans(channel)) {
      await this._enterVoice();
    } else {
      this.logger.info(`Voice channel ${this.config.voiceChannelId} is empty - starting in standby.`);
    }

    this.heartbeatInterval = setInterval(() => {
      this.logger.info('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Joins the configured voice channel and starts capturing speech. Safe to
   * call repeatedly - a no-op if already connected (e.g. a redundant
   * voiceStateUpdate firing while a previous _enterVoice() is in flight).
   */
  async _enterVoice() {
    if (this.connection) return;

    const joinOptions = {
      channelId: this.config.voiceChannelId,
      guildId: this.config.guildId,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    };
    this.connection = await joinVoiceWithRetry(joinOptions, this.logger);
    this._watchConnectionHealth();
    this.connection.subscribe(this.player);
    this.logger.info(`Joined voice channel ${this.config.voiceChannelId}`);

    this.capture = new VoiceCapture(this.connection, {
      logger: this.logger,
      getUserIsBot: async (userId) => {
        const member = await getMember(this.guild, userId);
        return member?.user.bot ?? false;
      },
    });
    this.capture.start((userId, pcmBuffer) => {
      this._enqueue(() => this._handleUtterance(this.guild, userId, pcmBuffer));
    });

    await this._announce(`${this.config.persona.callsign} online. AI ATC active.`);
  }

  /**
   * Leaves the voice channel and stops capture, dropping resource usage
   * (the voice UDP connection and audio decoding) back to near-zero while
   * staying logged into the gateway so voiceStateUpdate can wake it again.
   * Safe to call repeatedly - a no-op if not currently connected.
   */
  async _leaveVoice() {
    if (!this.connection) return;

    this.logger.info('Voice channel empty - entering standby.');
    await this._log(`💤 ${this.config.persona.callsign} entering standby (channel empty).`);

    if (this.capture) {
      this.capture.stop();
      this.capture = null;
    }
    this.connection.destroy();
    this.connection = null;
  }

  async _onVoiceStateUpdate(oldState, newState) {
    const channelId = this.config.voiceChannelId;
    if (oldState.channelId !== channelId && newState.channelId !== channelId) return;

    const channel = newState.channel ?? oldState.channel;
    if (!channel) return;

    const hasHumans = channelHasHumans(channel);
    this._enqueue(async () => {
      if (hasHumans && !this.connection) {
        await this._enterVoice();
      } else if (!hasHumans && this.connection) {
        await this._leaveVoice();
      }
    });
  }

  _watchConnectionHealth() {
    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.logger.warn('Voice connection lost, destroying connection.');
        this.connection.destroy();
      }
    });
  }

  // Shared serialization queue: utterance processing and standby
  // enter/leave transitions both go through here, so a voice-channel
  // teardown can never race a still-in-flight utterance for the
  // connection it's using, and vice versa.
  _enqueue(task) {
    this.processingQueue = this.processingQueue.then(task).catch((err) => {
      this.logger.error('Error in queued task:', err);
    });
    return this.processingQueue;
  }

  async _handleUtterance(guild, userId, pcmBuffer) {
    if (await this.handoff.shouldStayQuiet(this.config.guildId, this.config.voiceChannelId)) {
      return;
    }

    let transcript;
    try {
      transcript = await transcribeAudio(pcmToWav(pcmBuffer));
    } catch (err) {
      this.logger.error('Transcription failed:', err.message);
      return;
    }

    if (!transcript || transcript.trim().length < MIN_TRANSCRIPT_LENGTH) return;

    const speaker = await getMember(guild, userId);
    const speakerName = speaker ? speaker.displayName : userId;
    this.logger.info(`${speakerName}: ${transcript}`);
    await this._log(`🎙️ **${speakerName}:** ${transcript}`);

    this.history.addPilotTransmission(transcript);

    const flightPlanContext = await getFlightPlanContext();
    const turnContext = [this.chartContext, this.oceanicTracksContext, flightPlanContext]
      .filter(Boolean)
      .join('\n\n') || undefined;

    let reply;
    try {
      reply = await generateAtcReply({
        provider: this.config.ai.provider,
        apiKey: apiKeyForProvider(this.config.ai.provider),
        baseUrl: baseUrlForProvider(this.config.ai.provider),
        model: this.config.ai.model,
        systemPrompt: this.systemPrompt,
        history: this.history.toArray({ contextForLastTurn: turnContext }),
      });
    } catch (err) {
      // Node's fetch wraps every network-level failure (connection refused,
      // timeout, DNS failure, TLS error...) in a generic "fetch failed"
      // TypeError, with the actual reason only available on err.cause -
      // logging just err.message throws that reason away, making a real
      // outage indistinguishable from every other kind of network failure.
      const cause = err.cause ? ` (cause: ${err.cause.code || err.cause.message || err.cause})` : '';
      this.logger.error(`LLM generation failed: ${err.message}${cause}`);
      return;
    }

    if (!reply) return;
    this.history.addAtcReply(reply);
    this.logger.info(`${this.config.persona.callsign}: ${reply}`);
    await this._log(`📻 **${this.config.persona.callsign}:** ${reply}`);

    await this._speak(reply);
  }

  async _speak(text) {
    let mp3Buffer;
    try {
      mp3Buffer = await synthesizeSpeech(text, { voice: this.config.persona.ttsVoice });
    } catch (err) {
      this.logger.error('Speech synthesis failed:', err.message);
      return;
    }

    const resource = createAudioResource(bufferToStream(mp3Buffer), {
      inputType: StreamType.Arbitrary,
    });

    await new Promise((resolve) => {
      const onIdle = () => {
        this.player.off(AudioPlayerStatus.Idle, onIdle);
        this.player.off('error', onError);
        resolve();
      };
      const onError = (err) => {
        this.logger.error('Playback error:', err.message);
        onIdle();
      };
      this.player.once(AudioPlayerStatus.Idle, onIdle);
      this.player.once('error', onError);
      this.player.play(resource);
    });
  }

  async _announce(text) {
    await this._log(`ℹ️ ${text}`);
  }

  async _log(text) {
    if (!this.logChannel) return;
    try {
      await this.logChannel.send(text);
    } catch (err) {
      this.logger.warn('Failed to write to log channel:', err.message);
    }
  }

  async _onMessage(message) {
    if (message.author.bot || !this.config.commandPrefix) return;
    if (!message.content.startsWith(this.config.commandPrefix)) return;

    const args = message.content.trim().split(/\s+/).slice(1);
    const subcommand = args[0];

    const canControl = message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild);
    if (!canControl) {
      await message.reply('You need the "Manage Server" permission to control this bot.').catch(() => {});
      return;
    }

    if (subcommand === 'pause') {
      this.handoff.pause();
      await message.reply(`${this.config.persona.callsign}: AI ATC paused. Human controller has the position.`).catch(() => {});
    } else if (subcommand === 'resume') {
      this.handoff.resume();
      await message.reply(`${this.config.persona.callsign}: AI ATC resumed.`).catch(() => {});
    } else {
      await message.reply(`Usage: \`${this.config.commandPrefix} pause\` or \`${this.config.commandPrefix} resume\``).catch(() => {});
    }
  }
}

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

function channelHasHumans(channel) {
  return channel.members.some((member) => !member.user.bot);
}

/**
 * Polls until the guild's gateway shard reports Ready status. See the
 * comment at the call site in _onReady() for why this guard exists.
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

/**
 * Looks up a single guild member, checking the cache first and falling
 * back to a targeted REST fetch (GET /guilds/{guild}/members/{user}).
 * Deliberately never bulk-fetches the whole member list - that requires
 * the privileged "Server Members Intent" (opt-in per bot in the Discord
 * Developer Portal); a single-member fetch doesn't. Returns null if the
 * member can't be found (e.g. they left).
 */
async function getMember(guild, userId) {
  const cached = guild.members.cache.get(userId);
  if (cached) return cached;
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

module.exports = { AtcBot };
