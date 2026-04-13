require('dotenv').config();
const { Pool, types } = require('pg');

// Fix: PostgreSQL BIGINT (oid=20) trả về dạng string, cần parse thành number
types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('error', (err, client) => {
  console.error('Lỗi kết nối PostgreSQL không mong muốn:', err);
  process.exit(-1);
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error('Không thể kết nối đến PostgreSQL. Hãy kiểm tra Username/Password và Database name.', err.stack);
  }
  console.log('Đã kết nối thành công tới PostgreSQL Database.');
  release();
});

module.exports = pool;

