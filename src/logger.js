const winston = require('winston');
const { config } = require('./config');

// Create a logger instance
const logger = winston.createLogger({
  level: config.app.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'aws-pinpoint-cleanup' },
  transports: [
    // Write all logs with importance level of `error` or less to `error.log`
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    // Write all logs with importance level of `info` or less to `combined.log`
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  ],
});

// Always log to console for real-time feedback
logger.add(new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.simple()
  )
}));

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = 'logs';
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Utility functions for common logging patterns
const logProgress = (current, total, message = 'Processing') => {
  const percentage = ((current / total) * 100).toFixed(1);
  logger.info(`${message}: ${current}/${total} (${percentage}%)`);
};

const logError = (error, context = {}) => {
  logger.error('Error occurred', {
    error: error.message,
    stack: error.stack,
    ...context
  });
};

const logArnResult = (arn, status, details = {}) => {
  // Log individual ARNs at debug level for detailed feedback
  if (config.app.logLevel === 'debug') {
    logger.info('ARN checked', {
      arn,
      status,
      ...details
    });
  }
};

// Add batch summary logging for production performance
const logBatchSummary = (batchNumber, totalBatches, results, processingTime = null) => {
  const summary = results.reduce((acc, result) => {
    if (result.status === 'ENABLED') acc.enabled++;
    else if (result.status === 'DISABLED') acc.disabled++;
    else if (result.status === 'ERROR') acc.error++;
    else if (result.status === 'NOT_FOUND') acc.notFound++;
    return acc;
  }, { enabled: 0, disabled: 0, error: 0, notFound: 0 });
  
  const logData = {
    batch: `${batchNumber}/${totalBatches}`,
    processed: results.length,
    summary
  };
  
  if (processingTime) {
    logData.processingTimeMs = processingTime;
  }
  
  logger.info('Batch completed', logData);
};

module.exports = {
  logger,
  logProgress,
  logError,
  logArnResult,
  logBatchSummary
};