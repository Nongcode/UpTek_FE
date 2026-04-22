require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pool = require('./database');
const {
  buildLoginResponse,
  canAccessConversation,
  canAccessEmployeeId,
  requireBackendAuth,
} = require('./auth');
const { injectAutomationMessage } = require('./gateway-sync');

const app = express();
app.use(cors());
app.use(express.json());
const automationSyncToken = process.env.AUTOMATION_SYNC_TOKEN || "";

function normalizeAgentId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(normalized) ? normalized : undefined;
}

function resolveAccessibleAutomationAgents(auth) {
  if (auth?.canViewAllSessions) {
    return [];
  }

  return [...new Set([
    auth?.lockedAgentId,
    auth?.employeeId,
    ...(auth?.visibleAgentIds || []),
  ].map(normalizeAgentId).filter(Boolean))];
}

function isAutomationConversation(conversation) {
  const sessionKey = String(conversation?.sessionKey || '');
  const id = String(conversation?.id || '');
  const title = String(conversation?.title || '');
  return (
    sessionKey.startsWith('automation:')
    || id.startsWith('auto_')
    || title.startsWith('[AUTO]')
  );
}

// Log every request for easier debugging.
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

// Clean up orphaned messages at startup.
(async () => {
  try {
    const result = await pool.query('DELETE FROM "Messages" WHERE "conversationId" IS NULL');
    if (result.rowCount > 0) {
      console.log(`Deleted ${result.rowCount} orphaned messages.`);
    }
  } catch (err) {
    console.error('Failed to clean up Messages:', err.message);
  }
})();

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "Images" (
        "id" VARCHAR(255) PRIMARY KEY,
        "url" TEXT NOT NULL,
        "companyId" VARCHAR(255),
        "departmentId" VARCHAR(255),
        "source" VARCHAR(50),
        "uploaderId" VARCHAR(255),
        "createdAt" BIGINT,
        "productModel" VARCHAR(255),
        "prefix" VARCHAR(255)
      );
    `);
    console.log('Ensure Images table exists.');
  } catch (err) {
    console.error('Failed to create Images table:', err.message);
  }
})();

const storageDir = path.join(__dirname, '../storage/images');
if (!fs.existsSync(storageDir)) {
  fs.mkdirSync(storageDir, { recursive: true });
}

app.use('/storage/images', express.static(storageDir));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const auth = req.auth || {};
    let companyId = auth.companyId || 'default_company';
    let departmentId = auth.departmentId || 'default_dept';

    // Allow high-level roles to override storage destination via request body
    const canOverride = auth.employeeId === 'admin' || auth.employeeId === 'Admin' || auth.employeeId === 'main' || auth.employeeId === 'giam_doc';
    if (canOverride) {
      if (req.body.companyId) companyId = req.body.companyId;
      if (req.body.departmentId) departmentId = req.body.departmentId;
    }

    const dir = path.join(storageDir, companyId, departmentId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const timestamp = Date.now();
    cb(null, `${timestamp}_${file.originalname}`);
  }
});
const upload = multer({ storage: storage });

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

app.get('/api/gallery', requireBackendAuth, async (req, res) => {
  try {
    let result;
    if (req.auth?.canViewAllSessions || req.auth?.employeeId === 'pho_phong' || req.auth?.employeeId === 'admin' || req.auth?.employeeId === 'quan_ly') {
      result = await pool.query('SELECT * FROM "Images" ORDER BY "createdAt" DESC');
    } else {
      const companyId = req.auth?.companyId;
      const departmentId = req.auth?.departmentId;
      result = await pool.query(
        'SELECT * FROM "Images" WHERE "companyId" = $1 AND "departmentId" = $2 ORDER BY "createdAt" DESC',
        [companyId, departmentId]
      );
    }
    return res.json(result.rows);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/gallery/upload', requireBackendAuth, upload.array('images', 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No images uploaded' });
  }
  
  const { productModel } = req.body;
  if (!productModel) {
    return res.status(400).json({ error: 'productModel is required for manual uploads' });
  }

  const auth = req.auth || {};
  let companyId = auth.companyId || 'default_company';
  let departmentId = auth.departmentId || 'default_dept';

  const canOverride = auth.employeeId === 'admin' || auth.employeeId === 'Admin' || auth.employeeId === 'main' || auth.employeeId === 'giam_doc';
  if (canOverride) {
    if (req.body.companyId) companyId = req.body.companyId;
    if (req.body.departmentId) departmentId = req.body.departmentId;
  }

  const uploaderId = auth.employeeId || 'unknown';
  const createdAt = Date.now();
  const source = 'User';
  const prefix = null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const uploadedImages = [];

    for (const file of req.files) {
      const url = `/storage/images/${companyId}/${departmentId}/${file.filename}`;
      const id = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      await client.query(
        `INSERT INTO "Images" ("id", "url", "companyId", "departmentId", "source", "uploaderId", "createdAt", "productModel", "prefix")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, url, companyId, departmentId, source, uploaderId, createdAt, productModel, prefix]
      );
      uploadedImages.push({ id, url });
    }

    await client.query('COMMIT');
    return res.json({ success: true, count: uploadedImages.length, images: uploadedImages });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/gallery/agent-upload', async (req, res) => {
  if (automationSyncToken) {
    const incomingToken = req.get('x-automation-sync-token') || '';
    if (incomingToken !== automationSyncToken) {
      return res.status(401).json({ error: 'Unauthorized automation sync token' });
    }
  }

  const { companyId = 'default_company', departmentId = 'default_dept', filename, base64Data, agentId, productModel, prefix } = req.body;
  if (!filename || !base64Data || !productModel || !prefix) {
    return res.status(400).json({ error: 'filename, base64Data, productModel, and prefix are required' });
  }

  const dir = path.join(storageDir, companyId, departmentId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const timestamp = Date.now();
  const safeFilename = `${timestamp}_${filename.replace(/[^a-zA-Z0-9.\-_]/g, '')}`;
  const filePath = path.join(dir, safeFilename);

  fs.writeFileSync(filePath, base64Data, 'base64');

  const url = `/storage/images/${companyId}/${departmentId}/${safeFilename}`;
  const id = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const source = 'AI';
  const uploaderId = agentId || 'agent';

  try {
    await pool.query(
      `INSERT INTO "Images" ("id", "url", "companyId", "departmentId", "source", "uploaderId", "createdAt", "productModel", "prefix")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, url, companyId, departmentId, source, uploaderId, timestamp, productModel, prefix]
    );
    return res.json({ success: true, url, id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversations/:employeeId', requireBackendAuth, async (req, res) => {
  const { employeeId } = req.params;
  const includeAutomation = req.query.includeAutomation === '1' || req.query.includeAutomation === 'true';
  if (!canAccessEmployeeId(req.auth, employeeId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const convResult = await pool.query(
      'SELECT * FROM "Conversations" WHERE "employeeId" = $1 ORDER BY "updatedAt" DESC',
      [employeeId]
    );

    let convRows = convResult.rows;

    if (includeAutomation) {
      const requestedAgentId = normalizeAgentId(employeeId);
      const authEmployeeId = normalizeAgentId(req.auth?.employeeId);
      const authLockedAgentId = normalizeAgentId(req.auth?.lockedAgentId);
      const isOwnScope = requestedAgentId && (requestedAgentId === authEmployeeId || requestedAgentId === authLockedAgentId);
      let autoRows = [];

      if (req.auth?.canViewAllSessions) {
        const autoResult = await pool.query(
          `SELECT *
           FROM "Conversations"
           WHERE "sessionKey" LIKE 'automation:%'
              OR "id" LIKE 'auto_%'
              OR "title" LIKE '[AUTO]%'
           ORDER BY "updatedAt" DESC`
        );
        autoRows = autoResult.rows;
      } else if (isOwnScope) {
        const accessibleAgentIds = resolveAccessibleAutomationAgents(req.auth);
        if (accessibleAgentIds.length > 0) {
          const autoResult = await pool.query(
            `SELECT *
             FROM "Conversations"
             WHERE (
               "agentId" = ANY($1::text[])
               OR "employeeId" = ANY($1::text[])
             )
               AND (
                 "sessionKey" LIKE 'automation:%'
                 OR "id" LIKE 'auto_%'
                 OR "title" LIKE '[AUTO]%'
               )
             ORDER BY "updatedAt" DESC`,
            [accessibleAgentIds]
          );
          autoRows = autoResult.rows;
        }
      } else if (requestedAgentId) {
        const autoResult = await pool.query(
          `SELECT *
           FROM "Conversations"
           WHERE (
             "agentId" = $1
             OR "employeeId" = $1
           )
             AND (
               "sessionKey" LIKE 'automation:%'
               OR "id" LIKE 'auto_%'
               OR "title" LIKE '[AUTO]%'
             )
           ORDER BY "updatedAt" DESC`,
          [requestedAgentId]
        );
        autoRows = autoResult.rows;
      }

      const existingIds = new Set(convRows.map((conversation) => conversation.id));
      for (const row of autoRows) {
        if (!existingIds.has(row.id)) {
          convRows.push(row);
          existingIds.add(row.id);
        }
      }
    }

    if (!includeAutomation) {
      convRows = convRows.filter((row) => !isAutomationConversation(row));
    }

    if (convRows.length === 0) {
      return res.json([]);
    }

    const convIds = convRows.map((conversation) => conversation.id);
    const placeholders = convIds.map((_, index) => `$${index + 1}`).join(',');

    const msgResult = await pool.query(
      `SELECT * FROM "Messages" WHERE "conversationId" IN (${placeholders}) ORDER BY "timestamp" ASC`,
      convIds
    );
    const msgRows = msgResult.rows;

    const result = convRows
      .map((conversation) => ({
        ...conversation,
        messages: msgRows.filter((message) => message.conversationId === conversation.id),
      }))
      .filter((conversation) => canAccessConversation(req.auth, conversation));

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversations-global', requireBackendAuth, async (req, res) => {
  if (!req.auth?.canViewAllSessions) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const convResult = await pool.query('SELECT * FROM "Conversations" ORDER BY "updatedAt" DESC');
    return res.json(convResult.rows.filter((row) => canAccessConversation(req.auth, row)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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
    return res.json({ success: true, id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/messages', requireBackendAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !messages.length) {
    return res.json({ success: true });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const message of messages) {
      const conversationResult = await client.query(
        'SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1',
        [message.conversationId]
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) {
        throw new Error(`Conversation not found for message ${message.id}`);
      }
      if (!canAccessConversation(req.auth, conversation)) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Forbidden' });
      }
      await client.query(
        `INSERT INTO "Messages" ("id", "conversationId", "role", "type", "content", "timestamp")
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content"`,
        [message.id, message.conversationId, message.role, message.type, message.content, message.timestamp]
      );
    }
    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

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
  const canonicalConversationId = `auto_${employeeId}_${workflowId}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let shouldInjectToGateway = false;

    const existingResult = await client.query(
      'SELECT "id", "employeeId" FROM "Conversations" WHERE "sessionKey" = $1 LIMIT 1',
      [sessionKey]
    );

    let conversationId;
    let finalEmployeeId = employeeId;

    if (existingResult.rows.length > 0) {
      conversationId = existingResult.rows[0].id;
      finalEmployeeId = existingResult.rows[0].employeeId || employeeId;
    } else {
      const draftResult = await client.query(
        `SELECT "id", "employeeId"
         FROM "Conversations"
         WHERE "agentId" = $1
           AND (
             "sessionKey" LIKE $2
             OR "sessionKey" LIKE $3
           )
         ORDER BY "updatedAt" DESC
         LIMIT 1`,
        [
          agentId,
          `automation:${agentId}:conv_%`,
          `automation:${agentId}:${employeeId}:conv_%`,
        ]
      );

      conversationId = canonicalConversationId;

      if (draftResult.rows.length > 0) {
        const draftConversationId = draftResult.rows[0].id;
        finalEmployeeId = draftResult.rows[0].employeeId || employeeId;

        await client.query('DELETE FROM "Conversations" WHERE "id" = $1', [conversationId]);
        await client.query(
          'UPDATE "Messages" SET "conversationId" = $1 WHERE "conversationId" = $2',
          [conversationId, draftConversationId]
        );
        await client.query('DELETE FROM "Conversations" WHERE "id" = $1', [draftConversationId]);
      }
    }

    const messageId = eventId || `auto_msg_${workflowId}_${safeTimestamp}_${role}_${type}`;
    const conversationTitle = title || `[AUTO] ${agentId} • ${workflowId}`;
    const nextStatus = type === 'approval_request' ? 'pending_approval' : 'active';

    const existingMessageResult = await client.query(
      'SELECT 1 FROM "Messages" WHERE "id" = $1 LIMIT 1',
      [messageId]
    );
    shouldInjectToGateway = existingMessageResult.rows.length === 0;

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
         "title" = EXCLUDED."title",
         "sessionKey" = EXCLUDED."sessionKey",
         "employeeId" = COALESCE("Conversations"."employeeId", EXCLUDED."employeeId")`,
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

    if (shouldInjectToGateway) {
      try {
        await injectAutomationMessage({
          sessionKey,
          content: String(content).slice(0, 4000),
          eventId: messageId,
          label: agentId,
        });
      } catch (syncError) {
        console.error('Failed to sync automation message to gateway transcript:', syncError.message);
      }
    }

    return res.json({ success: true, conversationId, messageId });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/conversations/:id', requireBackendAuth, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1', [id]);
    const conversation = existing.rows[0];
    if (!conversation) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (!canAccessConversation(req.auth, conversation)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden' });
    }
    await client.query('DELETE FROM "Messages" WHERE "conversationId" = $1', [id]);
    await client.query('DELETE FROM "Conversations" WHERE "id" = $1', [id]);
    await client.query('COMMIT');
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Backend Server is running on http://localhost:${PORT}`);
});
