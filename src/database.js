const sql = require('mssql');
const { config } = require('./config');
const { logger, logError } = require('./logger');

class DatabaseService {
  constructor() {
    this.pool = null;
    this.connected = false;
  }

  async connect() {
    try {
      logger.info('Connecting to MSSQL database...');
      this.pool = await sql.connect(config.database);
      this.connected = true;
      logger.info('Successfully connected to MSSQL database');
      return this.pool;
    } catch (error) {
      logError(error, { context: 'Database connection' });
      throw new Error(`Failed to connect to database: ${error.message}`);
    }
  }

  async disconnect() {
    try {
      if (this.pool) {
        await this.pool.close();
        this.connected = false;
        logger.info('Disconnected from MSSQL database');
      }
    } catch (error) {
      logError(error, { context: 'Database disconnection' });
    }
  }

  async executeQuery(query, params = {}) {
    try {
      if (!this.connected) {
        throw new Error('Database not connected');
      }

      const request = this.pool.request();
      
      // Add parameters to the request
      Object.entries(params).forEach(([key, value]) => {
        request.input(key, value);
      });

      const result = await request.query(query);
      return result;
    } catch (error) {
      logError(error, { context: 'Query execution', query, params });
      throw error;
    }
  }

  async getPushArns(tableName = null, arnColumn = null, idColumn = null, limit = null, resumeFromId = null) {
    try {
      // Use environment config values as defaults
      const sourceTable = tableName || config.sourceTable.tableName;
      const sourceArnColumn = arnColumn || config.sourceTable.arnColumn;
      const sourceIdColumn = idColumn || config.sourceTable.idColumn;
      
      logger.info(`Fetching push ARNs from table: ${sourceTable}, column: ${sourceArnColumn}`);
      
      let query = `SELECT ${sourceArnColumn}, ${sourceIdColumn} FROM ${sourceTable} WHERE ${sourceArnColumn} IS NOT NULL AND ${sourceArnColumn} != ''`;
      
      // Add resume capability - skip already processed records
      if (resumeFromId) {
        query += ` AND ${sourceIdColumn} > ${resumeFromId}`;
        logger.info(`Resuming from ID: ${resumeFromId}`);
      }
      // Note: Auto-resume is now handled at the service level with run IDs
      
      // Add ordering and limit
      query += ` ORDER BY ${sourceIdColumn}`;
      
      if (limit) {
        query += ` OFFSET 0 ROWS FETCH NEXT ${limit} ROWS ONLY`;
      }

      const result = await this.executeQuery(query);
      logger.info(`Found ${result.recordset.length} push ARNs to check`);
      
      return result.recordset.map(record => ({
        id: record[sourceIdColumn],
        arn: record[sourceArnColumn]
      }));
    } catch (error) {
      logError(error, { context: 'Fetching push ARNs' });
      throw error;
    }
  }

  async saveArnResult(arn, originalId, status, statusReason, errorMessage = null, metadata = {}) {
    try {
      const query = `
        INSERT INTO ${config.app.resultsTableName} 
        (original_id, arn, status, status_reason, error_message, metadata, checked_at)
        VALUES 
        (@originalId, @arn, @status, @statusReason, @errorMessage, @metadata, @checkedAt)
      `;

      const params = {
        originalId,
        arn,
        status,
        statusReason,
        errorMessage,
        metadata: JSON.stringify(metadata),
        checkedAt: new Date()
      };

      await this.executeQuery(query, params);
    } catch (error) {
      logError(error, { context: 'Saving ARN result', arn, originalId, status });
      throw error;
    }
  }

  async batchSaveArnResults(results) {
    try {
      if (!results || results.length === 0) {
        return;
      }

      // Only log database operations in development for performance
      if (process.env.NODE_ENV !== 'production') {
        logger.info(`Batch saving ${results.length} ARN results`);
      }

      const transaction = new sql.Transaction(this.pool);
      await transaction.begin();

      try {        
        for (const result of results) {
          const request = new sql.Request(transaction);
          await request
            .input('runId', result.runId)
            .input('batchId', result.batchId)
            .input('originalId', result.originalId)
            .input('arn', result.arn)
            .input('status', result.status)
            .input('statusReason', result.statusReason)
            .input('errorMessage', result.errorMessage)
            .input('metadata', JSON.stringify(result.metadata || {}))
            .input('checkedAt', new Date())
            .query(`
              INSERT INTO ${config.app.resultsTableName} 
              (run_id, batch_id, original_id, arn, status, status_reason, error_message, metadata, checked_at)
              VALUES 
              (@runId, @batchId, @originalId, @arn, @status, @statusReason, @errorMessage, @metadata, @checkedAt)
            `);
        }

        await transaction.commit();
        
        // Only log successful saves in development/staging
        if (process.env.NODE_ENV !== 'production') {
          logger.info(`Successfully saved ${results.length} ARN results`);
        }
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    } catch (error) {
      logError(error, { context: 'Batch saving ARN results', count: results.length });
      throw error;
    }
  }

  async createResultsTable() {
    try {
      const createTableQuery = `
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='${config.app.resultsTableName}' AND xtype='U')
        CREATE TABLE ${config.app.resultsTableName} (
          id BIGINT IDENTITY(1,1) PRIMARY KEY,
          run_id NVARCHAR(50) NOT NULL,
          batch_id INT NOT NULL,
          original_id BIGINT NOT NULL,
          arn NVARCHAR(500) NOT NULL,
          status NVARCHAR(50) NOT NULL,
          status_reason NVARCHAR(200),
          error_message NVARCHAR(MAX),
          metadata NVARCHAR(MAX),
          checked_at DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
          INDEX IX_${config.app.resultsTableName}_run_id (run_id),
          INDEX IX_${config.app.resultsTableName}_batch_id (batch_id),
          INDEX IX_${config.app.resultsTableName}_arn (arn),
          INDEX IX_${config.app.resultsTableName}_status (status),
          INDEX IX_${config.app.resultsTableName}_checked_at (checked_at),
          INDEX IX_${config.app.resultsTableName}_original_id (original_id)
        )
      `;

      // Also add columns if table exists but doesn't have new columns
      const alterTableQuery = `
        IF EXISTS (SELECT * FROM sysobjects WHERE name='${config.app.resultsTableName}' AND xtype='U')
        BEGIN
          IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${config.app.resultsTableName}') AND name = 'run_id')
            ALTER TABLE ${config.app.resultsTableName} ADD run_id NVARCHAR(50);
          
          IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('${config.app.resultsTableName}') AND name = 'batch_id')
            ALTER TABLE ${config.app.resultsTableName} ADD batch_id INT;
        END
      `;

      await this.executeQuery(createTableQuery);
      await this.executeQuery(alterTableQuery);
      logger.info(`Results table '${config.app.resultsTableName}' is ready with run tracking`);
    } catch (error) {
      logError(error, { context: 'Creating results table' });
      throw error;
    }
  }

  async getResultsTableStats(runId = null) {
    try {
      let query = `
        SELECT 
          COUNT(*) as total_records,
          COUNT(CASE WHEN status = 'ENABLED' THEN 1 END) as enabled_count,
          COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) as disabled_count,
          COUNT(CASE WHEN status = 'ERROR' THEN 1 END) as error_count,
          COUNT(CASE WHEN status = 'NOT_FOUND' THEN 1 END) as not_found_count,
          MIN(original_id) as first_processed_id,
          MAX(original_id) as last_processed_id,
          MIN(checked_at) as first_processed_at,
          MAX(checked_at) as last_processed_at,
          COUNT(DISTINCT run_id) as total_runs,
          COUNT(DISTINCT batch_id) as total_batches
        FROM ${config.app.resultsTableName}
      `;
      
      if (runId) {
        query += ` WHERE run_id = '${runId}'`;
      }

      const result = await this.executeQuery(query);
      return result.recordset[0];
    } catch (error) {
      logError(error, { context: 'Getting results table stats' });
      throw error;
    }
  }

  async getProcessingProgress(sourceTable, sourceIdColumn, runId = null) {
    try {
      // Get the latest run ID if not specified
      const latestRunQuery = runId ? 
        `SELECT '${runId}' as latest_run_id` : 
        `SELECT TOP 1 run_id as latest_run_id FROM ${config.app.resultsTableName} ORDER BY checked_at DESC`;
      
      const latestRunResult = await this.executeQuery(latestRunQuery);
      const latestRunId = latestRunResult.recordset[0]?.latest_run_id;
      
      if (!latestRunId) {
        return {
          total_source_records: 0,
          processed_records: 0,
          last_processed_id: 0,
          remaining_records: 0,
          total_runs: 0,
          latest_run_id: null,
          current_run_id: runId,
          progress_percent: 0
        };
      }

      const query = `
        WITH latest_run_stats AS (
          SELECT 
            COUNT(*) as latest_run_processed,
            MAX(original_id) as latest_run_last_id,
            MIN(original_id) as latest_run_first_id
          FROM ${config.app.resultsTableName} 
          WHERE run_id = '${latestRunId}'
        )
        SELECT 
          (SELECT COUNT(*) FROM ${sourceTable} WHERE ${sourceIdColumn} IS NOT NULL) as total_source_records,
          s.latest_run_processed as processed_records,
          s.latest_run_last_id as last_processed_id,
          s.latest_run_first_id as first_processed_id,
          (SELECT COUNT(*) FROM ${sourceTable} WHERE ${sourceIdColumn} > 
            ISNULL(s.latest_run_last_id, 0)) as remaining_records,
          (SELECT COUNT(DISTINCT run_id) FROM ${config.app.resultsTableName}) as total_runs,
          '${latestRunId}' as latest_run_id,
          s.latest_run_last_id - ISNULL(s.latest_run_first_id, 0) + 1 as latest_run_range
        FROM latest_run_stats s
      `;

      const result = await this.executeQuery(query);
      const stats = result.recordset[0];
      
      // Calculate progress as percentage of latest run's range vs total records
      const totalRecords = stats.total_source_records;
      const latestRunProcessed = stats.processed_records;
      
      stats.progress_percent = totalRecords > 0 ? 
        ((latestRunProcessed / totalRecords) * 100).toFixed(2) : 0;
      stats.current_run_id = latestRunId;
        
      return stats;
    } catch (error) {
      logError(error, { context: 'Getting processing progress' });
      throw error;
    }
  }

  async getRunList() {
    try {
      const query = `
        SELECT 
          run_id,
          COUNT(*) as processed_records,
          MIN(checked_at) as started_at,
          MAX(checked_at) as last_activity,
          MIN(original_id) as first_id,
          MAX(original_id) as last_id,
          COUNT(CASE WHEN status = 'ENABLED' THEN 1 END) as enabled_count,
          COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) as disabled_count,
          COUNT(CASE WHEN status = 'ERROR' THEN 1 END) as error_count
        FROM ${config.app.resultsTableName}
        GROUP BY run_id
        ORDER BY started_at DESC
      `;

      const result = await this.executeQuery(query);
      return result.recordset;
    } catch (error) {
      logError(error, { context: 'Getting run list' });
      throw error;
    }
  }

  async canResumeRun(runId, sourceTable, sourceIdColumn) {
    try {
      const query = `
        SELECT 
          (SELECT COUNT(*) FROM ${sourceTable} WHERE ${sourceIdColumn} IS NOT NULL) as total_source_records,
          (SELECT COUNT(*) FROM ${config.app.resultsTableName} WHERE run_id = '${runId}') as processed_records,
          (SELECT MAX(original_id) FROM ${config.app.resultsTableName} WHERE run_id = '${runId}') as last_processed_id
      `;

      const result = await this.executeQuery(query);
      const stats = result.recordset[0];
      
      return {
        canResume: stats.processed_records < stats.total_source_records,
        lastProcessedId: stats.last_processed_id,
        processedRecords: stats.processed_records,
        totalRecords: stats.total_source_records
      };
    } catch (error) {
      logError(error, { context: 'Checking if run can be resumed' });
      throw error;
    }
  }
}

module.exports = DatabaseService;