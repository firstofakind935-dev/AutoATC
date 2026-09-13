const { Client, GatewayIntentBits, PermissionsBitField, SlashCommandBuilder } = require('discord.js');
const { createAudioPlayer, createAudioResource, entersState, StreamType, VoiceConnectionStatus, AudioPlayerStatus } = require('@discordjs/voice');

const { joinVoiceWithRetry, waitForShardReady } = require('./voiceConnect');
const { VoiceCapture } = require('./VoiceCapture');
const { HumanHandoff } = require('./HumanHandoff');
const { pcmToWav, bufferToStream } = require('../utils/audio');
const { transcribeAudio } = require('../speech/stt');
const { synthesizeSpeech } = require('../speech/tts');
const { generateAtcReplyWithFallback, ConversationHistory } = require('../ai/llmProvider');
const { buildAtcSystemPrompt } = require('../ai/systemPrompt');
const { findBestScenario, formatScenarioHint } = require('../ai/scenarioMatcher');
const { getFlightPlanContext } = require('../flightplans/store');
const { getChartContext } = require('../charts/store');
const { getOceanicTracksContext } = require('../charts/oceanicTracks');
const { getFrequencyContext } = require('../charts/frequencies');
const { formatStripsContext } = require('../atc/flightStrips');
const { getPositionsContext } = require('../atc/positions');
const { sendDatalinkMessage, sendBroadcastMessage } = require('../atc/datalink');
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
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    this.client.on('ready', () => this._onReady().catch((err) => this.logger.error('Startup failed:', err)));
    this.client.on('interactionCreate', (interaction) => this._onInteraction(interaction));
    this.client.on('error', (err) => this.logger.error('Discord client error:', err));
    this.player.on('error', (err) => this.logger.error('Audio player error:', err));
  }

  async start() {
    await this.client.login(this.config.token);
  }

  async _onReady() {
    this.logger.info(`Logged in as ${this.client.user.tag}`);

    const guild = await this.client.guilds.fetch(this.config.guildId);
    await guild.commands.set(buildSlashCommands()).catch((err) => this.logger.error('Failed to register slash commands:', err.message));

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
    const stripsContext = formatStripsContext(this.config.persona.position);
    const positionsContext = await getPositionsContext();
    const matchedScenario = findBestScenario(transcript, this.config.persona.position);
    const scenarioContext = matchedScenario ? formatScenarioHint(matchedScenario) : null;
    const turnContext = [
      this.chartContext,
      this.oceanicTracksContext,
      this.frequencyContext,
      flightPlanContext,
      stripsContext,
      positionsContext,
      scenarioContext,
    ]
      .filter(Boolean)
      .join('\n\n') || undefined;

    let reply;
    try {
      reply = await generateAtcReplyWithFallback(
        {
          provider: this.config.ai.provider,
          model: this.config.ai.model,
          fallback: this.config.ai.fallback,
          systemPrompt: this.systemPrompt,
          history: this.history.toArray({ contextForLastTurn: turnContext }),
          position: this.config.persona.position,
        },
        this.logger
      );
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

  async _onInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'pause') {
      this.handoff.pause();
      await interaction.reply(`${this.config.persona.callsign}: AI ATC paused. Human controller has the position.`).catch(() => {});
    } else if (interaction.commandName === 'resume') {
      this.handoff.resume();
      await interaction.reply(`${this.config.persona.callsign}: AI ATC resumed.`).catch(() => {});
    } else if (interaction.commandName === 'cpdlc') {
      await this._handleCpdlcCommand(interaction);
    } else if (interaction.commandName === 'broadcast') {
      await this._handleBroadcastCommand(interaction);
    }
  }

  /**
   * Fleet-wide announcement to every pilot currently polling the monitor
   * for datalink messages, not just this bot's own frequency - e.g. server
   * news or an update, distinct from an ATC instruction to one aircraft.
   * The command's default_member_permissions (Administrator, set in
   * buildSlashCommands below) already keeps regular controllers - who only
   * have "Manage Server" - from seeing it in Discord's UI at all, but a
   * server admin can loosen that default, so it's checked again here too.
   */
  async _handleBroadcastCommand(interaction) {
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.reply({ content: 'You need the "Administrator" permission to send a fleet-wide broadcast.', ephemeral: true }).catch(() => {});
      return;
    }

    const text = interaction.options.getString('message', true);
    const attempted = sendBroadcastMessage({ fromPosition: this.config.persona.position, text });
    if (!attempted) {
      await interaction.reply({ content: 'MONITOR_URL is not set in this bot\'s .env - the broadcast was not sent anywhere.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.reply(`Broadcast sent to all pilots: "${text}"`).catch(() => {});
  }

  /**
   * Lets a human controlling this position (whether or not they've paused
   * the AI) send the same CPDLC/PDC datalink messages the LLM can, by hand -
   * e.g. a "contact me" to an aircraft not on this frequency, or a PDC
   * during heavy traffic. Always sent as this bot's own ATC position
   * (fromPosition), never something the human has to specify.
   */
  async _handleCpdlcCommand(interaction) {
    const kind = interaction.options.getSubcommand();
    const callsign = interaction.options.getString('callsign', true);
    const directive = { callsign, kind, fromPosition: this.config.persona.position };

    if (kind === 'contact') {
      directive.facility = interaction.options.getString('facility', true);
      directive.frequency = interaction.options.getString('frequency', true);
    } else if (kind === 'pdc') {
      directive.clearance = interaction.options.getString('clearance', true);
    } else {
      directive.text = interaction.options.getString('message', true);
    }

    const attempted = sendDatalinkMessage(directive);
    if (!attempted) {
      await interaction.reply({ content: 'MONITOR_URL is not set in this bot\'s .env - the message was not sent anywhere.', ephemeral: true }).catch(() => {});
      return;
    }
    await interaction.reply(`Sent ${kind} datalink message to ${callsign}.`).catch(() => {});
  }
}

/**
 * Slash commands registered per-guild on 'ready' (see _onReady above).
 * pause/resume/cpdlc default to requiring "Manage Server" (the same tier
 * every controller-facing command here has always used); broadcast
 * defaults to "Administrator" since it reaches every pilot on the server
 * at once, not just one aircraft. These are Discord-enforced defaults
 * (commands a member lacks the permission for don't even show up for
 * them), on top of the runtime check in _handleBroadcastCommand.
 */
function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('pause')
      .setDescription('Silence the AI - a human controller is taking over this position')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Give the position back to the AI')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    new SlashCommandBuilder()
      .setName('cpdlc')
      .setDescription('Send a CPDLC/PDC datalink message to one aircraft')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
      .addSubcommand((sub) =>
        sub
          .setName('contact')
          .setDescription('Instruct an aircraft not on your frequency to contact another facility')
          .addStringOption((opt) => opt.setName('callsign').setDescription('Aircraft callsign').setRequired(true))
          .addStringOption((opt) => opt.setName('facility').setDescription('Facility to contact, e.g. "Barths Center"').setRequired(true))
          .addStringOption((opt) => opt.setName('frequency').setDescription('Frequency, e.g. "132.550"').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('pdc')
          .setDescription('Deliver a routine IFR clearance as text instead of over voice')
          .addStringOption((opt) => opt.setName('callsign').setDescription('Aircraft callsign').setRequired(true))
          .addStringOption((opt) => opt.setName('clearance').setDescription('Full clearance text, as you would otherwise speak it').setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName('text')
          .setDescription('Send a free-form text message to one aircraft')
          .addStringOption((opt) => opt.setName('callsign').setDescription('Aircraft callsign').setRequired(true))
          .addStringOption((opt) => opt.setName('message').setDescription('Message text').setRequired(true))
      ),
    new SlashCommandBuilder()
      .setName('broadcast')
      .setDescription('Send a fleet-wide announcement to every pilot (moderator only)')
      .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
      .addStringOption((opt) => opt.setName('message').setDescription('Announcement text').setRequired(true)),
  ].map((command) => command.toJSON());
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
