process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

const { loadFleetConfig } = require('./utils/config');
const { AtcBot } = require('./bot/AtcBot');
const { AtisBot } = require('./bot/AtisBot');
const { BotManagerBot } = require('./bot/BotManagerBot');
const { makeLogger } = require('./utils/logger');
const { startPositionSync } = require('./flightradar365/positionSync');
const { inviteUrl } = require('../monitor/fleetInvites');
const { startRadioWorker } = require('./radio/radioWorker');

const logger = makeLogger('fleet');
const STARTUP_GAP_MS = 1500;

// fleetConfig is only used by BotManagerBot, which needs to see every other
// bot's config (for the failover hierarchy and frequency-tuning lookup) -
// AtcBot/AtisBot only ever need their own.
function createBot(config, fleetConfig) {
  if (config.type === 'atis') return new AtisBot(config);
  if (config.type === 'botmanager') return new BotManagerBot(config, fleetConfig);
  return new AtcBot(config);
}

async function main() {
  const fleetConfig = loadFleetConfig();

  // The in-app radio (companion / pilot app push-to-talk): every station on the frequency list answers there, with or
  // without a Discord bot - see src/radio/. RADIO_ENABLED=false turns it off.
  if (process.env.RADIO_ENABLED !== 'false') startRadioWorker();

  if (fleetConfig.length === 0) {
    logger.warn('No bot has its token env var set - staying up idle. Add one in your host\'s env vars and redeploy.');
    // Node exits once main() resolves and the event loop is empty - hang
    // here instead, so the process stays up rather than exiting cleanly
    // and having the host (e.g. Railway) treat that as a crash to restart.
    await new Promise(() => {});
  }

  logger.info(`Starting ${fleetConfig.length} bot(s): ${fleetConfig.map((c) => c.name).join(', ')}`);

  startPositionSync();

  const bots = fleetConfig.map((c) => createBot(c, fleetConfig));

  // Log in one after another, a little apart: 60 bots hitting Discord in the same second trip its rate limits.
  const results = await Promise.allSettled(
    bots.map((bot, i) => new Promise((resolve) => setTimeout(resolve, i * STARTUP_GAP_MS)).then(() => bot.start()))
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(`Bot "${fleetConfig[index].name}" failed to start:`, result.reason);
    }
  });

  if (results.every((r) => r.status === 'rejected')) {
    logger.error('No bots started successfully. Exiting.');
    process.exit(1);
  }

  printInviteLinks(bots, fleetConfig).catch((err) => logger.warn('Could not list invite links:', err.message));
}

/**
 * Every bot's "add to server" link, in one block in the logs. Discord only lets a server admin add a bot (one
 * authorization per bot - a bot can't add other bots), so this saves looking up each one's client id. The server is the one
 * the bots are configured for (INVITE_GUILD_ID overrides it). Waits up to a minute for the bots to finish logging in.
 */
async function printInviteLinks(bots, fleetConfig) {
  // the server the bots are configured for (config/bots.json guildId), unless INVITE_GUILD_ID says otherwise
  const configured = fleetConfig.find((c) => c.guildId)?.guildId;
  const guildId = [process.env.INVITE_GUILD_ID, configured].find((g) => /^\d{15,22}$/.test(g || '')) || null;
  const until = Date.now() + 60_000;
  while (Date.now() < until && bots.some((b) => b.client && !b.client.isReady())) await new Promise((r) => setTimeout(r, 2000));
  const lines = [];
  bots.forEach((bot, i) => {
    const c = bot.client;
    if (!c || !c.isReady()) { lines.push(`  ${fleetConfig[i].name}: not logged in - check its token`); return; }
    const url = inviteUrl({ applicationId: c.application?.id || c.user.id, type: fleetConfig[i].type || 'atc' }, guildId);
    lines.push(`  ${fleetConfig[i].name}: ${url}`);
  });
  console.log(`\n===== INVITE LINKS (${bots.length} bots${guildId ? `, server ${guildId}` : ''}) =====\n` +
    `Open each link while logged into Discord as a server admin and click Authorize.\n${lines.join('\n')}\n===== END INVITE LINKS =====\n`);
}

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
});

main().catch((err) => {
  logger.error('Fatal error during startup:', err.message);
  process.exit(1);
});
