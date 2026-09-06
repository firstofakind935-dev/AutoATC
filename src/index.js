process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || require('ffmpeg-static');

const { loadFleetConfig } = require('./utils/config');
const { AtcBot } = require('./bot/AtcBot');
const { makeLogger } = require('./utils/logger');

const logger = makeLogger('fleet');

async function main() {
  const fleetConfig = loadFleetConfig();
  logger.info(`Starting ${fleetConfig.length} bot(s): ${fleetConfig.map((c) => c.name).join(', ')}`);

  const bots = fleetConfig.map((config) => new AtcBot(config));

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
