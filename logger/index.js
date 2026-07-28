const pino = require('pino');

const enabled = !/^(?:0|false|off|no)$/i.test(String(process.env.LOG_ENABLED ?? 'true'));
const defaultLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
const level = String(process.env.LOG_LEVEL || defaultLevel).toLowerCase();

const logger = pino({
  level,
  base: {
    pid: undefined,
    hostname: undefined,
  },
  enabled,
});

module.exports = logger;
