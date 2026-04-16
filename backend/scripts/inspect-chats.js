require("dotenv").config();
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const conversations = await pool.query(
    'SELECT "employeeId", "agentId", "id", "title", "status", "updatedAt" FROM "Conversations" ORDER BY "updatedAt" DESC'
  );
  console.log(`Conversations: ${conversations.rowCount}`);
  for (const row of conversations.rows) {
    console.log(
      `${row.employeeId} | ${row.agentId} | ${row.id} | ${row.status} | ${row.title}`
    );
  }

  const messages = await pool.query(
    'SELECT "conversationId", "role", "type", left("content", 120) as snippet FROM "Messages" ORDER BY "timestamp" DESC LIMIT 20'
  );
  console.log(`\nRecent messages: ${messages.rowCount}`);
  for (const row of messages.rows) {
    console.log(`${row.conversationId} | ${row.role}/${row.type} | ${row.snippet}`);
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
