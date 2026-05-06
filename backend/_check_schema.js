const pool = require('./src/database');
(async () => {
  try {
    const r = await pool.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'Conversations' ORDER BY ordinal_position"
    );
    console.log('=== Conversations ===');
    console.log(JSON.stringify(r.rows, null, 2));
    const m = await pool.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'Messages' ORDER BY ordinal_position"
    );
    console.log('=== Messages ===');
    console.log(JSON.stringify(m.rows, null, 2));
    const t = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    console.log('=== Tables ===');
    console.log(t.rows.map(r => r.tablename).join(', '));
  } catch(e) {
    console.error(e.message);
  }
  process.exit(0);
})();
