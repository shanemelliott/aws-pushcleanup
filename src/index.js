#!/usr/bin/env node

const ArnCleanupService = require('./cleanup');

// This is the main entry point for the application
// You can import and use the ArnCleanupService directly from here

async function main() {
  console.log('🚀 AWS Pinpoint ARN Cleanup Tool');
  console.log('Run "node src/cleanup.js --help" for usage information');
  console.log('Or run "node src/cleanup.js" to start the cleanup process');
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = ArnCleanupService;