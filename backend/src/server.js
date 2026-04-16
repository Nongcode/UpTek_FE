require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./database');
const {
  buildLoginResponse,
  canAccessConversation,
  canAccessEmployeeId,
  requireBackendAuth,
} = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());
const automationSyncToken = process.env.AUTOMATION_SYNC_TOKEN || "";

function isAutomationConversation(conversation) {
  const sessionKey = String(conversation?.sessionKey || "");
  const id = String(conversation?.id || "");
  const title = String(conversation?.title || "");
  return (
    sessionKey.startsWith("automation:")
    || id.startsWith("auto_")
    || title.startsWith("[AUTO]")
  );
}

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
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const result = buildLoginResponse(email, password);
  if (!result) {
    return res.status(401).json({
      error: { message: 'Invalid email or password', type: 'unauthorized' },
    });
  }
  return res.json(result);
});

app.get('/api/conversations/:employeeId', requireBackendAuth, async (req, res) => {
  const { employeeId } = req.params;
  const includeAutomation = req.query.includeAutomation === '1' || req.query.includeAutomation === 'true';
  if (!canAccessEmployeeId(req.auth, employeeId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    // Sửa query để lấy cả hội thoại mà employeeId sở hữu HOẶC agentId là employeeId (dành cho surveillance)
    // Nhưng chủ yếu là employeeId sở hữu để tránh lấy lộn của manager
    const convResult = await pool.query(
      'SELECT * FROM "Conversations" WHERE "employeeId" = $1 ORDER BY "updatedAt" DESC',
      [employeeId]
    );

    let convRows = convResult.rows;
    
    // Nếu là manager đang xem nhân viên, có thể họ muốn xem cả các session automation mà nhân viên đó tham gia
    if (includeAutomation) {
      // Tìm thêm các session automation mà nhân viên này là agentId nhưng owner là người khác (thường là manager)
      const autoResult = await pool.query(
        'SELECT * FROM "Conversations" WHERE "agentId" = $1 AND "id" LIKE \'auto_%\' ORDER BY "updatedAt" DESC',
        [employeeId]
      );
      // Gộp và dedupe
      const existingIds = new Set(convRows.map(c => c.id));
      for (const row of autoResult.rows) {
        if (!existingIds.has(row.id)) {
          convRows.push(row);
        }
      }
    }

    if (!includeAutomation) {
      convRows = convRows.filter((row) => !isAutomationConversation(row));
    }

    if (convRows.length === 0) {
      return res.json([]);
    }

    const convIds = convRows.map(c => c.id);
    const placeholders = convIds.map((_, i) => `$${i + 1}`).join(',');
    
    const msgResult = await pool.query(
      `SELECT * FROM "Messages" WHERE "conversationId" IN (${placeholders}) ORDER BY "timestamp" ASC`,
      convIds
    );
    const msgRows = msgResult.rows;

    const result = convRows.map(conv => ({
      ...conv,
      messages: msgRows.filter(m => m.conversationId === conv.id)
    })).filter((conv) => canAccessConversation(req.auth, conv));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Get ALL conversations across all employees (for Dashboard)
app.get('/api/conversations-global', requireBackendAuth, async (req, res) => {
  if (!req.auth?.canViewAllSessions) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const convResult = await pool.query('SELECT * FROM "Conversations" ORDER BY "updatedAt" DESC');
    res.json(convResult.rows.filter((row) => canAccessConversation(req.auth, row)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new conversation
app.post('/api/conversations', requireBackendAuth, async (req, res) => {
  const { id, title, agentId, sessionKey, projectId, status, createdAt, updatedAt, employeeId } = req.body;
  const requestedConversation = { id, title, agentId, sessionKey, employeeId };
  if (!canAccessConversation(req.auth, requestedConversation)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    await pool.query(
      `INSERT INTO "Conversations" ("id", "title", "agentId", "sessionKey", "projectId", "status", "createdAt", "updatedAt", "employeeId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ("id")
       DO UPDATE SET
         "title" = COALESCE(EXCLUDED."title", "Conversations"."title"),
         "agentId" = COALESCE(EXCLUDED."agentId", "Conversations"."agentId"),
         "sessionKey" = COALESCE(EXCLUDED."sessionKey", "Conversations"."sessionKey"),
         "projectId" = COALESCE(EXCLUDED."projectId", "Conversations"."projectId"),
         "status" = COALESCE(EXCLUDED."status", "Conversations"."status"),
         "updatedAt" = COALESCE(EXCLUDED."updatedAt", "Conversations"."updatedAt"),
         "employeeId" = COALESCE(EXCLUDED."employeeId", "Conversations"."employeeId")`,
      [id, title, agentId, sessionKey, projectId, status, createdAt, updatedAt, employeeId]
    );
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a conversation (title, status, updatedAt)
app.put('/api/conversations/:id', requireBackendAuth, async (req, res) => {
  const { id } = req.params;
  const { title, status, updatedAt } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1', [id]);
    const conversation = existing.rows[0];
    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!canAccessConversation(req.auth, conversation)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
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
app.post('/api/messages', requireBackendAuth, async (req, res) => {
  const { messages } = req.body; // array of message objects
  if (!messages || !messages.length) return res.json({ success: true });
  
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const msg of messages) {
      const conversationResult = await client.query(
        'SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1',
        [msg.conversationId]
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        throw new Error(`Conversation not found for message ${msg.id}`);
      }
      if (!canAccessConversation(req.auth, conversation)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: 'Forbidden' });
      }
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

// Receive automation event from backend orchestrators/agents
app.post('/api/automation/agent-event', async (req, res) => {
  if (automationSyncToken) {
    const incomingToken = req.get('x-automation-sync-token') || '';
    if (incomingToken !== automationSyncToken) {
      return res.status(401).json({ error: 'Unauthorized automation sync token' });
    }
  }

  const {
    workflowId,
    employeeId = 'pho_phong',
    agentId = 'pho_phong',
    title,
    role = 'assistant',
    type = 'regular',
    content,
    timestamp = Date.now(),
    eventId,
  } = req.body || {};

  if (!workflowId || !content) {
    return res.status(400).json({ error: 'workflowId and content are required' });
  }

  const safeTimestamp = Number(timestamp) || Date.now();
  const sessionKey = `automation:${agentId}:${workflowId}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ưu tiên tìm conversation hiện có theo sessionKey để "đồng nhất"
    const existingResult = await client.query(
      'SELECT "id", "employeeId" FROM "Conversations" WHERE "sessionKey" = $1 LIMIT 1',
      [sessionKey]
    );

    let conversationId;
    let finalEmployeeId = employeeId;

    if (existingResult.rows.length > 0) {
      conversationId = existingResult.rows[0].id;
      finalEmployeeId = existingResult.rows[0].employeeId; // Dùng lại employeeId của session gốc (Draft)
    } else {
      conversationId = `auto_${employeeId}_${workflowId}`;
    }

    const messageId = eventId || `auto_msg_${workflowId}_${safeTimestamp}_${role}_${type}`;
    const conversationTitle = title || `[AUTO] ${agentId} • ${workflowId}`;
    const nextStatus = type === 'approval_request' ? 'pending_approval' : 'active';

    await client.query(
      `INSERT INTO "Conversations" ("id", "title", "agentId", "sessionKey", "projectId", "status", "createdAt", "updatedAt", "employeeId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT ("id")
       DO UPDATE SET 
         "updatedAt" = EXCLUDED."updatedAt", 
         "status" = CASE 
           WHEN "Conversations"."status" IN ('cancelled', 'stopped') THEN "Conversations"."status" 
           ELSE EXCLUDED."status" 
         END,
         "title" = EXCLUDED."title"`,
      [
        conversationId,
        conversationTitle,
        agentId,
        sessionKey,
        null,
        nextStatus,
        safeTimestamp,
        safeTimestamp,
        finalEmployeeId,
      ]
    );

    await client.query(
      `INSERT INTO "Messages" ("id", "conversationId", "role", "type", "content", "timestamp")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content", "timestamp" = EXCLUDED."timestamp"`,
      [messageId, conversationId, role, type, String(content).slice(0, 4000), safeTimestamp]
    );

    await client.query('COMMIT');
    return res.json({ success: true, conversationId, messageId });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


// Delete a conversation
app.delete('/api/conversations/:id', requireBackendAuth, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query('SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1', [id]);
    const conversation = existing.rows[0];
    if (!conversation) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!canAccessConversation(req.auth, conversation)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: 'Forbidden' });
    }
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
