const DatabaseService = require('./src/database');
const { config } = require('./src/config');

async function checkDatabase() {
  const db = new DatabaseService();
  try {
    await db.connect();
    console.log('Connected to database successfully');
    
    const tableName = config.app.resultsTableName;
    console.log(`Using table: ${tableName}`);
    
    // Check total count
    const countResult = await db.pool.request()
      .query(`SELECT COUNT(*) as total FROM ${tableName}`);
    
    console.log('Current record count:', countResult.recordset[0].total);
    
    // Check status breakdown
    const statusResult = await db.pool.request()
      .query(`SELECT status, COUNT(*) as count FROM ${tableName} GROUP BY status`);
    
    console.log('Status breakdown:');
    statusResult.recordset.forEach(row => {
      console.log(`  ${row.status}: ${row.count}`);
    });
    
    // Show table structure
    const tableResult = await db.pool.request()
      .query(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${tableName}'`);
    
    console.log('\nTable columns:');
    tableResult.recordset.forEach(row => {
      console.log(`  - ${row.COLUMN_NAME}`);
    });
    
    // Show recent records
    const recentResult = await db.pool.request()
      .query(`SELECT TOP 10 * FROM ${tableName} ORDER BY id DESC`);
    
    console.log('\nRecent records:');
    recentResult.recordset.forEach((row, index) => {
      console.log(`  ${index + 1}. ID: ${row.original_id}, Status: ${row.status}, Run: ${row.run_id}, Batch: ${row.batch_id}`);
    });
    
  } catch (error) {
    console.error('Database error:', error);
  } finally {
    await db.disconnect();
  }
}

checkDatabase();