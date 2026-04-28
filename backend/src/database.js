require('dotenv').config();
const { Pool, types } = require('pg');

// PostgreSQL BIGINT (oid=20) is returned as string by default; keep existing number behavior.
types.setTypeParser(20, (val) => parseInt(val, 10));

let pool;

function createPool() {
  const nextPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  nextPool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });

  return nextPool;
}

// Lazy init avoids opening PostgreSQL connections just because a script imports a service.
function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

async function checkConnection() {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}

async function closePool() {
  if (!pool) {
    return;
  }
  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}

async function shutdownDb() {
  return closePool();
}

const db = {
  connect(...args) {
    return getPool().connect(...args);
  },
  query(...args) {
    return getPool().query(...args);
  },
  end(...args) {
    return closePool(...args);
  },
  getPool,
  checkConnection,
  closePool,
  shutdownDb,
};

module.exports = db;
