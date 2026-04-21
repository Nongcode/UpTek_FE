require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
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
  // Ưu tiên lane column từ DB (sau migration v2)
  if (conversation?.lane === 'automation') return true;
  // Fallback cho data cũ chưa backfill
  const sessionKey = String(conversation?.sessionKey || '');
  const id = String(conversation?.id || '');
  return (
    sessionKey.startsWith('automation:')
    || sessionKey.startsWith('wf:')
    || id.startsWith('auto_')
  );
}

// --- Session Key Generator (Commit 3) ---
function generateConversationId() {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function generateSessionKey(agentId, conversationId, lane, workflowId) {
  if (lane === 'automation' && workflowId) {
    return `agent:${agentId}:automation:${workflowId}:${conversationId}`;
  }
  return `chat:${agentId}:${conversationId}`;
}

function normalizeWorkflowConversationStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) {
    return 'active';
  }
  if (normalized === 'cancelled') {
    return 'cancelled';
  }
  if (normalized === 'published' || normalized === 'scheduled' || normalized === 'approved') {
    return 'approved';
  }
  if (normalized.startsWith('awaiting_')) {
    return 'pending_approval';
  }
  return 'active';
}

// --- Internal Auth Middleware (Commit 4) ---
function requireInternalAuth(req, res, next) {
  if (!automationSyncToken) {
    console.error('[SECURITY] AUTOMATION_SYNC_TOKEN not set — rejecting internal request');
    return res.status(500).json({ error: 'Internal auth not configured' });
  }
  const incomingToken = req.get('x-automation-sync-token') || '';
  if (incomingToken !== automationSyncToken) {
    return res.status(401).json({ error: 'Unauthorized internal request' });
  }
  next();
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

function normalizePreviewPath(value) {
  return path.resolve(String(value || '')).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function isAllowedPreviewPath(filePath) {
  const resolved = normalizePreviewPath(filePath);
  const allowedRoots = [
    storageDir,
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), 'openclaw'),
  ].map(normalizePreviewPath);

  return allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

app.use('/storage/images', express.static(storageDir));

app.get('/api/media-preview', requireBackendAuth, async (req, res) => {
  const rawPath = String(req.query.path || '').trim();
  if (!rawPath) {
    return res.status(400).json({ error: 'path is required' });
  }

  const resolvedPath = path.resolve(rawPath);
  if (!isAllowedPreviewPath(resolvedPath)) {
    return res.status(403).json({ error: 'Forbidden preview path' });
  }

  if (!/\.(png|jpe?g|webp|gif|bmp|svg|mp4|webm|mov)$/i.test(resolvedPath)) {
    return res.status(400).json({ error: 'Unsupported preview file type' });
  }

  if (!fs.existsSync(resolvedPath)) {
    return res.status(404).json({ error: 'Preview file not found' });
  }

  return res.sendFile(resolvedPath);
});

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

app.post('/api/gallery/upload', requireBackendAuth, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }
  
  const { productModel } = req.body;
  if (!productModel) {
    return res.status(400).json({ error: 'productModel is required for manual uploads' });
  }

  const auth = req.auth || {};
  let companyId = auth.companyId || 'default_company';
  let departmentId = auth.departmentId || 'default_dept';

  // Validate and apply overrides from request body if authorized
  const canOverride = auth.employeeId === 'admin' || auth.employeeId === 'Admin' || auth.employeeId === 'main' || auth.employeeId === 'giam_doc';
  if (canOverride) {
    if (req.body.companyId) companyId = req.body.companyId;
    if (req.body.departmentId) departmentId = req.body.departmentId;
  }

  const url = `/storage/images/${companyId}/${departmentId}/${req.file.filename}`;
  const id = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const source = 'User';
  const uploaderId = auth.employeeId || 'unknown';
  const createdAt = Date.now();
  const prefix = null; // User upload doesn't have prefix naturally, or it can be derived if needed, wait, prompt says only agent needs prefix.

  try {
    await pool.query(
      `INSERT INTO "Images" ("id", "url", "companyId", "departmentId", "source", "uploaderId", "createdAt", "productModel", "prefix")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, url, companyId, departmentId, source, uploaderId, createdAt, productModel, prefix]
    );
    return res.json({ success: true, url, id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
           WHERE "lane" = 'automation'
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
               AND "lane" = 'automation'
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
             AND "lane" = 'automation'
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
  const { title, agentId, lane = 'user', workflowId, employeeId: bodyEmployeeId } = req.body;
  const employeeId = req.auth?.employeeId || bodyEmployeeId;

  // BE sinh id + sessionKey (Commit 3)
  const id = generateConversationId();
  const effectiveWorkflowId = (lane === 'automation' && !workflowId)
    ? `wf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    : workflowId || null;
  const sessionKey = generateSessionKey(agentId, id, lane, effectiveWorkflowId);
  const now = Date.now();
  const convTitle = title || (lane === 'automation' ? 'Luồng tự động mới' : 'Cuộc trò chuyện mới');

  const requestedConversation = { id, title: convTitle, agentId, sessionKey, employeeId };
  if (!canAccessConversation(req.auth, requestedConversation)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await pool.query(
      `INSERT INTO "Conversations"
       ("id","title","agentId","sessionKey","status","createdAt","updatedAt","employeeId","lane","role","workflowId","parentConversationId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, convTitle, agentId, sessionKey, 'active', now, now, employeeId, lane, 'root', effectiveWorkflowId, null]
    );

    // Nếu automation → tạo Workflow record
    if (lane === 'automation' && effectiveWorkflowId) {
      await pool.query(
        `INSERT INTO "Workflows" ("id","rootConversationId","initiatorAgentId","initiatorEmployeeId","status","title","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT ("id") DO NOTHING`,
        [effectiveWorkflowId, id, agentId, employeeId, 'active', convTitle, now, now]
      );
    }

    // Trả full conversation object để FE dùng trực tiếp
    return res.json({
      id, title: convTitle, agentId, sessionKey, status: 'active',
      lane, role: 'root', workflowId: effectiveWorkflowId,
      employeeId, createdAt: now, updatedAt: now, messages: [],
    });
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
    const conversationIds = [...new Set(messages.map((m) => m.conversationId).filter(Boolean))];
    broadcastSSE('message.created', { conversationIds });
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
      // Commit 6: Exact lookup thay vì LIKE merge
      const exactResult = await client.query(
        `SELECT "id", "employeeId"
         FROM "Conversations"
         WHERE "workflowId" = $1 AND "agentId" = $2
         ORDER BY "updatedAt" DESC LIMIT 1`,
        [workflowId, agentId]
      );

      conversationId = canonicalConversationId;

      if (exactResult.rows.length > 0) {
        conversationId = exactResult.rows[0].id;
        finalEmployeeId = exactResult.rows[0].employeeId || employeeId;
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
         "employeeId" = COALESCE("Conversations"."employeeId", EXCLUDED."employeeId"),
         "lane" = 'automation',
         "workflowId" = COALESCE("Conversations"."workflowId", $10)`,
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
        workflowId || null,
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

// ===================== INTERNAL API (Commit 5) =====================
// Orchestrator gọi các routes này để persist sub-agent conversations/messages.
// Xác thực bằng AUTOMATION_SYNC_TOKEN.

// 1. Tạo workflow
app.post('/internal/workflows', requireInternalAuth, async (req, res) => {
  const { id, rootConversationId, initiatorAgentId, initiatorEmployeeId, title, inputPayload } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let resolvedRootConversationId = rootConversationId || null;
    if (!resolvedRootConversationId && initiatorAgentId) {
      const inferredRoot = await client.query(
        `SELECT "id"
         FROM "Conversations"
         WHERE "lane" = 'automation'
           AND "role" = 'root'
           AND (
             "agentId" = $1
             OR "employeeId" = COALESCE($2, $1)
             OR "employeeId" = $1
           )
         ORDER BY "updatedAt" DESC, "createdAt" DESC
         LIMIT 1`,
        [initiatorAgentId, initiatorEmployeeId || null]
      );
      resolvedRootConversationId = inferredRoot.rows[0]?.id || null;
    }

    await client.query(
      `INSERT INTO "Workflows"
       ("id","rootConversationId","initiatorAgentId","initiatorEmployeeId","status","title","inputPayload","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT ("id") DO UPDATE SET
         "updatedAt" = EXCLUDED."updatedAt",
         "status" = COALESCE(EXCLUDED."status", "Workflows"."status"),
         "rootConversationId" = COALESCE(EXCLUDED."rootConversationId", "Workflows"."rootConversationId")`,
      [
        id,
        resolvedRootConversationId,
        initiatorAgentId,
        initiatorEmployeeId || initiatorAgentId,
        'active',
        title,
        inputPayload || null,
        now,
        now,
      ]
    );

    if (resolvedRootConversationId) {
      await client.query(
        `UPDATE "Conversations"
         SET "workflowId" = $1,
             "lane" = 'automation',
             "updatedAt" = $2
         WHERE "id" = $3`,
        [id, now, resolvedRootConversationId]
      );
    }

    await client.query('COMMIT');
    return res.json({ success: true, id, rootConversationId: resolvedRootConversationId });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 2. Tạo sub-agent conversation (orchestrator gọi khi giao việc)
app.post('/internal/conversations', requireInternalAuth, async (req, res) => {
  const { workflowId, agentId, employeeId, parentConversationId, title, lane = 'automation' } = req.body;
  if (!workflowId || !agentId) {
    return res.status(400).json({ error: 'workflowId and agentId are required' });
  }

  try {
    // Reuse nếu đã tồn tại conversation cho (workflowId, agentId, sub_agent)
    const existing = await pool.query(
      `SELECT "id","sessionKey","parentConversationId" FROM "Conversations"
       WHERE "workflowId" = $1 AND "agentId" = $2 AND "role" = 'sub_agent' LIMIT 1`,
      [workflowId, agentId]
    );
    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    }

    let resolvedParentConversationId = parentConversationId || null;
    let resolvedEmployeeId = employeeId || agentId;
    const workflowResult = await pool.query(
      `SELECT w."rootConversationId", w."initiatorEmployeeId", c."employeeId" AS "rootEmployeeId"
       FROM "Workflows" w
       LEFT JOIN "Conversations" c ON c."id" = w."rootConversationId"
       WHERE w."id" = $1
       LIMIT 1`,
      [workflowId]
    );
    const workflowRow = workflowResult.rows[0];
    if (!resolvedParentConversationId) {
      resolvedParentConversationId = workflowRow?.rootConversationId || null;
    }
    if (!employeeId) {
      resolvedEmployeeId =
        workflowRow?.rootEmployeeId
        || workflowRow?.initiatorEmployeeId
        || agentId;
    }

    const id = generateConversationId();
    const sessionKey = generateSessionKey(agentId, id, lane, workflowId);
    const now = Date.now();

    await pool.query(
      `INSERT INTO "Conversations"
       ("id","title","agentId","sessionKey","status","createdAt","updatedAt","employeeId","lane","role","workflowId","parentConversationId")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        id,
        title || `[AUTO] ${agentId} • ${workflowId}`,
        agentId,
        sessionKey,
        'active',
        now,
        now,
        resolvedEmployeeId,
        lane,
        'sub_agent',
        workflowId,
        resolvedParentConversationId,
      ]
    );

    return res.json({
      id,
      sessionKey,
      agentId,
      workflowId,
      parentConversationId: resolvedParentConversationId,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 3. Persist messages từ orchestrator/sub-agent
app.post('/internal/messages', requireInternalAuth, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.json({ success: true });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const msg of messages) {
      await client.query(
        `INSERT INTO "Messages" ("id","conversationId","role","type","content","timestamp")
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content", "timestamp" = EXCLUDED."timestamp"`,
        [msg.id, msg.conversationId, msg.role, msg.type || 'regular', msg.content, msg.timestamp || Date.now()]
      );
    }
    // Update conversation updatedAt
    const convIds = [...new Set(messages.map(m => m.conversationId).filter(Boolean))];
    for (const convId of convIds) {
      await client.query('UPDATE "Conversations" SET "updatedAt" = $1 WHERE "id" = $2', [Date.now(), convId]);
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

// 4. Update workflow status
app.patch('/internal/workflows/:id/status', requireInternalAuth, async (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status is required' });
  const now = Date.now();
  try {
    const workflowResult = await pool.query(
      `UPDATE "Workflows"
       SET "status" = $1, "updatedAt" = $2
       WHERE "id" = $3
       RETURNING "rootConversationId"`,
      [status, now, req.params.id]
    );

    const rootConversationId = workflowResult.rows[0]?.rootConversationId || null;
    if (rootConversationId) {
      await pool.query(
        `UPDATE "Conversations"
         SET "status" = $1, "updatedAt" = $2
         WHERE "id" = $3`,
        [normalizeWorkflowConversationStatus(status), now, rootConversationId]
      );
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ===================== SSE — Realtime events (Phase 3) =====================
// Clients connect to GET /api/events và nhận các event: workflow.*, conversation.*, message.*
// Mỗi event là text/event-stream theo chuẩn Server-Sent Events.

const sseClients = new Set();

function broadcastSSE(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* client đã đóng */ }
  }
}

// Expose để internal routes gọi
app.locals.broadcastSSE = broadcastSSE;

app.get('/api/events', requireBackendAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Heartbeat mỗi 25s để tránh proxy timeout
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  sseClients.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// Middleware broadcast SSE sau khi response thành công
app.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = function (body) {
    // Broadcast sau khi response thành công
    if (res.statusCode < 400 && body?.success !== false) {
      if (req.method === 'POST' && req.path === '/internal/workflows' && body?.id) {
        broadcastSSE('workflow.created', { id: body.id });
      }
      if (req.method === 'PATCH' && req.path?.startsWith('/internal/workflows/') && req.path?.endsWith('/status')) {
        const wfId = req.path.split('/')[3];
        broadcastSSE('workflow.updated', { id: wfId, status: req.body?.status });
      }
      if (req.method === 'POST' && req.path === '/internal/conversations' && body?.id) {
        broadcastSSE('conversation.created', { id: body.id, agentId: body.agentId, workflowId: body.workflowId, sessionKey: body.sessionKey });
      }
      if (req.method === 'POST' && req.path === '/internal/messages' && body?.success) {
        broadcastSSE('message.created', { conversationIds: [...new Set((req.body?.messages || []).map((m) => m.conversationId).filter(Boolean))] });
      }
      if (req.method === 'POST' && req.path === '/api/automation/agent-event' && body?.conversationId) {
        broadcastSSE('message.created', { conversationIds: [body.conversationId] });
      }
      if (req.method === 'POST' && req.path === '/api/conversations' && body?.id) {
        broadcastSSE('conversation.created', { id: body.id, agentId: body.agentId, lane: body.lane, workflowId: body.workflowId });
      }
    }
    return origJson(body);
  };
  next();
});

app.listen(PORT, () => {
  console.log(`Backend Server is running on http://localhost:${PORT}`);
});
