#!/usr/bin/env node

/**
 * Server Deployment Script for AWS ARN Cleanup Tool
 * This script helps deploy and manage the cleanup process on a server
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class DeploymentManager {
  constructor() {
    this.projectRoot = process.cwd();
    this.logsDir = path.join(this.projectRoot, 'logs');
  }

  log(message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
  }

  async setupServer() {
    this.log('🚀 Setting up server deployment...');
    
    // Create logs directory
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
      this.log('✅ Created logs directory');
    }

    // Install PM2 globally (if not already installed)
    try {
      execSync('pm2 --version', { stdio: 'ignore' });
      this.log('✅ PM2 is already installed');
    } catch (error) {
      this.log('📦 Installing PM2 globally...');
      execSync('npm install -g pm2', { stdio: 'inherit' });
      this.log('✅ PM2 installed successfully');
    }

    // Install project dependencies
    this.log('📦 Installing project dependencies...');
    execSync('npm install', { stdio: 'inherit' });
    this.log('✅ Dependencies installed');

    this.log('🎉 Server setup complete!');
  }

  async startAutoBatch(environment = 'production') {
    this.log(`🔄 Starting auto-batch cleanup in ${environment} mode...`);
    
    try {
      // Stop any existing auto-batch process
      try {
        execSync('pm2 stop aws-arn-cleanup-auto-batch', { stdio: 'ignore' });
        execSync('pm2 delete aws-arn-cleanup-auto-batch', { stdio: 'ignore' });
      } catch (e) {
        // Process doesn't exist, that's fine
      }

      // Start the auto-batch process
      execSync(`pm2 start ecosystem.config.js --only aws-arn-cleanup-auto-batch --env ${environment}`, { stdio: 'inherit' });
      this.log('✅ Auto-batch process started successfully');
      
      // Show process status
      this.showStatus();
      
    } catch (error) {
      this.log('❌ Failed to start auto-batch process');
      console.error(error.message);
      process.exit(1);
    }
  }

  async startResume(runId, environment = 'production') {
    this.log(`⏯️ Starting resume cleanup for run: ${runId}`);
    
    try {
      // Update ecosystem config with the run ID
      const configPath = path.join(this.projectRoot, 'ecosystem.config.js');
      let config = fs.readFileSync(configPath, 'utf8');
      config = config.replace(
        /args: '--resume-run-id [^']*'/,
        `args: '--resume-run-id ${runId}'`
      );
      fs.writeFileSync(configPath, config);
      this.log(`✅ Updated ecosystem config with run ID: ${runId}`);

      // Stop any existing process
      try {
        execSync('pm2 stop aws-arn-cleanup-production', { stdio: 'ignore' });
        execSync('pm2 delete aws-arn-cleanup-production', { stdio: 'ignore' });
      } catch (e) {
        // Process doesn't exist, that's fine
      }

      // Start the resume process
      execSync(`pm2 start ecosystem.config.js --only aws-arn-cleanup-production --env ${environment}`, { stdio: 'inherit' });
      this.log('✅ Resume process started successfully');
      
      // Show process status
      this.showStatus();
      
    } catch (error) {
      this.log('❌ Failed to start resume process');
      console.error(error.message);
      process.exit(1);
    }
  }

  showStatus() {
    this.log('📊 Current process status:');
    try {
      execSync('pm2 list', { stdio: 'inherit' });
    } catch (error) {
      this.log('❌ Failed to show PM2 status');
    }
  }

  showLogs(processName = null) {
    if (processName) {
      this.log(`📋 Showing logs for ${processName}...`);
      execSync(`pm2 logs ${processName} --lines 50`, { stdio: 'inherit' });
    } else {
      this.log('📋 Showing all logs...');
      execSync('pm2 logs --lines 50', { stdio: 'inherit' });
    }
  }

  monitorProgress() {
    this.log('📈 Starting real-time monitoring...');
    execSync('pm2 monit', { stdio: 'inherit' });
  }

  stop(processName = null) {
    if (processName) {
      this.log(`🛑 Stopping ${processName}...`);
      execSync(`pm2 stop ${processName}`, { stdio: 'inherit' });
    } else {
      this.log('🛑 Stopping all processes...');
      execSync('pm2 stop all', { stdio: 'inherit' });
    }
  }

  restart(processName = null) {
    if (processName) {
      this.log(`🔄 Restarting ${processName}...`);
      execSync(`pm2 restart ${processName}`, { stdio: 'inherit' });
    } else {
      this.log('🔄 Restarting all processes...');
      execSync('pm2 restart all', { stdio: 'inherit' });
    }
  }

  showHelp() {
    console.log(`
🔧 AWS ARN Cleanup - Server Deployment Manager

Usage: node deploy.js <command> [options]

Commands:
  setup                     - Install PM2 and setup server environment
  start-auto                - Start auto-batch processing (processes all records)
  start-resume <run-id>     - Resume from specific run ID
  status                    - Show process status
  logs [process-name]       - Show logs (all processes or specific)
  monitor                   - Start real-time monitoring dashboard
  stop [process-name]       - Stop process(es)
  restart [process-name]    - Restart process(es)

Examples:
  node deploy.js setup
  node deploy.js start-auto
  node deploy.js start-resume run-2025-10-07T18-30-15-u0qn
  node deploy.js logs aws-arn-cleanup-auto-batch
  node deploy.js status
  node deploy.js monitor

Process Names:
  - aws-arn-cleanup-auto-batch    (Auto-batch processing)
  - aws-arn-cleanup-production    (Resume processing)
`);
  }
}

// Command line interface
async function main() {
  const manager = new DeploymentManager();
  const command = process.argv[2];
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  try {
    switch (command) {
      case 'setup':
        await manager.setupServer();
        break;
      
      case 'start-auto':
        const env1 = arg1 || 'production';
        await manager.startAutoBatch(env1);
        break;
      
      case 'start-resume':
        if (!arg1) {
          console.error('❌ Run ID is required for resume');
          console.log('Usage: node deploy.js start-resume <run-id>');
          process.exit(1);
        }
        const env2 = arg2 || 'production';
        await manager.startResume(arg1, env2);
        break;
      
      case 'status':
        manager.showStatus();
        break;
      
      case 'logs':
        manager.showLogs(arg1);
        break;
      
      case 'monitor':
        manager.monitorProgress();
        break;
      
      case 'stop':
        manager.stop(arg1);
        break;
      
      case 'restart':
        manager.restart(arg1);
        break;
      
      case 'help':
      case '--help':
      case '-h':
      default:
        manager.showHelp();
        break;
    }
  } catch (error) {
    console.error('❌ Command failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = DeploymentManager;