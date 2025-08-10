const winston = require('winston');
const { format } = winston;

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
      filename: 'logs/error.log',
      level: 'error',
    }),
    // Write all logs with level 'info' and below to combined.log
    new winston.transports.File({
      filename: 'logs/combined.log',
    }),
  ],
  // Handle exceptions and rejections
  exceptionHandlers: [
    new winston.transports.File({ filename: 'logs/exceptions.log' }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: 'logs/rejections.log' }),
  ],
});

module.exports = logger;
