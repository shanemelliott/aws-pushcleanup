module.exports = {
  apps: [
    {
      name: 'aws-arn-cleanup-production',
      script: 'src/cleanup.js',
      args: '--resume-run-id YOUR_RUN_ID_HERE', // Update this with your actual run ID
      env: {
        NODE_ENV: 'production'
      },
      // PM2 Configuration for server deployment
      instances: 1, // Run single instance (don't parallelize ARN processing)
      exec_mode: 'fork', // Use fork mode for single instance
      max_memory_restart: '2G', // Restart if memory exceeds 2GB
      
      // Logging Configuration
      log_file: './logs/pm2-combined.log',
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Auto-restart configuration
      autorestart: true,
      watch: false, // Don't watch files (we want stability)
      max_restarts: 3, // Max restarts before giving up
      min_uptime: '10s', // Minimum uptime before considering stable
      
      // Cron restart (optional - restart daily at 2 AM)
      // cron_restart: '0 2 * * *',
      
      // Environment-specific overrides
      env_staging: {
        NODE_ENV: 'staging'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'aws-arn-cleanup-auto-batch',
      script: 'src/cleanup.js',
      args: '--auto-batch', // Auto-batch mode - processes all records
      env: {
        NODE_ENV: 'production'
      },
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '4G', // Higher memory for auto-batch
      
      // Logging
      log_file: './logs/pm2-auto-batch-combined.log',
      out_file: './logs/pm2-auto-batch-out.log',
      error_file: './logs/pm2-auto-batch-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      
      // Auto-restart
      autorestart: true,
      watch: false,
      max_restarts: 5, // More restarts for long-running process
      min_uptime: '30s',
      
      // Stop after completion (auto-batch should finish and exit)
      stop_exit_codes: [0] // Don't restart on successful completion
    }
  ]
};