require("dotenv").config();
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const deletedMessages = await client.query('DELETE FROM "Messages"');
    const deletedConversations = await client.query('DELETE FROM "Conversations"');
    await client.query("COMMIT");
    console.log(
      `Deleted messages: ${deletedMessages.rowCount}, conversations: ${deletedConversations.rowCount}`
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("Failed to reset chats:", error.message || error);
  process.exit(1);
});
