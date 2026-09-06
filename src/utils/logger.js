function timestamp() {
  return new Date().toISOString();
}

function makeLogger(scope) {
  const prefix = `[${scope}]`;
  return {
    info: (...args) => console.log(timestamp(), prefix, ...args),
    warn: (...args) => console.warn(timestamp(), prefix, ...args),
    error: (...args) => console.error(timestamp(), prefix, ...args),
  };
}

module.exports = { makeLogger };
