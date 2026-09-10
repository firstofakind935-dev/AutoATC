const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const { createAudioPlayer, createAudioResource, entersState, StreamType, VoiceConnectionStatus, AudioPlayerStatus } = require('@discordjs/voice');

const { joinVoiceWithRetry, waitForShardReady } = require('./voiceConnect');
const { VoiceCapture } = require('./VoiceCapture');
const { HumanHandoff } = require('./HumanHandoff');
const { pcmToWav, bufferToStream } = require('../utils/audio');
const { transcribeAudio } = require('../speech/stt');
const { synthesizeSpeech } = require('../speech/tts');
const { generateAtcReply, apiKeyForProvider, baseUrlForProvider, ConversationHistory } = require('../ai/llmProvider');
const { buildAtcSystemPrompt } = require('../ai/systemPrompt');
const { findBestScenario, formatScenarioHint } = require('../ai/scenarioMatcher');
const { getFlightPlanContext } = require('../flightplans/store');
const { getChartContext } = require('../charts/store');
const { getOceanicTracksContext } = require('../charts/oceanicTracks');
const { getFrequencyContext } = require('../charts/frequencies');
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
    this.frequencyContext = getFrequencyContext(); // static fleet-wide, fetched once
    this.player = createAudioPlayer();
    this.processingQueue = Promise.resolve();
    this.connection = null;
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
    this.client.on('error', (err) => this.logger.error('Discord client error:', err));
    this.player.on('error', (err) => this.logger.error('Audio player error:', err));
  }

  async start() {
    await this.client.login(this.config.token);
  }

  async _onReady() {
    this.logger.info(`Logged in as ${this.client.user.tag}`);

    const guild = await this.client.guilds.fetch(this.config.guildId);

    if (this.config.logChannelId) {
      this.logChannel = await guild.channels.fetch(this.config.logChannelId).catch(() => null);
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
    await waitForShardReady(guild.shard);

    const joinOptions = {
      channelId: this.config.voiceChannelId,
      guildId: this.config.guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    };
    this.connection = await joinVoiceWithRetry(joinOptions, this.logger);
    this._watchConnectionHealth();
    this.connection.subscribe(this.player);
    this.logger.info(`Joined voice channel ${this.config.voiceChannelId}`);

    const capture = new VoiceCapture(this.connection, {
      logger: this.logger,
      getUserIsBot: async (userId) => {
        const member = await getMember(guild, userId);
        return member?.user.bot ?? false;
      },
    });
    capture.start((userId, pcmBuffer) => {
      this._enqueue(() => this._handleUtterance(guild, userId, pcmBuffer));
    });

    await this._announce(`${this.config.persona.callsign} online. AI ATC active.`);

    this.heartbeatInterval = setInterval(() => {
      this.logger.info('heartbeat');
    }, HEARTBEAT_INTERVAL_MS);
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

  _enqueue(task) {
    this.processingQueue = this.processingQueue.then(task).catch((err) => {
      this.logger.error('Error while processing utterance:', err);
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
    const matchedScenario = findBestScenario(transcript, this.config.persona.position);
    const scenarioContext = matchedScenario ? formatScenarioHint(matchedScenario) : null;
    const turnContext = [this.chartContext, this.oceanicTracksContext, this.frequencyContext, flightPlanContext, scenarioContext]
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
