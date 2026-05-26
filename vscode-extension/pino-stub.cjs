'use strict';

// No-op pino stub — prevents pino's worker-thread transport system from loading,
// which breaks when bundled with esbuild due to dynamic relative-path requires.
// @salesforce/core uses pino only for internal diagnostics; silencing it is safe.

const LEVELS = {
  labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
  values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
};

function makeLogger(bindings) {
  bindings = bindings || {};
  let levelVal = 30;
  const logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    silent() {},
    get level() { return LEVELS.labels[levelVal] || 'info'; },
    set level(v) { levelVal = LEVELS.values[v] != null ? LEVELS.values[v] : levelVal; },
    get levelVal() { return levelVal; },
    levels: LEVELS,
    bindings() { return Object.assign({}, bindings); },
    setBindings(obj) { Object.assign(bindings, obj); },
    child(fields) { return makeLogger(Object.assign({}, bindings, fields)); },
    flush() {},
    isLevelEnabled() { return false; },
  };
  return logger;
}

function pino(options) {
  return makeLogger({ name: (options && options.name) || 'root' });
}

pino.levels = LEVELS;
pino.stdSerializers = {};
pino.stdTimeFunctions = { epochTime: () => '' };
pino.destination = function() { return {}; };
pino.transport = function() { return {}; };
pino.multistream = function() { return {}; };

module.exports = pino;
module.exports.pino = pino;
module.exports.default = pino;
