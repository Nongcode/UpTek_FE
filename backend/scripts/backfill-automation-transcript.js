require('dotenv').config();
const pool = require('../src/database');
const { injectAutomationMessage } = require('../src/gateway-sync');

async function main() {
  const workflowId = process.argv[2];
  const employeeId = process.argv[3] || 'pho_phong';
  const agentId = process.argv[4] || employeeId;

  if (!workflowId) {
    throw new Error('Usage: node backend/scripts/backfill-automation-transcript.js <workflowId> [employeeId] [agentId]');
  }

  const sessionKey = `automation:${agentId}:${workflowId}`;
  const canonicalConversationId = `auto_${employeeId}_${workflowId}`;

  const conversationResult = await pool.query(
    `SELECT *
     FROM "Conversations"
     WHERE "sessionKey" = $1 OR "id" = $2
     ORDER BY "updatedAt" DESC
     LIMIT 1`,
    [sessionKey, canonicalConversationId]
  );
  const conversation = conversationResult.rows[0];
  if (!conversation) {
    throw new Error(`Conversation not found for ${sessionKey}`);
  }

  const messagesResult = await pool.query(
    `SELECT "id", "content", "timestamp"
     FROM "Messages"
     WHERE "conversationId" = $1
     ORDER BY "timestamp" ASC`,
    [conversation.id]
  );

  if (!messagesResult.rows.length) {
    console.log(`No messages found for ${conversation.id}`);
    return;
  }

  let injectedCount = 0;
  let skippedCount = 0;

  for (const message of messagesResult.rows) {
    const content = String(message.content || '').trim();
    if (!content) {
      skippedCount += 1;
      continue;
    }

    await injectAutomationMessage({
      sessionKey,
      content: content.slice(0, 4000),
      eventId: message.id,
      label: agentId,
    });
    injectedCount += 1;
  }

  console.log(`Injected ${injectedCount} messages into ${sessionKey}; skipped ${skippedCount} empty messages.`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

