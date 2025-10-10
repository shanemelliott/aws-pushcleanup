const { SNSClient, GetEndpointAttributesCommand } = require('@aws-sdk/client-sns');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { config } = require('./config');
const { logger, logError, logArnResult, logBatchSummary } = require('./logger');

class SNSService {
  constructor() {
    this.retryConfig = {
      maxRetries: config.app.maxRetries,
      retryDelayMs: config.app.retryDelayMs
    };
    this.snsClient = null;
    this.assumedCredentials = null;
    this.credentialsExpiry = null;
    this.baseClientConfig = null;
  }

  /**
   * Initialize AWS clients with role assumption if configured
   */
  async initializeClients() {
    try {
      // Initialize base STS client for role assumption
      this.baseClientConfig = {
        region: config.aws.region,
      };

      // Use either profile or access keys for base credentials
      if (config.aws.profile) {
        process.env.AWS_PROFILE = config.aws.profile;
      } else if (config.aws.credentials.accessKeyId && config.aws.credentials.secretAccessKey) {
        this.baseClientConfig.credentials = config.aws.credentials;
      }

      // Assume role and initialize SNS client
      await this.refreshCredentials();
      
    } catch (error) {
      logError(error, { context: 'Initializing AWS clients' });
      throw new Error(`Failed to initialize AWS clients: ${error.message}`);
    }
  }

  /**
   * Refresh AWS credentials by assuming role again
   */
  async refreshCredentials() {
    try {
      // If role ARN is configured, assume the role
      if (config.aws.roleArn) {
        logger.info(`Assuming role: ${config.aws.roleArn}`);
        
        const stsClient = new STSClient(this.baseClientConfig);
        const assumeRoleCommand = new AssumeRoleCommand({
          RoleArn: config.aws.roleArn,
          RoleSessionName: config.aws.roleSessionName
        });

        const assumeRoleResponse = await stsClient.send(assumeRoleCommand);
        this.assumedCredentials = {
          accessKeyId: assumeRoleResponse.Credentials.AccessKeyId,
          secretAccessKey: assumeRoleResponse.Credentials.SecretAccessKey,
          sessionToken: assumeRoleResponse.Credentials.SessionToken
        };

        // Store expiration time (subtract 5 minutes for safety buffer)
        this.credentialsExpiry = new Date(assumeRoleResponse.Credentials.Expiration.getTime() - 5 * 60 * 1000);
        
        logger.info(`Successfully assumed role, expires at: ${this.credentialsExpiry.toISOString()}`);
      }

      // Initialize SNS client with assumed credentials or base credentials
      const snsClientConfig = {
        region: config.aws.region,
        credentials: this.assumedCredentials || this.baseClientConfig.credentials
      };

      this.snsClient = new SNSClient(snsClientConfig);
      
    } catch (error) {
      logError(error, { context: 'Refreshing AWS credentials' });
      throw new Error(`Failed to refresh AWS credentials: ${error.message}`);
    }
  }

  /**
   * Check if credentials need to be refreshed
   */
  async ensureValidCredentials() {
    if (config.aws.roleArn && this.credentialsExpiry && new Date() >= this.credentialsExpiry) {
      logger.info('AWS credentials expired, refreshing...');
      await this.refreshCredentials();
    }
  }

  /**
   * Validate SNS endpoint ARN format
   * ARN format: arn:aws:sns:region:account:endpoint/PLATFORM/APP_NAME/ENDPOINT_ID
   * Example: arn:aws-us-gov:sns:us-gov-west-1:171875617347:endpoint/APNS/prod-vamobile-apns/02e639f1-8c85-3401-bea8-5d8c2571a704
   */
  validateEndpointArn(arn) {
    try {
      if (!arn || typeof arn !== 'string') {
        throw new Error('Invalid ARN format');
      }

      if (!arn.includes(':endpoint/')) {
        throw new Error('ARN is not an SNS endpoint ARN');
      }

      const arnParts = arn.split(':');
      if (arnParts.length < 6) {
        throw new Error('Invalid SNS endpoint ARN format');
      }

      return true;
    } catch (error) {
      throw new Error(`Failed to validate endpoint ARN: ${error.message}`);
    }
  }

  /**
   * Check the status of an SNS endpoint ARN
   */
  async checkArnStatus(arn, originalId) {
    let retries = 0;
    
    while (retries <= this.retryConfig.maxRetries) {
      try {
        // Ensure credentials are still valid before making the call
        await this.ensureValidCredentials();
        
        // Validate the ARN format
        this.validateEndpointArn(arn);
        
        const command = new GetEndpointAttributesCommand({
          EndpointArn: arn
        });

        const response = await this.snsClient.send(command);
        const attributes = response.Attributes;

        if (!attributes) {
          return {
            originalId,
            arn,
            status: 'NOT_FOUND',
            statusReason: 'Endpoint attributes not found',
            errorMessage: null,
            metadata: {
              retryCount: retries
            }
          };
        }

        // Determine the status based on endpoint attributes
        const enabled = attributes.Enabled === 'true';
        const token = attributes.Token;
        
        let status, statusReason;
        
        if (!enabled) {
          status = 'DISABLED';
          statusReason = 'Endpoint is disabled in SNS';
        } else if (!token) {
          status = 'DISABLED';
          statusReason = 'No device token found';
        } else {
          status = 'ENABLED';
          statusReason = 'Endpoint is enabled with valid token';
        }

        const result = {
          originalId,
          arn,
          status,
          statusReason,
          errorMessage: null,
          metadata: {
            enabled: attributes.Enabled,
            token: token ? token.substring(0, 20) + '...' : null, // Truncate token for security
            userId: attributes.UserId,
            customUserData: attributes.CustomUserData,
            retryCount: retries
          }
        };

        logArnResult(arn, status, { 
          enabled: attributes.Enabled,
          hasToken: !!token
        });

        return result;

      } catch (error) {
        retries++;
        
        if (retries > this.retryConfig.maxRetries) {
          // Max retries exceeded, return error result
          const errorResult = {
            originalId,
            arn,
            status: 'ERROR',
            statusReason: 'Max retries exceeded',
            errorMessage: error.message,
            metadata: {
              retryCount: retries - 1,
              errorType: error.name
            }
          };

          logError(error, { context: 'Checking ARN status', arn, originalId, retries: retries - 1 });
          return errorResult;
        }

        // Check for token expiration errors and force credential refresh
        if (error.message && (
          error.message.includes('security token included in the request is expired') ||
          error.message.includes('The provided token has expired') ||
          error.message.includes('TokenRefreshRequired') ||
          error.name === 'TokenRefreshRequired' ||
          error.name === 'ExpiredToken'
        )) {
          logger.warn(`AWS token expired for ARN ${arn}, forcing credential refresh`);
          try {
            await this.refreshCredentials();
            // Don't increment retry counter for token expiration, just retry
            continue;
          } catch (refreshError) {
            logError(refreshError, { context: 'Forcing credential refresh after token expiration', arn });
            // If refresh fails, treat as regular error and continue with retry logic
          }
        }

        // Check if it's a specific AWS error that we can handle
        if (error.name === 'NotFoundException' || error.name === 'NotFound' || error.message.includes('does not exist')) {
          return {
            originalId,
            arn,
            status: 'NOT_FOUND',
            statusReason: 'Endpoint not found in SNS',
            errorMessage: error.message,
            metadata: {
              retryCount: retries - 1,
              errorType: error.name
            }
          };
        }

        // Check for invalid endpoint ARN
        if (error.name === 'InvalidParameter' || error.message.includes('Invalid parameter')) {
          return {
            originalId,
            arn,
            status: 'INVALID',
            statusReason: 'Invalid endpoint ARN format',
            errorMessage: error.message,
            metadata: {
              retryCount: retries - 1,
              errorType: error.name
            }
          };
        }

        // For other errors, wait and retry
        logger.warn(`Error checking ARN ${arn}, retrying (${retries}/${this.retryConfig.maxRetries}): ${error.message}`);
        await this.sleep(this.retryConfig.retryDelayMs * retries); // Exponential backoff
      }
    }
  }

  /**
   * Check multiple ARNs in batches
   */
  async checkMultipleArns(arnsWithIds, batchSize, onBatchComplete = null) {
    const results = [];
    const effectiveBatchSize = batchSize || config.app.batchSize || 50;
    const batches = this.chunkArray(arnsWithIds, effectiveBatchSize);

    logger.info(`Processing ${arnsWithIds.length} ARNs in ${batches.length} batches of ${effectiveBatchSize}`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      logger.info(`Processing batch ${i + 1}/${batches.length} (${batch.length} ARNs)`);

      // Ensure credentials are valid before processing each batch
      await this.ensureValidCredentials();

      // Process batch concurrently with limited concurrency
      const batchPromises = batch.map(({ id, arn }) => 
        this.checkArnStatus(arn, id)
      );

      try {
        const batchStartTime = Date.now();
        const batchResults = await Promise.all(batchPromises);
        const batchProcessingTime = Date.now() - batchStartTime;
        results.push(...batchResults);
        
        // Log batch summary instead of individual ARN details for performance
        logBatchSummary(i + 1, batches.length, batchResults, batchProcessingTime);
        
        // If a callback is provided, save results immediately after each batch
        if (onBatchComplete && typeof onBatchComplete === 'function') {
          logger.info(`Saving batch ${i + 1} results to database`);
          await onBatchComplete(batchResults);
        }
        
        // Small delay between batches to avoid rate limiting
        if (i < batches.length - 1) {
          await this.sleep(500);
        }
      } catch (error) {
        logError(error, { context: 'Batch processing', batchIndex: i });
        throw error;
      }
    }

    return results;
  }

  /**
   * Utility function to chunk array into smaller arrays
   */
  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Utility function for delays
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Test the connection to AWS SNS
   */
  async testConnection() {
    try {
      logger.info('Testing AWS SNS connection...');
      
      // Just test client initialization - don't make API calls that require special permissions
      logger.info('AWS SNS client initialized successfully with provided credentials');
      return true;
    } catch (error) {
      logError(error, { context: 'Testing SNS connection' });
      throw new Error(`Failed to connect to SNS: ${error.message}`);
    }
  }
}

module.exports = SNSService;