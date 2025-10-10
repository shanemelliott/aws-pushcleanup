# AWS Pinpoint ARN Cleanup Tool

A Node.js application that helps clean up orphaned AWS Pinpoint push notification ARNs by checking their status against AWS APIs and updating your MSSQL database with the results.

## Overview

When users uninstall mobile apps, their push notification endpoints in AWS Pinpoint become disabled, but the ARNs might still be stored in your database. This tool helps you identify which ARNs are still active and which ones can be safely removed.

## Features

- ✅ Connect to MSSQL database to fetch push notification ARNs
- ✅ Check ARN status using AWS SNS APIs (enhanced from Pinpoint)
- ✅ **Save-as-you-go architecture** - Results saved immediately after each batch
- ✅ **Run tracking system** - Unique run IDs with complete audit trail
- ✅ **Resume capability** - Resume interrupted runs from exact stopping point
- ✅ **Enhanced progress reporting** - Latest run progress (0-100%) with clear status
- ✅ Batch processing for efficient handling of large datasets
- ✅ Store results in separate table with automatic schema migration
- ✅ Comprehensive logging and error handling with production-ready format
- ✅ Configurable batch sizes and retry logic with exponential backoff
- ✅ Support for different environments (staging, production)
- ✅ AWS role assumption for secure credential management
- ✅ Statistics and progress tracking with detailed run analytics

## Prerequisites

- Node.js (version 14 or higher)
- AWS account with Pinpoint access
- MSSQL database
- AWS credentials configured (either via AWS CLI, environment variables, or IAM roles)

## Installation

1. Clone or download this project
2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the environment template:
   ```bash
   copy .env.example .env
   ```

4. Configure your environment variables in `.env`

## Configuration

### Environment Variables

Create a `.env` file based on `.env.example` and configure the following:

#### AWS Configuration
```
# AWS Role ARN for secure access (recommended)
AWS_ROLE_ARN=arn:aws-us-gov:iam::171875617347:role/project/project-vetext-staging-role

# OR use direct credentials (not recommended for production)
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_access_key_here
AWS_SECRET_ACCESS_KEY=your_secret_key_here
# OR use AWS profile
# AWS_PROFILE=your_profile_name
```

#### Database Configuration
```
DB_SERVER=your_server_name_here
DB_DATABASE=your_database_name_here
DB_USER=your_username_here
DB_PASSWORD=your_password_here
DB_PORT=1433
DB_ENCRYPT=true
DB_TRUST_SERVER_CERTIFICATE=false
```

#### Application Settings
```
BATCH_SIZE=50                # Number of ARNs to process in each batch
LOG_LEVEL=info               # Logging level (error, warn, info, debug)
MAX_RETRIES=3                # Maximum retries for failed requests
RETRY_DELAY_MS=1000          # Delay between retries (milliseconds)
RESULTS_TABLE_NAME=CDW_push_arn_cleanup_results  # Base table name (environment suffix added)
SOURCE_TABLE_NAME=CDW_Person  # Source table containing push ARNs
SOURCE_COLUMN_NAME=PushArn    # Column name containing ARN values
```

## Enhanced Features

### 🔄 Save-as-You-Go Architecture
- Results are saved to database immediately after each batch
- No data loss if process is interrupted
- Complete audit trail of all processing attempts

### 🏃‍♂️ Run Tracking System  
- Each execution gets unique run ID (e.g., `run-2025-10-07T15-26-59-ygye`)
- Complete tracking of batch progress within runs
- Historical run analysis and comparison

### ⏯️ Resume Capability
- Automatically resume interrupted runs from exact stopping point
- Manual resume with specific run ID
- Skip already processed records efficiently

### 📊 Enhanced Progress Reporting
- Latest run progress (0-100%) instead of confusing cumulative totals
- Real-time batch completion status
- Remaining record counts and time estimates
- Clear resume instructions for interrupted runs

### 🔐 Secure AWS Integration
- AWS role assumption for credential-less authentication
- Support for AWS Gov Cloud environments
- Automatic credential refresh and retry logic

## Usage

### Basic Usage

Run the cleanup with default settings:
```bash
npm run cleanup
```

Or directly with environment:
```bash
# Staging environment
npx cross-env NODE_ENV=staging node src/cleanup.js

# Production environment
npx cross-env NODE_ENV=production node src/cleanup.js
```

### Progress Monitoring

Check current progress of latest run:
```bash
npx cross-env NODE_ENV=staging node src/cleanup.js --progress
```

### Resume Interrupted Runs

Resume a specific run that was interrupted:
```bash
npx cross-env NODE_ENV=staging node src/cleanup.js --resume-run-id run-2025-10-07T15-26-59-ygye
```

### Testing with Limited Data

To test with a smaller dataset:
```bash
npx cross-env NODE_ENV=staging node src/cleanup.js --limit 100
```

### Custom Batch Size

For better performance tuning:
```bash
npx cross-env NODE_ENV=staging node src/cleanup.js --batch-size 50
```

### View Statistics

Check current cleanup statistics:
```bash
npx cross-env NODE_ENV=staging node src/cleanup.js --stats
```

### Help

View all available options:
```bash
node src/cleanup.js --help
```

## Database Setup

### Automatic Schema Migration
The application automatically:
- Creates results table with environment-specific naming (e.g., `CDW_push_arn_cleanup_results_staging`)
- Adds run tracking columns (`run_id`, `batch_id`) to existing tables
- Handles schema updates gracefully without data loss

### Manual SQL Setup (Optional)
```bash
# Run the SQL script in your MSSQL database if needed
sqlcmd -S your_server -d your_database -i sql/create_results_table.sql
```

### Database Schema
The results table includes enhanced tracking:
```sql
CREATE TABLE CDW_push_arn_cleanup_results_staging (
    id INT IDENTITY(1,1) PRIMARY KEY,
    original_id INT NOT NULL,
    arn NVARCHAR(500) NOT NULL,
    status NVARCHAR(50) NOT NULL,
    enabled BIT,
    has_token BIT,
    status_reason NVARCHAR(MAX),
    error_message NVARCHAR(MAX),
    checked_at DATETIME2 DEFAULT GETDATE(),
    run_id NVARCHAR(50) NOT NULL,        -- New: Run tracking
    batch_id INT NOT NULL                -- New: Batch tracking
);
```

## Results Analysis

After running the cleanup, you can analyze the results using the provided SQL queries in `sql/analysis_queries.sql`.

### Status Values

The results table will contain one of these status values:

- **ENABLED**: The endpoint is active and receiving notifications
- **DISABLED**: The endpoint is disabled (user opted out or app uninstalled)
- **ERROR**: There was an error checking the endpoint status  
- **NOT_FOUND**: The endpoint was not found in AWS Pinpoint

### Sample Analysis Queries

```sql
-- Get latest run progress summary
SELECT 
    run_id,
    COUNT(*) as total_records,
    COUNT(CASE WHEN status = 'ENABLED' THEN 1 END) as enabled_count,
    COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) as disabled_count,
    COUNT(CASE WHEN status = 'ERROR' THEN 1 END) as error_count,
    MIN(checked_at) as run_start,
    MAX(checked_at) as run_end
FROM CDW_push_arn_cleanup_results_staging
WHERE run_id = (SELECT TOP 1 run_id FROM CDW_push_arn_cleanup_results_staging ORDER BY checked_at DESC)
GROUP BY run_id;

-- Get disabled ARNs from latest run (candidates for cleanup)
SELECT original_id, arn, status_reason, checked_at, run_id, batch_id
FROM CDW_push_arn_cleanup_results_staging 
WHERE status = 'DISABLED' 
  AND run_id = (SELECT TOP 1 run_id FROM CDW_push_arn_cleanup_results_staging ORDER BY checked_at DESC)
ORDER BY checked_at DESC;

-- Run comparison analysis
SELECT 
    run_id,
    COUNT(*) as records_processed,
    COUNT(CASE WHEN status = 'DISABLED' THEN 1 END) as cleanup_candidates,
    MIN(checked_at) as started_at,
    MAX(checked_at) as completed_at
FROM CDW_push_arn_cleanup_results_staging
GROUP BY run_id
ORDER BY MIN(checked_at) DESC;
```

## Logging

The application creates detailed logs in the `logs/` directory:

- `logs/combined.log`: All log entries
- `logs/error.log`: Error entries only
- Console output: Real-time progress and results

## Error Handling

The tool includes comprehensive error handling:

- **Retry Logic**: Automatically retries failed requests with exponential backoff
- **Batch Processing**: Continues processing even if some ARNs fail
- **Database Transactions**: Ensures data integrity when saving results
- **Detailed Logging**: Captures errors with context for debugging

## Performance Considerations

- **Batch Size**: Start with smaller batches (50-100) and increase based on your AWS rate limits
- **Rate Limiting**: The tool includes delays between batches to avoid AWS throttling
- **Memory Usage**: Large datasets are processed in batches to manage memory consumption
- **Database Connections**: Uses connection pooling for efficient database access

## Security Notes

- Store sensitive credentials in environment variables, not in code
- Use IAM roles when running on AWS infrastructure
- Enable database encryption for sensitive data
- Regularly rotate AWS access keys

## Troubleshooting

### Common Issues

1. **AWS Authentication Errors**
   - Verify your AWS credentials are correct
   - Check IAM permissions for Pinpoint access
   - Ensure the region is correct

2. **Database Connection Issues**
   - Verify server name, database name, and credentials
   - Check firewall rules and network connectivity
   - Ensure MSSQL server allows remote connections

3. **High Error Rates**
   - Check AWS service limits and quotas
   - Reduce batch size to avoid rate limiting
   - Verify Pinpoint Application ID is correct

### Debug Mode

Enable debug logging by setting `LOG_LEVEL=debug` in your `.env` file.

## Server Deployment 🚀

For production environments, you can deploy this tool on a server to run continuously in the background.

### Prerequisites for Server Deployment

- Linux/Windows server with Node.js 14+
- PM2 process manager (installed automatically)
- Persistent database connection
- Adequate memory (4GB+ recommended for large datasets)

### Quick Server Setup

1. **Copy your project to the server:**
   ```bash
   # Upload your project files to the server
   scp -r /path/to/aws-pushcleanup user@server:/opt/aws-pushcleanup
   ```

2. **Setup the server environment:**
   ```bash
   cd /opt/aws-pushcleanup
   node deploy.js setup
   ```

3. **Start auto-batch processing (processes all records):**
   ```bash
   # This will process all 4+ million records automatically
   node deploy.js start-auto
   ```

4. **Monitor progress:**
   ```bash
   # View real-time logs
   node deploy.js logs
   
   # View process status
   node deploy.js status
   
   # Open monitoring dashboard
   node deploy.js monitor
   ```

### Server Deployment Commands

```bash
# Setup server environment
npm run deploy:setup
# or
node deploy.js setup

# Start auto-batch processing (recommended for large datasets)
npm run deploy:auto
# or
node deploy.js start-auto production

# Resume from specific run ID
node deploy.js start-resume run-2025-10-07T18-30-15-u0qn

# Monitor processes
npm run deploy:status    # Show process status
npm run deploy:logs      # View logs
npm run deploy:monitor   # Real-time monitoring dashboard

# Process management
node deploy.js stop                              # Stop all processes
node deploy.js stop aws-arn-cleanup-auto-batch   # Stop specific process
node deploy.js restart aws-arn-cleanup-auto-batch # Restart process
```

### Remote Monitoring with Health Check Server

Start a web server to monitor progress remotely:

```bash
# Start health check server on port 3000
npm run health-server

# Or specify custom port
node src/health-server.js 8080
```

**Available monitoring endpoints:**
- `http://your-server:3000/health` - Server health status
- `http://your-server:3000/progress` - Current processing progress
- `http://your-server:3000/stats` - Latest run statistics  
- `http://your-server:3000/status` - Complete status overview
- `http://your-server:3000/runs` - All runs summary

### PM2 Process Management

The deployment uses PM2 for robust process management:

```bash
# View all processes
pm2 list

# View logs in real-time
pm2 logs aws-arn-cleanup-auto-batch

# Monitor resource usage
pm2 monit

# Restart a process
pm2 restart aws-arn-cleanup-auto-batch

# Stop a process
pm2 stop aws-arn-cleanup-auto-batch

# Delete a process
pm2 delete aws-arn-cleanup-auto-batch

# View process details
pm2 describe aws-arn-cleanup-auto-batch
```

### Server Configuration

The `ecosystem.config.js` file contains two process configurations:

1. **`aws-arn-cleanup-auto-batch`** - Auto-processes all remaining records in 5K chunks
2. **`aws-arn-cleanup-production`** - Resume from specific run ID

Key features:
- ✅ **Auto-restart** on crashes or memory limits
- ✅ **Log rotation** and centralized logging
- ✅ **Memory monitoring** (auto-restart at 2GB/4GB limits)
- ✅ **Process isolation** (fork mode)
- ✅ **Environment management** (staging/production)

### Production Recommendations

1. **Set up log rotation:**
   ```bash
   # Install logrotate configuration
   sudo cp scripts/logrotate.conf /etc/logrotate.d/aws-arn-cleanup
   ```

2. **Monitor disk space** - Large datasets generate substantial logs
3. **Set up alerts** - Monitor the health check endpoints
4. **Backup strategy** - Regularly backup the results database
5. **Network security** - Restrict health check server access as needed

### Troubleshooting Server Deployment

**Process not starting:**
```bash
# Check PM2 logs
pm2 logs aws-arn-cleanup-auto-batch --lines 100

# Check environment variables
node deploy.js status
```

**Memory issues:**
```bash
# Increase memory limit in ecosystem.config.js
max_memory_restart: '8G'  # Increase from default 4G

# Monitor memory usage
pm2 monit
```

**Database connection issues:**
```bash
# Test database connection
node -e "require('./src/database.js'); console.log('DB test')"

# Check environment file
cat .env.production
```

**Process keeps restarting:**
```bash
# Check error logs
pm2 logs aws-arn-cleanup-auto-batch --err

# Increase minimum uptime
min_uptime: '60s'  # In ecosystem.config.js
```

## Contributing

Feel free to submit issues and enhancement requests!

## License

MIT License - see the LICENSE file for details.