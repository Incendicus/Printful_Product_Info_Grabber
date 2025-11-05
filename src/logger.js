const LEVELS = {
  BASIC: 'basic',
  DEBUG: 'debug',
  OVERKILL: 'overkill'
};

const isDebugEnabled = () => process.env.DEBUG_ON === 'true' || process.env.DEBUG_ON === '1';
const isOverkillEnabled = () => process.env.DEBUG_OVERKILL === 'true' || process.env.DEBUG_OVERKILL === '1';

const formatMessage = (level, message) => {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
};

const log = (level, message, ...optionalParams) => {
  switch (level) {
    case LEVELS.BASIC:
      console.log(formatMessage(level, message), ...optionalParams);
      break;
    case LEVELS.DEBUG:
      if (isDebugEnabled()) {
        console.debug(formatMessage(level, message), ...optionalParams);
      }
      break;
    case LEVELS.OVERKILL:
      if (isOverkillEnabled()) {
        console.debug(formatMessage(level, message), ...optionalParams);
      }
      break;
    default:
      console.log(formatMessage(level, message), ...optionalParams);
  }
};

const info = (message, ...optionalParams) => log(LEVELS.BASIC, message, ...optionalParams);
const warn = (message, ...optionalParams) => console.warn(formatMessage('warn', message), ...optionalParams);
const error = (message, ...optionalParams) => console.error(formatMessage('error', message), ...optionalParams);
const debug = (message, ...optionalParams) => log(LEVELS.DEBUG, message, ...optionalParams);
const overkill = (message, ...optionalParams) => log(LEVELS.OVERKILL, message, ...optionalParams);

module.exports = {
  info,
  warn,
  error,
  debug,
  overkill
};
