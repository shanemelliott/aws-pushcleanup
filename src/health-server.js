#!/usr/bin/env node

/**
 * Health Check Server for AWS ARN Cleanup Tool
 * Provides HTTP endpoints to monitor cleanup progress and status
 */

const http = require('http');
const url = require('url');
const { config } = require('./config');
const DatabaseService = require('./database');
const { logger } = require('./logger');

class HealthCheckServer {
  constructor(port = 3000) {
    this.port = port;
    this.db = new DatabaseService();
    this.server = null;
  }

  async initialize() {
    await this.db.connect();
    logger.info('Health check server database connected');
  }

  async getProcessingProgress() {
    try {
      const sourceTable = config.sourceTable.tableName;
      const sourceIdColumn = config.sourceTable.idColumn;
      
      const progress = await this.db.getProcessingProgress(sourceTable, sourceIdColumn);
      return {
        success: true,
        data: {
          totalRecords: progress.total_source_records,
          processedRecords: progress.processed_records,
          remainingRecords: progress.remaining_records,
          progressPercent: progress.progress_percent,
          latestRunId: progress.latest_run_id,
          currentRunId: progress.current_run_id,
          totalRuns: progress.total_runs,
          lastProcessedId: progress.last_processed_id
        }
      };
    } catch (error) {
      logger.error('Failed to get processing progress', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getLatestRunStats() {
    try {
      const query = `
        SELECT 
          run_id,
          COUNT(*) as total_processed,
          COUNT(CASE WHEN status = 'ENABLED' THEN 1 END) as enabled_count,
          COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) as disabled_count,
          COUNT(CASE WHEN status = 'ERROR' THEN 1 END) as error_count,
          COUNT(CASE WHEN status = 'NOT_FOUND' THEN 1 END) as not_found_count,
          MIN(checked_at) as started_at,
          MAX(checked_at) as last_updated,
          MAX(batch_id) as latest_batch
        FROM ${config.app.resultsTableName}
        WHERE run_id = (
          SELECT TOP 1 run_id 
          FROM ${config.app.resultsTableName} 
          ORDER BY checked_at DESC
        )
        GROUP BY run_id
      `;

      const result = await this.db.executeQuery(query);
      const stats = result.recordset[0];

      return {
        success: true,
        data: stats || null
      };
    } catch (error) {
      logger.error('Failed to get latest run stats', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAllRunsSummary() {
    try {
      const query = `
        SELECT 
          run_id,
          COUNT(*) as records_processed,
          COUNT(CASE WHEN status = 'ENABLED' THEN 1 END) as enabled,
          COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) as disabled,
          COUNT(CASE WHEN status = 'ERROR' THEN 1 END) as errors,
          MIN(checked_at) as started_at,
          MAX(checked_at) as completed_at,
          DATEDIFF(SECOND, MIN(checked_at), MAX(checked_at)) as duration_seconds
        FROM ${config.app.resultsTableName}
        GROUP BY run_id
        ORDER BY MIN(checked_at) DESC
      `;

      const result = await this.db.executeQuery(query);

      return {
        success: true,
        data: result.recordset
      };
    } catch (error) {
      logger.error('Failed to get runs summary', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async handleRequest(req, res) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    try {
      let response;

      switch (pathname) {
        case '/health':
          response = {
            success: true,
            message: 'AWS ARN Cleanup Health Check',
            timestamp: new Date().toISOString(),
            environment: process.env.NODE_ENV || 'development',
            uptime: process.uptime()
          };
          break;

        case '/progress':
          response = await this.getProcessingProgress();
          break;

        case '/stats':
        case '/stats/latest':
          response = await this.getLatestRunStats();
          break;

        case '/stats/all':
        case '/runs':
          response = await this.getAllRunsSummary();
          break;

        case '/status':
          const progress = await this.getProcessingProgress();
          const stats = await this.getLatestRunStats();
          response = {
            success: true,
            data: {
              progress: progress.data,
              latestRun: stats.data,
              serverInfo: {
                environment: process.env.NODE_ENV || 'development',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                timestamp: new Date().toISOString()
              }
            }
          };
          break;

        default:
          response = {
            success: false,
            error: 'Endpoint not found',
            availableEndpoints: [
              '/health - Server health check',
              '/progress - Current processing progress',
              '/stats - Latest run statistics',
              '/stats/all - All runs summary',
              '/status - Complete status overview'
            ]
          };
          res.statusCode = 404;
      }

      res.end(JSON.stringify(response, null, 2));

    } catch (error) {
      logger.error('Request handling error', error);
      res.statusCode = 500;
      res.end(JSON.stringify({
        success: false,
        error: 'Internal server error',
        message: error.message
      }, null, 2));
    }
  }

  async start() {
    try {
      await this.initialize();

      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.listen(this.port, () => {
        logger.info(`Health check server running on port ${this.port}`);
        console.log(`🩺 Health Check Server Started`);
        console.log(`📊 Available endpoints:`);
        console.log(`   http://localhost:${this.port}/health`);
        console.log(`   http://localhost:${this.port}/progress`);
        console.log(`   http://localhost:${this.port}/stats`);
        console.log(`   http://localhost:${this.port}/status`);
        console.log(`   http://localhost:${this.port}/runs`);
      });

      // Graceful shutdown
      process.on('SIGINT', () => {
        console.log('\n🛑 Shutting down health check server...');
        this.server.close(() => {
          console.log('✅ Server closed');
          process.exit(0);
        });
      });

    } catch (error) {
      logger.error('Failed to start health check server', error);
      process.exit(1);
    }
  }
}

// Command line interface
if (require.main === module) {
  const port = process.argv[2] || process.env.HEALTH_CHECK_PORT || 3000;
  const server = new HealthCheckServer(port);
  server.start();
}

module.exports = HealthCheckServer;