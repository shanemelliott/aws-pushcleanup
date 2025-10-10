const db = require('./src/database');

async function getResults() {
  try {
    const pool = await db.getConnection();
    const result = await pool.request()
      .query('SELECT status, COUNT(*) as count FROM CDW_push_arn_cleanup_results_staging GROUP BY status ORDER BY count DESC');
    
    console.log('\n🎉 STAGING CLEANUP COMPLETE! 🎉');
    console.log('====================================');
    console.log('Final Results Summary:');
    console.log('====================================');
    
    result.recordset.forEach(row => {
      console.log(`${row.status}: ${row.count.toLocaleString()}`);
    });
    
    const total = result.recordset.reduce((sum, row) => sum + row.count, 0);
    console.log('------------------------------------');
    console.log(`TOTAL: ${total.toLocaleString()} ARNs processed`);
    console.log('====================================\n');
    
    await pool.close();
  } catch (error) {
    console.error('Error:', error);
  }
}

getResults();