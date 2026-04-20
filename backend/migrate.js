const pool = require('./src/database');
(async () => {
  try { 
    await pool.query('ALTER TABLE "Images" ADD COLUMN IF NOT EXISTS "productModel" VARCHAR(255)'); 
    await pool.query('ALTER TABLE "Images" ADD COLUMN IF NOT EXISTS "prefix" VARCHAR(255)'); 
    console.log('Altered table Images successfully'); 
  } catch(e) { 
    console.error('Migration error:', e.message); 
  } 
  process.exit(0); 
})();
