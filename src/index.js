process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

const { loadFleetConfig } = require('./utils/config');
const { AtcBot } = require('./bot/AtcBot');
const { AtisBot } = require('./bot/AtisBot');
const { BotManagerBot } = require('./bot/BotManagerBot');
const { makeLogger } = require('./utils/logger');
const { startPositionSync } = require('./flightradar365/positionSync');

const logger = makeLogger('fleet');

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

  const results = await Promise.allSettled(bots.map((bot) => bot.start()));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.error(`Bot "${fleetConfig[index].name}" failed to start:`, result.reason);
    }
  });

  if (results.every((r) => r.status === 'rejected')) {
    logger.error('No bots started successfully. Exiting.');
    process.exit(1);
  }
}

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection:', err);
});

main().catch((err) => {
  logger.error('Fatal error during startup:', err.message);
  process.exit(1);
});
