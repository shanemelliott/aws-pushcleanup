/**
 * AWS SNS ARN Cleanup Script
 * Deletes disabled ARNs identified by the cleanup analysis
 * 
 * Usage:
 *   NODE_ENV=production node src/arn-cleanup.js --run-id run-2025-10-07T18-30-15-u0qn
 *   NODE_ENV=production node src/arn-cleanup.js --run-id run-2025-10-07T18-30-15-u0qn --batch-size 100 --limit 1000
 */

const { SNSClient, DeleteEndpointCommand } = require('@aws-sdk/client-sns');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const sql = require('mssql');
const winston = require('winston');
const path = require('path');

// Load environment configuration
require('dotenv').config({
  path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env'
});

class ARNCleanupService {
  constructor() {
    this.snsClient = null;
    this.db = null;
    this.logger = this.setupLogger();
    this.batchSize = parseInt(process.argv.find(arg => arg.startsWith('--batch-size='))?.split('=')[1]) || 50;
    this.limit = parseInt(process.argv.find(arg => arg.startsWith('--limit='))?.split('=')[1]) || null;
    this.runId = process.argv.find(arg => arg.startsWith('--run-id='))?.split('=')[1];
    this.dryRun = process.argv.includes('--dry-run');
    
    // Statistics tracking
    this.stats = {
      totalProcessed: 0,
      deleted: 0,
      alreadyDeleted: 0,
      errors: 0,
      startTime: new Date()
    };
  }

  setupLogger() {
    const logFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    );

    return winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: logFormat,
      transports: [
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
          )
        }),
        new winston.transports.File({ 
          filename: path.join(__dirname, '..', 'logs', 'arn-cleanup.log'),
          maxsize: 10485760, // 10MB
          maxFiles: 5
        })
      ]
    });
  }

  async initializeAWS() {
    try {
      const stsClient = new STSClient({ region: process.env.AWS_REGION });
      
      // Assume role for SNS access
      const assumeRoleCommand = new AssumeRoleCommand({
        RoleArn: process.env.AWS_ROLE_ARN,
        RoleSessionName: process.env.AWS_ROLE_SESSION_NAME || 'arn-cleanup-session',
        DurationSeconds: 3600
      });

      const { Credentials } = await stsClient.send(assumeRoleCommand);
      
      this.snsClient = new SNSClient({
        region: process.env.AWS_REGION,
        credentials: {
          accessKeyId: Credentials.AccessKeyId,
          secretAccessKey: Credentials.SecretAccessKey,
          sessionToken: Credentials.SessionToken
        }
      });

      this.logger.info('AWS SNS client initialized successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize AWS client:', error);
      throw error;
    }
  }

  async initializeDatabase() {
    try {
      const config = {
        server: process.env.DB_SERVER,
        database: process.env.DB_DATABASE,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: parseInt(process.env.DB_PORT) || 1433,
        options: {
          encrypt: process.env.DB_ENCRYPT === 'true',
          trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true'
        }
      };

      this.db = await sql.connect(config);
      this.logger.info('Database connection established');
      return true;
    } catch (error) {
      this.logger.error('Database connection failed:', error);
      throw error;
    }
  }

  async getDisabledARNs() {
    try {
      let query = `
        SELECT 
          cr.id,
          cr.original_id,
          cr.arn,
          mc.personId,
          mc.createdDate
        FROM CDW_push_arn_cleanup_results cr
        INNER JOIN smsMobileClient mc ON mc.id = cr.original_id
        WHERE cr.run_id = @runId 
        AND cr.status = 'DISABLED'
        ORDER BY cr.id
      `;

      if (this.limit) {
        query = `SELECT TOP ${this.limit} * FROM (${query}) limited_results`;
      }

      const request = this.db.request();
      request.input('runId', sql.NVarChar, this.runId);
      
      const result = await request.query(query);
      
      this.logger.info(`Retrieved ${result.recordset.length} disabled ARNs for cleanup`);
      return result.recordset;
    } catch (error) {
      this.logger.error('Failed to retrieve disabled ARNs:', error);
      throw error;
    }
  }

  async deleteARNBatch(arnBatch) {
    const results = [];
    
    for (const record of arnBatch) {
      try {
        if (this.dryRun) {
          this.logger.info(`[DRY RUN] Would delete ARN: ${record.arn}`);
          results.push({ 
            ...record, 
            status: 'DRY_RUN_SUCCESS',
            error: null 
          });
          continue;
        }

        const deleteCommand = new DeleteEndpointCommand({
          EndpointArn: record.arn
        });

        await this.snsClient.send(deleteCommand);
        
        results.push({ 
          ...record, 
          status: 'DELETED',
          error: null 
        });
        
        this.stats.deleted++;
        this.logger.debug(`Deleted ARN: ${record.arn}`);
        
      } catch (error) {
        let status = 'ERROR';
        
        // Handle specific AWS SNS errors
        if (error.name === 'NotFound' || error.message?.includes('does not exist')) {
          status = 'ALREADY_DELETED';
          this.stats.alreadyDeleted++;
          this.logger.debug(`ARN already deleted: ${record.arn}`);
        } else {
          this.stats.errors++;
          this.logger.error(`Failed to delete ARN ${record.arn}:`, error.message);
        }
        
        results.push({ 
          ...record, 
          status: status,
          error: error.message 
        });
      }
      
      this.stats.totalProcessed++;
    }
    
    return results;
  }

  async saveBatchResults(batchResults) {
    try {
      const table = new sql.Table('CDW_arn_cleanup_deletion_results');
      table.create = true;
      table.columns.add('cleanup_result_id', sql.BigInt, { nullable: false });
      table.columns.add('original_id', sql.BigInt, { nullable: false });
      table.columns.add('arn', sql.NVarChar(500), { nullable: false });
      table.columns.add('person_id', sql.BigInt, { nullable: true });
      table.columns.add('deletion_status', sql.NVarChar(50), { nullable: false });
      table.columns.add('error_message', sql.NVarChar(sql.MAX), { nullable: true });
      table.columns.add('deleted_at', sql.DateTime2, { nullable: false });

      for (const result of batchResults) {
        table.rows.add(
          result.id,
          result.original_id,
          result.arn,
          result.personId,
          result.status,
          result.error,
          new Date()
        );
      }

      const request = this.db.request();
      await request.bulk(table);
      
      this.logger.debug(`Saved ${batchResults.length} deletion results to database`);
    } catch (error) {
      this.logger.error('Failed to save batch results:', error);
      // Don't throw - continue with cleanup even if logging fails
    }
  }

  async refreshAWSCredentials() {
    try {
      this.logger.info('Refreshing AWS credentials...');
      await this.initializeAWS();
      this.logger.info('AWS credentials refreshed successfully');
    } catch (error) {
      this.logger.error('Failed to refresh AWS credentials:', error);
      throw error;
    }
  }

  async processCleanup() {
    try {
      if (!this.runId) {
        throw new Error('Run ID is required. Use --run-id=your-run-id');
      }

      this.logger.info('Starting ARN cleanup process', {
        runId: this.runId,
        batchSize: this.batchSize,
        limit: this.limit,
        dryRun: this.dryRun
      });

      // Initialize connections
      await this.initializeDatabase();
      await this.initializeAWS();

      // Get all disabled ARNs
      const disabledARNs = await this.getDisabledARNs();
      
      if (disabledARNs.length === 0) {
        this.logger.info('No disabled ARNs found for cleanup');
        return;
      }

      this.logger.info(`Processing ${disabledARNs.length} disabled ARNs in batches of ${this.batchSize}`);

      // Process in batches
      const totalBatches = Math.ceil(disabledARNs.length / this.batchSize);
      let credentialRefreshCounter = 0;

      for (let i = 0; i < disabledARNs.length; i += this.batchSize) {
        const batch = disabledARNs.slice(i, i + this.batchSize);
        const batchNumber = Math.floor(i / this.batchSize) + 1;
        
        this.logger.info(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} ARNs)`);

        // Refresh credentials every 50 batches (~45 minutes)
        if (credentialRefreshCounter >= 50) {
          await this.refreshAWSCredentials();
          credentialRefreshCounter = 0;
        }

        const batchResults = await this.deleteARNBatch(batch);
        await this.saveBatchResults(batchResults);

        credentialRefreshCounter++;

        // Progress update
        const progress = ((i + batch.length) / disabledARNs.length * 100).toFixed(2);
        this.logger.info(`Progress: ${progress}% (${this.stats.totalProcessed}/${disabledARNs.length})`);

        // Small delay between batches to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      this.logFinalStats();

    } catch (error) {
      this.logger.error('ARN cleanup process failed:', error);
      throw error;
    }
  }

  logFinalStats() {
    const duration = new Date() - this.stats.startTime;
    const durationMinutes = (duration / 1000 / 60).toFixed(2);
    
    this.logger.info('ARN cleanup completed!', {
      totalProcessed: this.stats.totalProcessed,
      deleted: this.stats.deleted,
      alreadyDeleted: this.stats.alreadyDeleted,
      errors: this.stats.errors,
      duration: `${durationMinutes} minutes`,
      successRate: `${((this.stats.deleted + this.stats.alreadyDeleted) / this.stats.totalProcessed * 100).toFixed(2)}%`
    });
  }

  async cleanup() {
    try {
      if (this.db) {
        await sql.close();
        this.logger.info('Database connection closed');
      }
    } catch (error) {
      this.logger.error('Error during cleanup:', error);
    }
  }
}

// Main execution
async function main() {
  const service = new ARNCleanupService();
  
  try {
    await service.processCleanup();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await service.cleanup();
  }
}

// Handle graceful shutdowns
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...');
  process.exit(0);
});

if (require.main === module) {
  main();
}

module.exports = ARNCleanupService;