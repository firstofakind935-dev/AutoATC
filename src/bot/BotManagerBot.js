const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');

const { AtcBot } = require('./AtcBot');
const { findFallback } = require('../botmanager/hierarchy');
const { buildFrequencyMap, normalizeFrequency } = require('../botmanager/frequencyLookup');
const { makeLogger } = require('../utils/logger');

const STATUS_POLL_MS = 15_000;
const TUNE_POLL_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 60_000; // same purpose as AtcBot's - keeps this bot's own /api/status entry fresh

const MONITOR_URL = process.env.MONITOR_URL || null;
const MONITOR_API_KEY = process.env.MONITOR_API_KEY || null;

/**
 * Not an ATC voice position - a fleet-wide utility bot with two jobs:
 *
 *  1. Failover: polls the monitor's /api/status for a bot going offline,
 *     and moves whoever was in that bot's voice channel up to the next
 *     available position (see src/botmanager/hierarchy.js). If Center
 *     itself goes offline with nothing above it to hand off to, it spins
 *     up a temporary AtcBot instance to cover Center until the real one
 *     comes back (see CENTER_FALLBACK_TOKEN below).
 *
 *  2. Frequency tuning: the companion app lets a pilot "tune" a frequency,
 *     which posts a request to the monitor (see monitor/server.js's
 *     /api/tune) - this bot polls that queue and actually moves the
 *     pilot's Discord voice state to whichever bot owns that frequency.
 *     Resolving a pilot's callsign to a Discord account depends on them
 *     having filed a flight plan via /fileflightplan at least once (see
 *     _handleFileFlightPlan below) - there's no other way to know which
 *     Discord user a plain-text callsign belongs to.
 */
class BotManagerBot {
  constructor(config, fleetConfigs) {
    this.config = config;
    this.logger = makeLogger(config.name);
    // Every ATC-position config in the fleet (not ATIS, not this bot
    // itself) - used for both the hierarchy search and the frequency map.
    this.fleetConfigs = fleetConfigs.filter((c) => c.name !== config.name && c.type === 'atc');
    this.frequencyMap = buildFrequencyMap(this.fleetConfigs);
    this.onlineByName = new Map(); // bot name -> last known online bool, for edge-detecting a transition
    this.centerFallback = null; // running AtcBot instance, or null if not currently covering Center
    this.statusTimer = null;
    this.tuneTimer = null;
    this.heartbeatTimer = null;

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    });

    this.client.on('ready', () => this._onReady().catch((err) => this.logger.error('Startup failed:', err)));
    this.client.on('interactionCreate', (interaction) => this._onInteraction(interaction).catch((err) => this.logger.error('Interaction failed:', err)));
    this.client.on('error', (err) => this.logger.error('Discord client error:', err));
  }

  async start() {
    await this.client.login(this.config.token);
  }

  async _onReady() {
    this.logger.info(`Logged in as ${this.client.user.tag}`);

    this.guild = await this.client.guilds.fetch(this.config.guildId);
    await this.guild.commands.set(buildSlashCommands()).catch((err) => this.logger.error('Failed to register slash commands:', err.message));

    if (!MONITOR_URL) {
      this.logger.warn('MONITOR_URL is not set - failover and frequency tuning are both disabled (nothing to poll).');
      return;
    }

    this.statusTimer = setInterval(() => this._pollStatus().catch((err) => this.logger.error('Status poll failed:', err.message)), STATUS_POLL_MS);
    this.tuneTimer = setInterval(() => this._pollTuneRequests().catch((err) => this.logger.error('Tune-request poll failed:', err.message)), TUNE_POLL_MS);
    this.heartbeatTimer = setInterval(() => this.logger.info('heartbeat'), HEARTBEAT_INTERVAL_MS);
    await this._pollStatus(); // establish the initial online/offline baseline immediately, not 15s from now
  }

  _monitorHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (MONITOR_API_KEY) headers.Authorization = `Bearer ${MONITOR_API_KEY}`;
    return headers;
  }

  async _monitorFetch(path, options = {}) {
    const response = await fetch(`${MONITOR_URL.replace(/\/+$/, '')}${path}`, {
      ...options,
      headers: { ...this._monitorHeaders(), ...(options.headers || {}) },
    });
    return response;
  }

  // ---------- Job 1: failover ----------

  // Edge-triggered on a wasOnline=true -> online=false transition - a bot
  // that's already offline when Bot Manager itself starts up is only
  // caught if it flips online then offline again afterward, not
  // immediately. Acceptable for now: Bot Manager is meant to be part of
  // the fleet's normal startup, not something brought up after the fact
  // to rescue an already-down bot.
  async _pollStatus() {
    const response = await this._monitorFetch('/api/status');
    if (!response.ok) throw new Error(`monitor responded ${response.status}`);
    const rows = await response.json();

    for (const row of rows) {
      const wasOnline = this.onlineByName.get(row.bot);
      this.onlineByName.set(row.bot, row.online);
      if (wasOnline === undefined) continue; // first time seeing this bot - not a transition, just a baseline

      if (wasOnline && !row.online) {
        const offlineConfig = this.fleetConfigs.find((c) => c.name === row.bot);
        if (offlineConfig) this._handleOffline(offlineConfig).catch((err) => this.logger.error(`Failover for ${row.bot} failed:`, err.message));
      } else if (!wasOnline && row.online) {
        this._handleBackOnline(row.bot);
      }
    }
  }

  _isOnline(botName) {
    return this.onlineByName.get(botName) === true;
  }

  async _handleOffline(offlineConfig) {
    this.logger.warn(`${offlineConfig.name} (${offlineConfig.persona.position}${offlineConfig.persona.airport ? ` @ ${offlineConfig.persona.airport}` : ''}) went offline.`);

    const fallback = findFallback(offlineConfig, this.fleetConfigs, (name) => this._isOnline(name));
    if (fallback) {
      await this._moveEveryoneFromTo(offlineConfig.voiceChannelId, fallback.voiceChannelId, offlineConfig.persona.callsign, fallback.persona.callsign);
      return;
    }

    if (offlineConfig.persona.position === 'Center') {
      await this._startCenterFallback(offlineConfig);
      return;
    }

    this.logger.error(`No online fallback found for ${offlineConfig.name} and it isn't Center - traffic on its frequency is currently uncovered.`);
  }

  _handleBackOnline(botName) {
    if (this.centerFallback && botName === this._realCenterBotName) {
      this.logger.info(`${botName} is back online - shutting down the Center fallback.`);
      this._stopCenterFallback();
    }
  }

  async _moveEveryoneFromTo(fromChannelId, toChannelId, fromLabel, toLabel) {
    const fromChannel = await this.guild.channels.fetch(fromChannelId).catch(() => null);
    if (!fromChannel || !fromChannel.isVoiceBased()) return;

    const members = [...fromChannel.members.values()];
    if (members.length === 0) {
      this.logger.info(`${fromLabel} was offline with nobody on frequency - nothing to move.`);
      return;
    }

    for (const member of members) {
      await member.voice.setChannel(toChannelId).catch((err) => this.logger.warn(`Failed to move ${member.user.tag} from ${fromLabel} to ${toLabel}: ${err.message}`));
    }
    this.logger.info(`Moved ${members.length} pilot(s) from ${fromLabel} to ${toLabel} (${fromLabel} is offline).`);
  }

  /**
   * Stands in for Center by running a real AtcBot instance in-process,
   * using CENTER_FALLBACK_TOKEN - a second Discord application's token,
   * pre-invited to the same server, that just never logs in unless
   * summoned here. Reuses the real Center config's guild/voice channel/
   * persona/AI settings entirely, so it sounds and behaves identically -
   * only the bot identity (and therefore the voice connection) differs.
   *
   * One token covers one region's Center - a fleet with more than one
   * independent Center wouldn't be able to cover more than one outage at
   * once with this alone; that's an acceptable MVP limit, not a hidden bug.
   */
  async _startCenterFallback(centerConfig) {
    if (this.centerFallback) return; // already covering (e.g. a second status poll raced this)

    const fallbackToken = process.env.CENTER_FALLBACK_TOKEN;
    if (!fallbackToken) {
      this.logger.error(
        `${centerConfig.name} (Center) is offline and nothing else in the fleet can cover it. Set CENTER_FALLBACK_TOKEN ` +
          `to a second Discord bot token (invited to the same server) so Bot Manager can stand in until a human fixes it.`
      );
      return;
    }

    this._realCenterBotName = centerConfig.name;
    const fallbackConfig = { ...centerConfig, name: `${centerConfig.name} (fallback)`, token: fallbackToken };
    this.centerFallback = new AtcBot(fallbackConfig);
    this.logger.warn(`${centerConfig.name} is offline with no fallback position available - Bot Manager is standing in as Center until it's back.`);
    try {
      await this.centerFallback.start();
    } catch (err) {
      this.logger.error(`Center fallback failed to start: ${err.message}`);
      this.centerFallback = null;
    }
  }

  _stopCenterFallback() {
    if (!this.centerFallback) return;
    this.centerFallback.client.destroy().catch(() => {});
    this.centerFallback = null;
    this._realCenterBotName = null;
  }

  // ---------- Job 2: frequency tuning ----------

  async _pollTuneRequests() {
    const response = await this._monitorFetch('/api/tune-requests');
    if (!response.ok) throw new Error(`monitor responded ${response.status}`);
    const requests = await response.json();

    for (const request of requests) {
      await this._handleTuneRequest(request).catch((err) => this.logger.error(`Tune request #${request.id} for ${request.callsign} failed:`, err.message));
      await this._monitorFetch(`/api/tune-requests/${request.id}`, { method: 'DELETE' }).catch(() => {});
    }
  }

  async _handleTuneRequest({ callsign, frequency }) {
    const target = this.frequencyMap.get(normalizeFrequency(frequency));
    if (!target) {
      this.logger.warn(`${callsign} tuned ${frequency}, which isn't a known fleet frequency - nothing to move them to.`);
      return;
    }

    const linkResponse = await this._monitorFetch(`/api/pilot-link?callsign=${encodeURIComponent(callsign)}`);
    if (linkResponse.status === 404) {
      this.logger.warn(`${callsign} tuned ${frequency} (${target.persona.callsign}), but has no linked Discord account yet - they need to run /fileflightplan at least once first.`);
      return;
    }
    if (!linkResponse.ok) throw new Error(`pilot-link lookup responded ${linkResponse.status}`);
    const link = await linkResponse.json();

    const guild = link.guildId === this.config.guildId ? this.guild : await this.client.guilds.fetch(link.guildId).catch(() => null);
    if (!guild) {
      this.logger.warn(`${callsign}'s linked guild (${link.guildId}) isn't reachable - can't move them.`);
      return;
    }

    const member = await guild.members.fetch(link.discordUserId).catch(() => null);
    if (!member || !member.voice.channelId) {
      this.logger.warn(`${callsign} tuned ${frequency}, but their linked Discord account isn't currently in any voice channel to move.`);
      return;
    }

    await member.voice.setChannel(target.voiceChannelId);
    this.logger.info(`${callsign} tuned ${frequency} - moved to ${target.persona.callsign}.`);
  }

  // ---------- Flight-plan filing (identity link + temp visibility) ----------

  async _onInteraction(interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'fileflightplan') await this._handleFileFlightPlan(interaction);
  }

  /**
   * A fixed-template slash command, not free text - Discord already hands
   * us interaction.user.id, which is the only reliable way to tie a
   * plain-text callsign to a Discord account (see the class comment on Job
   * 2). Doubles as a stand-in for flightradar365.lovable.app's own
   * Discord-login-gated flight plan filing when that's unavailable - if
   * FLIGHTPLANS_CHANNEL_ID is set, the filing is also posted there for
   * humans to read, same information a real flight-plan system would show.
   */
  async _handleFileFlightPlan(interaction) {
    const callsign = interaction.options.getString('callsign', true).toUpperCase();
    const aircraft = interaction.options.getString('aircraft', true);
    const departure = interaction.options.getString('departure', true).toUpperCase();
    const arrival = interaction.options.getString('arrival', true).toUpperCase();
    const altitude = interaction.options.getString('altitude', false);
    const route = interaction.options.getString('route', false);

    if (!MONITOR_URL) {
      await interaction.reply({ content: 'MONITOR_URL is not set in this bot\'s .env - the flight plan was not recorded anywhere.', ephemeral: true }).catch(() => {});
      return;
    }

    const linkResponse = await this._monitorFetch('/api/pilot-link', {
      method: 'POST',
      body: JSON.stringify({ callsign, discordUserId: interaction.user.id, guildId: interaction.guildId }),
    }).catch((err) => {
      this.logger.error(`Failed to record pilot link for ${callsign}: ${err.message}`);
      return null;
    });

    if (!linkResponse || !linkResponse.ok) {
      await interaction.reply({ content: 'Failed to record your flight plan - try again in a moment.', ephemeral: true }).catch(() => {});
      return;
    }

    const summary =
      `**${callsign}** (${aircraft}) - ${departure} to ${arrival}` +
      (altitude ? `, cruise ${altitude}` : '') +
      (route ? `\nRoute: ${route}` : '');

    if (this.config.flightPlansChannelId) {
      const channel = await this.guild.channels.fetch(this.config.flightPlansChannelId).catch(() => null);
      if (channel && channel.isTextBased()) await channel.send(summary).catch((err) => this.logger.warn(`Failed to post flight plan to channel: ${err.message}`));
    }

    await interaction.reply({ content: `Flight plan filed:\n${summary}\n\nYou can now tune frequencies for ${callsign} from the companion app.`, ephemeral: true }).catch(() => {});
  }
}

function buildSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName('fileflightplan')
      .setDescription('File a flight plan and link your callsign to your Discord account')
      .addStringOption((opt) => opt.setName('callsign').setDescription('Your callsign, e.g. "Reunited123"').setRequired(true))
      .addStringOption((opt) => opt.setName('aircraft').setDescription('Aircraft type, e.g. "Boeing 737"').setRequired(true))
      .addStringOption((opt) => opt.setName('departure').setDescription('Departure ICAO, e.g. "IRFD"').setRequired(true))
      .addStringOption((opt) => opt.setName('arrival').setDescription('Arrival ICAO, e.g. "IZOL"').setRequired(true))
      .addStringOption((opt) => opt.setName('altitude').setDescription('Cruise altitude, e.g. "FL350"').setRequired(false))
      .addStringOption((opt) => opt.setName('route').setDescription('Route/waypoints').setRequired(false)),
  ].map((command) => command.toJSON());
}

module.exports = { BotManagerBot };
