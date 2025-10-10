#!/usr/bin/env node

const { config, validateConfig } = require('./config');
const { logger, logProgress, logError } = require('./logger');
const DatabaseService = require('./database');
const SNSService = require('./pinpoint'); // File is still named pinpoint.js but now contains SNSService

class ArnCleanupService {
  constructor() {
    this.db = new DatabaseService();
    this.sns = new SNSService();
    this.runId = this.generateRunId();
    this.batchCounter = 0;
  }

  generateRunId() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const random = Math.random().toString(36).substring(2, 6);
    return `run-${timestamp}-${random}`;
  }

  async initialize() {
    try {
      // Validate configuration
      validateConfig();
      
      // Connect to database
      await this.db.connect();
      
      // Create results table if it doesn't exist
      await this.db.createResultsTable();
      
      // Initialize AWS clients (including role assumption if configured)
      await this.sns.initializeClients();
      
      // Test AWS connection
      await this.sns.testConnection();
      
      logger.info('Initialization completed successfully');
    } catch (error) {
      logError(error, { context: 'Initialization' });
      throw error;
    }
  }

  async autoBatchCleanup(options = {}) {
    const startTime = Date.now();
    const chunkSize = 5000; // Process 5000 records at a time
    let totalProcessed = 0;
    let overallResults = {
      enabled: 0,
      disabled: 0,
      error: 0,
      not_found: 0
    };

    const {
      sourceTable = config.sourceTable.tableName,
      arnColumn = config.sourceTable.arnColumn,
      idColumn = config.sourceTable.idColumn
    } = options;

    // Get total remaining records for progress tracking
    const progress = await this.db.getProcessingProgress(sourceTable, idColumn, this.runId);
    const totalRemaining = progress.remaining_records;
    
    console.log(`\n🚀 Starting auto-batch processing of ${totalRemaining.toLocaleString()} remaining records`);
    console.log(`📦 Processing in chunks of ${chunkSize.toLocaleString()} records\n`);

    let lastProcessedId = options.resumeFromId || null;
    let chunkNumber = 1;

    while (true) {
      console.log(`\n📊 Processing chunk ${chunkNumber} (${chunkSize.toLocaleString()} records)...`);
      
      // Process one chunk
      const chunkOptions = {
        ...options,
        limit: chunkSize,
        resumeFromId: lastProcessedId,
        autoBatch: false // Prevent recursion
      };

      const chunkResult = await this.cleanup(chunkOptions);
      
      // Accumulate results
      totalProcessed += chunkResult.totalProcessed;
      Object.keys(overallResults).forEach(key => {
        overallResults[key] += (chunkResult.results[key] || 0);
      });

      console.log(`✅ Chunk ${chunkNumber} completed: ${chunkResult.totalProcessed} records processed`);
      console.log(`   📈 Progress: ${totalProcessed.toLocaleString()}/${totalRemaining.toLocaleString()} (${(totalProcessed/totalRemaining*100).toFixed(1)}%)`);

      // Check if we're done
      if (chunkResult.totalProcessed < chunkSize) {
        console.log(`\n🎉 Auto-batch processing completed! Processed all remaining records.`);
        break;
      }

      // Update lastProcessedId for next iteration
      const updatedProgress = await this.db.getProcessingProgress(sourceTable, idColumn, this.runId);
      lastProcessedId = updatedProgress.last_processed_id;
      chunkNumber++;

      // Small pause between chunks to prevent overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return {
      totalProcessed,
      results: overallResults,
      duration: Date.now() - startTime
    };
  }

  async cleanup(options = {}) {
    const startTime = Date.now();
    
    try {
      logger.info('Starting ARN cleanup process');
      
      const {
        sourceTable = config.sourceTable.tableName,
        arnColumn = config.sourceTable.arnColumn,
        idColumn = config.sourceTable.idColumn,
        limit = null,
        batchSize = null,
        autoBatch = false
      } = options;

      // If autoBatch is enabled, process all remaining records in chunks
      if (autoBatch) {
        return await this.autoBatchCleanup(options);
      }

      // Handle resume logic
      if (options.resumeRunId) {
        this.runId = options.resumeRunId;
        const resumeInfo = await this.db.canResumeRun(this.runId, sourceTable, idColumn);
        if (!resumeInfo.canResume) {
          throw new Error(`Run ${this.runId} is already complete or doesn't exist`);
        }
        options.resumeFromId = resumeInfo.lastProcessedId;
        logger.info(`Resuming run ${this.runId} from ID ${resumeInfo.lastProcessedId}`);
      }
      
      logger.info(`Starting cleanup with Run ID: ${this.runId}`);
      
      // Check for existing progress
      const progress = await this.db.getProcessingProgress(sourceTable, idColumn, this.runId);
      logger.info('Processing progress', progress);
      
      // Fetch ARNs from the database (with auto-resume capability)
      logger.info(`Fetching ARNs from table: ${sourceTable}, column: ${arnColumn}, id column: ${idColumn}`);
      const arnsToCheck = await this.db.getPushArns(sourceTable, arnColumn, idColumn, limit, options.resumeFromId);
      
      if (arnsToCheck.length === 0) {
        logger.info('No ARNs found to check');
        return {
          totalProcessed: 0,
          results: {},
          duration: Date.now() - startTime
        };
      }

      logger.info(`Found ${arnsToCheck.length} ARNs to process`);

      // Create callback to save results after each batch
      const saveCallback = async (batchResults) => {
        try {
          // Add run tracking to each result
          this.batchCounter++;
          const enrichedResults = batchResults.map(result => ({
            ...result,
            runId: this.runId,
            batchId: this.batchCounter
          }));
          await this.db.batchSaveArnResults(enrichedResults);
        } catch (error) {
          logger.error('Failed to save batch results to database', { error: error.message });
          throw error;
        }
      };

      // Check ARNs with SNS, saving results as we go
      const results = await this.sns.checkMultipleArns(
        arnsToCheck, 
        batchSize,
        saveCallback
      );

      // Generate summary
      const summary = this.generateSummary(results);
      const duration = Date.now() - startTime;

      logger.info('ARN cleanup process completed', {
        totalProcessed: results.length,
        duration: `${(duration / 1000).toFixed(2)}s`,
        summary
      });

      return {
        totalProcessed: results.length,
        results: summary,
        duration
      };

    } catch (error) {
      logError(error, { context: 'Cleanup process' });
      throw error;
    }
  }

  generateSummary(results) {
    const summary = {
      enabled: 0,
      disabled: 0,
      error: 0,
      not_found: 0
    };

    results.forEach(result => {
      switch (result.status) {
        case 'ENABLED':
          summary.enabled++;
          break;
        case 'DISABLED':
          summary.disabled++;
          break;
        case 'ERROR':
          summary.error++;
          break;
        case 'NOT_FOUND':
          summary.not_found++;
          break;
      }
    });

    return summary;
  }

  async getStats(runId = null) {
    try {
      const stats = await this.db.getResultsTableStats(runId);
      logger.info('Current cleanup statistics', stats);
      return stats;
    } catch (error) {
      logError(error, { context: 'Getting stats' });
      throw error;
    }
  }

  async listRuns() {
    try {
      const runs = await this.db.getRunList();
      logger.info(`Found ${runs.length} cleanup runs`);
      return runs;
    } catch (error) {
      logError(error, { context: 'Listing runs' });
      throw error;
    }
  }

  async getProgress(sourceTable = null, sourceIdColumn = null, runId = null) {
    try {
      const table = sourceTable || config.sourceTable.tableName;
      const idCol = sourceIdColumn || config.sourceTable.idColumn;
      const progress = await this.db.getProcessingProgress(table, idCol, runId);
      logger.info('Processing progress', progress);
      return progress;
    } catch (error) {
      logError(error, { context: 'Getting progress' });
      throw error;
    }
  }

  async shutdown() {
    try {
      await this.db.disconnect();
      logger.info('Cleanup service shutdown completed');
    } catch (error) {
      logError(error, { context: 'Shutdown' });
    }
  }
}

// CLI interface
async function main() {
  const service = new ArnCleanupService();
  
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);
    const options = {};
    
    // Simple argument parsing
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      
      if (arg.startsWith('--')) {
        const key = arg.replace('--', '');
        const value = args[i + 1];
        
        if (value && !value.startsWith('--')) {
          switch (key) {
            case 'table':
            case 'source-table':
              options.sourceTable = value;
              i++; // Skip next arg as it's the value
              break;
            case 'column':
            case 'arn-column':
              options.arnColumn = value;
              i++; // Skip next arg as it's the value
              break;
            case 'id-column':
              options.idColumn = value;
              i++; // Skip next arg as it's the value
              break;
            case 'limit':
              options.limit = parseInt(value);
              i++; // Skip next arg as it's the value
              break;
            case 'batch-size':
              options.batchSize = parseInt(value);
              i++; // Skip next arg as it's the value
              break;
            case 'resume-from-id':
              options.resumeFromId = parseInt(value);
              i++; // Skip next arg as it's the value
              break;
            case 'resume-run-id':
              options.resumeRunId = value;
              i++; // Skip next arg as it's the value
              break;
            case 'run-id':
              options.runId = value;
              i++; // Skip next arg as it's the value
              break;
          }
        } else {
          // Handle flags without values
          switch (key) {
            case 'auto-batch':
              options.autoBatch = true;
              break;
          }
        }
      } else if (!isNaN(parseInt(arg))) {
        // Handle positional numeric arguments as limit
        options.limit = parseInt(arg);
      }
    }

    // Check for stats command
    if (args.includes('--stats')) {
      await service.initialize();
      await service.getStats();
      await service.shutdown();
      return;
    }

    // Check for progress command
    if (args.includes('--progress')) {
      await service.initialize();
      const progress = await service.getProgress(options.sourceTable, options.idColumn, options.runId);
      console.log('\n=== Latest Run Progress ===');
      console.log(`Run ID: ${progress.current_run_id || 'No runs found'}`);
      if (progress.current_run_id) {
        console.log(`Progress: ${progress.progress_percent}% (${progress.processed_records}/${progress.total_source_records} records)`);
        console.log(`Remaining Records: ${progress.remaining_records}`);
        if (progress.last_processed_id) {
          console.log(`Last Processed ID: ${progress.last_processed_id}`);
        }
        
        if (parseFloat(progress.progress_percent) < 100) {
          const envPrefix = process.env.NODE_ENV === 'production' ? 'npx cross-env NODE_ENV=production ' : '';
          console.log(`\n📋 To resume: ${envPrefix}node src/cleanup.js --resume-run-id ${progress.current_run_id}`);
          console.log(`   (Will automatically process ALL remaining records in 5,000-record chunks)`);
        } else {
          console.log(`\n✅ Run completed successfully!`);
        }
        console.log(`\nTotal Historical Runs: ${progress.total_runs}`);
      }
      await service.shutdown();
      return;
    }

    // Check for runs command
    if (args.includes('--runs')) {
      await service.initialize();
      const runs = await service.listRuns();
      console.log('\n=== Cleanup Runs ===');
      runs.forEach(run => {
        console.log(`\nRun ID: ${run.run_id}`);
        console.log(`  Records: ${run.processed_records}`);
        console.log(`  Started: ${run.started_at}`);
        console.log(`  Last Activity: ${run.last_activity}`);
        console.log(`  ID Range: ${run.first_id} - ${run.last_id}`);
        console.log(`  Status: ${run.enabled_count} enabled, ${run.disabled_count} disabled, ${run.error_count} errors`);
      });
      await service.shutdown();
      return;
    }

    // Show help
    if (args.includes('--help') || args.includes('-h')) {
      console.log(`
AWS SNS ARN Cleanup Tool

Usage: node src/cleanup.js [options]

Options:
  --table <name>        Source table name (default: from environment config)
  --column <name>       ARN column name (default: from environment config)
  --id-column <name>    ID column name (default: from environment config)
  --limit <number>      Limit number of ARNs to process
  --batch-size <number> Batch size for processing (default: from config)
  --auto-batch          Process all records in chunks automatically (default when no limit)
  --resume-from-id <id> Resume processing from a specific ID (new run)
  --resume-run-id <id>  Resume an interrupted run by run ID
  --run-id <id>         Filter stats/progress by specific run ID
  --stats               Show current statistics (all runs or specific run)
  --progress            Show processing progress and resume information
  --runs                List all cleanup runs
  --help, -h            Show this help message

Examples:
  node src/cleanup.js
  node src/cleanup.js --table mobile_clients --column target_arn --id-column client_id
  node src/cleanup.js --limit 1000 --batch-size 50
  node src/cleanup.js --stats
  node src/cleanup.js --progress
  node src/cleanup.js --runs
  node src/cleanup.js --resume-run-id run-2025-10-07T12-34-56-abc1

Resume After Interruption:
  1. List runs: node src/cleanup.js --runs
  2. Check progress: node src/cleanup.js --progress --run-id <run_id>
  3. Resume run: node src/cleanup.js --resume-run-id <run_id>

Manual Resume:
  node src/cleanup.js --resume-from-id 1500000  (starts new run from ID)

Environment Configuration:
  Configure source table in .env files:
  SOURCE_TABLE_NAME=your_table_name
  SOURCE_ARN_COLUMN=your_arn_column  
  SOURCE_ID_COLUMN=your_id_column
      `);
      return;
    }

    // Initialize and run cleanup
    await service.initialize();
    
    // Apply smart auto-batching for large datasets
    if (!options.limit && !options.autoBatch) {
      // No limit specified: enable auto-batch mode to process everything
      options.autoBatch = true;
      console.log(`\n� Auto-batch mode enabled: Will process all remaining records in chunks of 5,000.`);
      console.log(`   Use --limit <number> to process a specific number instead.`);
      console.log(`   Use --auto-batch to explicitly enable this mode.\n`);
    }
    
    const result = await service.cleanup(options);
    
    // Display results
    console.log('\n=== Cleanup Results ===');
    console.log(`Total Processed: ${result.totalProcessed}`);
    console.log(`Duration: ${(result.duration / 1000).toFixed(2)} seconds`);
    console.log('\nStatus Breakdown:');
    console.log(`  Enabled: ${result.results.enabled}`);
    console.log(`  Disabled: ${result.results.disabled}`);
    console.log(`  Errors: ${result.results.error}`);
    console.log(`  Not Found: ${result.results.not_found}`);
    
    if (result.results.disabled > 0) {
      console.log(`\n📋 Found ${result.results.disabled} disabled ARNs that can be cleaned up`);
    }
    
    await service.shutdown();
    
  } catch (error) {
    logError(error, { context: 'Main execution' });
    await service.shutdown();
    process.exit(1);
  }
}

// Export for use as module
module.exports = ArnCleanupService;

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}