// Load environment-specific configuration
const environment = process.env.NODE_ENV || process.env.ENVIRONMENT || 'staging';
const envFile = `.env.${environment}`;

require('dotenv').config({ path: envFile });

// Fallback to default .env if environment-specific file doesn't exist
if (!require('fs').existsSync(envFile)) {
  require('dotenv').config();
}

const config = {
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    profile: process.env.AWS_PROFILE,
    roleArn: process.env.AWS_ROLE_ARN,
    roleSessionName: process.env.AWS_ROLE_SESSION_NAME || 'sns-cleanup-session',
  },
  database: {
    server: process.env.DB_SERVER,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT) || 1433,
    options: {
      encrypt: process.env.DB_ENCRYPT === 'true',
      trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true',
      requestTimeout: 30000,
      connectionTimeout: 30000,
    },
  },
  app: {
    batchSize: parseInt(process.env.BATCH_SIZE) || 100,
    logLevel: process.env.LOG_LEVEL || 'info',
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    retryDelayMs: parseInt(process.env.RETRY_DELAY_MS) || 1000,
    resultsTableName: process.env.RESULTS_TABLE_NAME || 'CDW_push_arn_cleanup_results',
    environment: process.env.ENVIRONMENT || environment || 'staging',
  },
  sourceTable: {
    tableName: process.env.SOURCE_TABLE_NAME || 'push_notifications',
    arnColumn: process.env.SOURCE_ARN_COLUMN || 'arn',
    idColumn: process.env.SOURCE_ID_COLUMN || 'id',
  },
};

// Validate required configuration
const validateConfig = () => {
  const required = [
    'database.server',
    'database.database',
    'database.user',
    'database.password',
  ];

  for (const path of required) {
    const value = path.split('.').reduce((obj, key) => obj && obj[key], config);
    if (!value) {
      throw new Error(`Missing required configuration: ${path}`);
    }
  }

  // Validate AWS credentials (either access keys or profile)
  if (!config.aws.profile && (!config.aws.credentials.accessKeyId || !config.aws.credentials.secretAccessKey)) {
    throw new Error('AWS credentials must be provided either via AWS_PROFILE or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY');
  }
};

module.exports = { config, validateConfig };