#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Environment setup utility
class EnvironmentManager {
  constructor() {
    this.environments = ['staging', 'production'];
  }

  checkEnvironmentFile(env) {
    const envFile = `.env.${env}`;
    return fs.existsSync(envFile);
  }

  validateEnvironment(env) {
    if (!this.environments.includes(env)) {
      throw new Error(`Invalid environment: ${env}. Valid options: ${this.environments.join(', ')}`);
    }

    if (!this.checkEnvironmentFile(env)) {
      throw new Error(`Environment file .env.${env} not found. Please create it based on .env.example`);
    }
  }

  listEnvironments() {
    console.log('📋 Available Environments:');
    this.environments.forEach(env => {
      const exists = this.checkEnvironmentFile(env);
      const status = exists ? '✅ Configured' : '❌ Not configured';
      console.log(`  ${env}: ${status}`);
    });
  }

  showUsage() {
    console.log(`
🚀 AWS SNS ARN Cleanup Tool - Environment Manager

Usage:
  npm run cleanup:staging          # Run cleanup on staging
  npm run cleanup:production       # Run cleanup on production
  npm run stats:staging           # View staging statistics
  npm run stats:production        # View production statistics

Direct usage:
  ENVIRONMENT=staging node src/cleanup.js
  ENVIRONMENT=production node src/cleanup.js --limit 100

Environment Files:
  .env.staging      # Staging configuration
  .env.production   # Production configuration

Setup:
  1. Copy .env.example to .env.staging and .env.production
  2. Update each file with environment-specific settings
  3. Run the appropriate npm script
    `);
  }
}

// CLI interface
if (require.main === module) {
  const manager = new EnvironmentManager();
  const args = process.argv.slice(2);

  if (args.includes('--list') || args.includes('-l')) {
    manager.listEnvironments();
  } else if (args.includes('--help') || args.includes('-h')) {
    manager.showUsage();
  } else {
    manager.showUsage();
    console.log('');
    manager.listEnvironments();
  }
}

module.exports = EnvironmentManager;