const fs = require('fs');
const path = require('path');
const winston = require('winston');
const { format } = winston;

const logDir = path.join(__dirname, '..', 'logs');
try {
  fs.mkdirSync(logDir, { recursive: true });
} catch {
  // If the directory can't be created, Winston will surface errors on write.
}

const parseBytes = (value, fallback) => {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const parseIntSafe = (value, fallback) => {
  if (value == null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Rotation defaults (can override via env)
// - LOG_MAX_SIZE_BYTES: max size per log file before rotating
// - LOG_MAX_FILES: number of rotated files to keep (per transport)
const LOG_MAX_SIZE_BYTES = parseBytes(process.env.LOG_MAX_SIZE_BYTES, 10 * 1024 * 1024); // 10MB
const LOG_MAX_FILES = parseIntSafe(process.env.LOG_MAX_FILES, 10);

// Custom format for log messages
const logFormat = format.combine(
  format.timestamp({
    format: 'YYYY-MM-DD HH:mm:ss',
  }),
  format.errors({ stack: true }),
  format.splat(),
  format.json()
);

// Create the logger instance
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  transports: [
    // Write all logs to console (include metadata for easy debugging)
    new winston.transports.Console({
      format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.colorize(),
        format.errors({ stack: true }),
        format.metadata({ fillExcept: ['timestamp', 'level', 'message', 'stack'] }),
        format.printf((info) => {
          const meta = info.metadata || {};
          const hasMeta = meta && Object.keys(meta).length > 0;
          const metaString = hasMeta ? ` ${JSON.stringify(meta)}` : '';
          const stackString = info.stack ? `\n${info.stack}` : '';
          return `${info.timestamp} ${info.level}: ${info.message}${metaString}${stackString}`;
        })
      ),
    }),
    // Write all logs with level 'error' and below to error.log
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      level: 'error',
      maxsize: LOG_MAX_SIZE_BYTES,
      maxFiles: LOG_MAX_FILES,
      tailable: true,
    }),
    // Write all logs with level 'info' and below to combined.log
    new winston.transports.File({
      filename: path.join(logDir, 'combined.log'),
      maxsize: LOG_MAX_SIZE_BYTES,
      maxFiles: LOG_MAX_FILES,
      tailable: true,
    }),
  ],
  // Handle exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(logDir, 'exceptions.log'),
      maxsize: LOG_MAX_SIZE_BYTES,
      maxFiles: LOG_MAX_FILES,
      tailable: true,
    }),
  ],
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join(logDir, 'rejections.log'),
      maxsize: LOG_MAX_SIZE_BYTES,
      maxFiles: LOG_MAX_FILES,
      tailable: true,
    }),
  ],
});

module.exports = logger;
