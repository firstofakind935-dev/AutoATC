const MONITOR_URL = process.env.MONITOR_URL || null;
const MONITOR_API_KEY = process.env.MONITOR_API_KEY || null;

function timestamp() {
  return new Date().toISOString();
}

function stringifyArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Fire-and-forget push to the monitoring dashboard (monitor/), if configured.
 * Must never throw or slow down the caller - a monitoring outage should
 * never affect the bot itself.
 */
function sendToMonitor(scope, level, message) {
  if (!MONITOR_URL) return;
  const headers = { 'Content-Type': 'application/json' };
  if (MONITOR_API_KEY) headers.Authorization = `Bearer ${MONITOR_API_KEY}`;

  fetch(`${MONITOR_URL.replace(/\/+$/, '')}/api/ingest`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ bot: scope, level, message }),
  }).catch(() => {});
}

function makeLogger(scope) {
  const prefix = `[${scope}]`;

  function log(consoleFn, level, args) {
    consoleFn(timestamp(), prefix, ...args);
    sendToMonitor(scope, level, args.map(stringifyArg).join(' '));
  }

  return {
    info: (...args) => log(console.log, 'info', args),
    warn: (...args) => log(console.warn, 'warn', args),
    error: (...args) => log(console.error, 'error', args),
  };
}

module.exports = { makeLogger };
