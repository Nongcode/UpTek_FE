require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./database');

const app = express();
app.use(cors());
app.use(express.json());

// Log tất cả request để dễ debug
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Dọn dẹp Messages rác (không có conversationId) khi server khởi động
(async () => {
  try {
    const result = await pool.query('DELETE FROM "Messages" WHERE "conversationId" IS NULL');
    if (result.rowCount > 0) {
      console.log(`Đã xóa ${result.rowCount} tin nhắn rác (thiếu conversationId).`);
    }
  } catch (err) {
    console.error('Lỗi khi dọn dẹp Messages:', err.message);
  }
})();

// Get all conversations for an employee
app.get('/api/conversations/:employeeId', async (req, res) => {
  const { employeeId } = req.params;
  try {
    const convResult = await pool.query(
      'SELECT * FROM "Conversations" WHERE "employeeId" = $1 ORDER BY "updatedAt" DESC',
      [employeeId]
    );
    const convRows = convResult.rows;

    if (convRows.length === 0) {
      return res.json([]);
    }

    const convIds = convRows.map(c => c.id);
    // Create placeholders: $1, $2, $3...
    const placeholders = convIds.map((_, i) => `$${i + 1}`).join(',');
    
    const msgResult = await pool.query(
      `SELECT * FROM "Messages" WHERE "conversationId" IN (${placeholders}) ORDER BY "timestamp" ASC`,
      convIds
    );
    const msgRows = msgResult.rows;

    const result = convRows.map(conv => ({
      ...conv,
      messages: msgRows.filter(m => m.conversationId === conv.id)
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get ALL conversations across all employees (for Dashboard)
app.get('/api/conversations-global', async (req, res) => {
  try {
    const convResult = await pool.query('SELECT * FROM "Conversations" ORDER BY "updatedAt" DESC');
    res.json(convResult.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new conversation
app.post('/api/conversations', async (req, res) => {
  const { id, title, agentId, sessionKey, projectId, status, createdAt, updatedAt, employeeId } = req.body;
  try {
    await pool.query(
      `INSERT INTO "Conversations" ("id", "title", "agentId", "sessionKey", "projectId", "status", "createdAt", "updatedAt", "employeeId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, title, agentId, sessionKey, projectId, status, createdAt, updatedAt, employeeId]
    );
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a conversation (title, status, updatedAt)
app.put('/api/conversations/:id', async (req, res) => {
  const { id } = req.params;
  const { title, status, updatedAt } = req.body;
  try {
    await pool.query(
      `UPDATE "Conversations" 
       SET "title" = COALESCE($1, "title"), 
           "status" = COALESCE($2, "status"), 
           "updatedAt" = COALESCE($3, "updatedAt") 
       WHERE "id" = $4`,
      [title, status, updatedAt, id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new messages
app.post('/api/messages', async (req, res) => {
  const { messages } = req.body; // array of message objects
  if (!messages || !messages.length) return res.json({ success: true });
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const msg of messages) {
      await client.query(
        `INSERT INTO "Messages" ("id", "conversationId", "role", "type", "content", "timestamp")
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content"`,
        [msg.id, msg.conversationId, msg.role, msg.type, msg.content, msg.timestamp]
      );
    }
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Delete a conversation
app.delete('/api/conversations/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM "Messages" WHERE "conversationId" = $1`, [id]);
    await client.query(`DELETE FROM "Conversations" WHERE "id" = $1`, [id]);
    await client.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Backend Server is running on http://localhost:${PORT}`);
});
