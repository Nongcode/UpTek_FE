require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('./database');
const mediaConfig = require('./config/media');
const createMediaLegacyRoutes = require('./routes/mediaLegacyRoutes');
const mediaRoutes = require('./routes/mediaRoutes');
const {
  buildLoginResponse,
  buildRefreshResponse,
  canAccessConversation,
  canAccessEmployeeId,
  requireBackendAuth,
} = require('./auth');
const {
  buildCanonicalAutomationConversationId,
  buildConversationBroadcastPayload,
  buildConversationSessionKey,
  buildMessageBroadcastPayload,
  buildWorkflowBroadcastPayload,
  hydrateConversationRecord,
  inferConversationLane,
  normalizeConversationLane,
  normalizeConversationRole,
  normalizeMessageContent,
  sanitizeMessageRole,
  sanitizeMessageType,
} = require('./chat-consistency');
const { injectAutomationMessage } = require('./gateway-sync');

const app = express();
app.use(cors());
app.use(express.json({ limit: `${mediaConfig.jsonBodyLimitMb}mb` }));
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
  return inferConversationLane(conversation) === 'automation';
}

// --- Session Key Generator (Commit 3) ---
function generateConversationId() {
  return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeWorkflowConversationStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) {
    return 'active';
  }
  if (normalized === 'cancelled') {
    return 'cancelled';
  }
  if (normalized === 'stopped') {
    return 'stopped';
  }
  if (normalized === 'error' || normalized === 'failed') {
    return 'error';
  }
  if (normalized === 'published' || normalized === 'scheduled' || normalized === 'approved') {
    return 'approved';
  }
  if (normalized.startsWith('awaiting_')) {
    return 'pending_approval';
  }
  return 'active';
}

function logSSEWarning(eventName, error) {
  console.warn(`[SSE WARN] ${eventName}: ${error?.message || error}`);
}

function safeBroadcastSSE(eventName, data) {
  try {
    broadcastSSE(eventName, data);
  } catch (error) {
    logSSEWarning(eventName, error);
  }
}

function broadcastConversationCreated(record) {
  const payload = buildConversationBroadcastPayload(record);
  if (payload) {
    safeBroadcastSSE('conversation.created', payload);
  }
}

function broadcastConversationUpdated(record) {
  const payload = buildConversationBroadcastPayload(record);
  if (payload) {
    safeBroadcastSSE('conversation.updated', payload);
  }
}

function broadcastConversationDeleted(record) {
  const payload = buildConversationBroadcastPayload(record);
  if (payload) {
    safeBroadcastSSE('conversation.deleted', payload);
  }
}

function broadcastWorkflowCreated(record) {
  const payload = buildWorkflowBroadcastPayload(record);
  if (payload) {
    safeBroadcastSSE('workflow.created', payload);
  }
}

function broadcastWorkflowUpdated(record) {
  const payload = buildWorkflowBroadcastPayload(record);
  if (payload) {
    safeBroadcastSSE('workflow.updated', payload);
  }
}

function broadcastMessageEvent(messages, conversationsById) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }

  if (messages.length === 1) {
    const message = messages[0];
    safeBroadcastSSE(
      'message.created',
      buildMessageBroadcastPayload(message, conversationsById[message.conversationId] || null),
    );
    return;
  }

  const conversationIds = [...new Set(messages.map((message) => message.conversationId).filter(Boolean))];
  safeBroadcastSSE('message.created', {
    conversationIds,
    ids: messages.map((message) => message.id),
    timestamp: Math.max(...messages.map((message) => Number(message.timestamp) || 0)),
  });
}

function validateMessagePayload(message, conversation) {
  const role = sanitizeMessageRole(message.role);
  if (!role) {
    return { ok: false, error: `Invalid message role for ${message.id || 'unknown'}` };
  }

  const type = sanitizeMessageType(message.type);
  if (!type) {
    return { ok: false, error: `Invalid message type for ${message.id || 'unknown'}` };
  }

  const content = normalizeMessageContent(message.content);
  if (!content) {
    return { ok: false, error: `Message content is required for ${message.id || 'unknown'}` };
  }

  const hydratedConversation = hydrateConversationRecord(conversation);
  if (!hydratedConversation) {
    return { ok: false, error: `Conversation not found for message ${message.id || 'unknown'}` };
  }

  if (hydratedConversation.lane === 'user' && hydratedConversation.workflowId) {
    return { ok: false, error: `Personal conversation ${hydratedConversation.id} cannot have workflowId` };
  }

  if (hydratedConversation.lane === 'user' && hydratedConversation.parentConversationId) {
    return { ok: false, error: `Personal conversation ${hydratedConversation.id} cannot have parentConversationId` };
  }

  return {
    ok: true,
    role,
    type,
    content,
    timestamp: Number(message.timestamp) || Date.now(),
    conversation: hydratedConversation,
  };
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

function normalizePreviewPath(value) {
  return path.resolve(String(value || '')).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase();
}

function isAllowedPreviewPath(filePath) {
  const resolved = normalizePreviewPath(filePath);
  const storageDir = mediaConfig.galleryStorageRoot;
  const allowedRoots = [
    storageDir,
    path.join(os.homedir(), '.openclaw'),
    path.join(os.homedir(), 'openclaw'),
  ].map(normalizePreviewPath);

  return allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`));
}

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

app.use(createMediaLegacyRoutes({ automationSyncToken }));
app.use(mediaRoutes);

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

app.post('/api/auth/refresh', async (req, res) => {
  const { token, employeeId, employeeName } = req.body || {};
  const result = buildRefreshResponse({ token, employeeId, employeeName });
  if (!result) {
    return res.status(401).json({
      error: { message: 'Unable to refresh backend session', type: 'unauthorized' },
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
      `SELECT * FROM "Messages" WHERE "conversationId" IN (${placeholders}) ORDER BY "timestamp" ASC, "id" ASC`,
      convIds
    );
    const msgRows = msgResult.rows;

    const result = convRows
      .map((conversation) => ({
        ...hydrateConversationRecord(conversation),
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
    return res.json(convResult.rows.map(hydrateConversationRecord).filter((row) => canAccessConversation(req.auth, row)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversations', requireBackendAuth, async (req, res) => {
    const { title, agentId, lane = 'user', workflowId, employeeId: bodyEmployeeId } = req.body || {};
    const employeeId = req.auth?.employeeId || bodyEmployeeId;
    if (!normalizeAgentId(agentId)) {
      return res.status(400).json({ error: 'Valid agentId is required' });
    }

    const normalizedLane = normalizeConversationLane(lane, workflowId);
    const id = generateConversationId();
    const effectiveWorkflowId =
      normalizedLane === 'automation'
        ? normalizeMessageContent(workflowId) || `wf_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
        : null;
    const now = Date.now();
    const sessionKey = buildConversationSessionKey(agentId, id, normalizedLane, effectiveWorkflowId);
    const convTitle = title || (normalizedLane === 'automation' ? 'Luong tu dong moi' : 'Cuoc tro chuyen moi');
    const role = normalizeConversationRole('root', normalizedLane, null);

    const requestedConversation = {
      id,
      title: convTitle,
      agentId,
      sessionKey,
      employeeId,
      lane: normalizedLane,
      role,
      workflowId: effectiveWorkflowId,
      parentConversationId: null,
    };
    if (!canAccessConversation(req.auth, requestedConversation)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insertedConversation = (
        await client.query(
          `INSERT INTO "Conversations"
           ("id","title","agentId","sessionKey","status","createdAt","updatedAt","employeeId","lane","role","workflowId","parentConversationId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING *`,
          [id, convTitle, agentId, sessionKey, 'active', now, now, employeeId, normalizedLane, role, effectiveWorkflowId, null]
        )
      ).rows[0];

      let workflowRecord = null;
      if (normalizedLane === 'automation' && effectiveWorkflowId) {
        workflowRecord = (
          await client.query(
            `INSERT INTO "Workflows" ("id","rootConversationId","initiatorAgentId","initiatorEmployeeId","status","title","createdAt","updatedAt")
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT ("id") DO UPDATE SET
               "rootConversationId" = COALESCE("Workflows"."rootConversationId", EXCLUDED."rootConversationId"),
               "updatedAt" = EXCLUDED."updatedAt"
             RETURNING *`,
            [effectiveWorkflowId, id, agentId, employeeId, 'active', convTitle, now, now]
          )
        ).rows[0];
      }

      await client.query('COMMIT');
      if (workflowRecord) {
        broadcastWorkflowCreated(workflowRecord);
      }
      broadcastConversationCreated(insertedConversation);
      return res.json({
        ...hydrateConversationRecord(insertedConversation),
        messages: [],
      });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

app.put('/api/conversations/:id', requireBackendAuth, async (req, res) => {
    const { id } = req.params;
    const { title, status, updatedAt } = req.body || {};
    try {
      const existing = await pool.query('SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1', [id]);
      const conversation = existing.rows[0];
      if (!conversation) {
        return res.status(404).json({ error: 'Conversation not found' });
      }
      if (!canAccessConversation(req.auth, conversation)) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const patchedConversation = (
        await pool.query(
          `UPDATE "Conversations"
           SET "title" = COALESCE($1, "title"),
               "status" = COALESCE($2, "status"),
               "updatedAt" = COALESCE($3, "updatedAt")
           WHERE "id" = $4
           RETURNING *`,
          [title, status, updatedAt || Date.now(), id]
        )
      ).rows[0];

      broadcastConversationUpdated(patchedConversation);
      return res.json({ success: true, conversation: hydrateConversationRecord(patchedConversation) });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
});

app.post('/api/messages', requireBackendAuth, async (req, res) => {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({ success: true });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const persistedMessages = [];
      const conversationsById = {};

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

        const validation = validateMessagePayload(message, conversation);
        if (!validation.ok) {
          throw new Error(validation.error);
        }

        const insertedMessage = (
          await client.query(
            `INSERT INTO "Messages" ("id", "conversationId", "role", "type", "content", "timestamp")
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT ("id") DO UPDATE SET
               "role" = EXCLUDED."role",
               "type" = EXCLUDED."type",
               "content" = EXCLUDED."content",
               "timestamp" = EXCLUDED."timestamp"
             RETURNING *`,
            [message.id, message.conversationId, validation.role, validation.type, validation.content, validation.timestamp]
          )
        ).rows[0];
        persistedMessages.push(insertedMessage);
        conversationsById[message.conversationId] = validation.conversation;
      }

      for (const conversationId of Object.keys(conversationsById)) {
        const updatedConversation = (
          await client.query(
            `UPDATE "Conversations"
             SET "updatedAt" = $1
             WHERE "id" = $2
             RETURNING *`,
            [Date.now(), conversationId]
          )
        ).rows[0];
        conversationsById[conversationId] = hydrateConversationRecord(updatedConversation || conversationsById[conversationId]);
      }

      await client.query('COMMIT');
      for (const conversationId of Object.keys(conversationsById)) {
        broadcastConversationUpdated(conversationsById[conversationId]);
      }
      broadcastMessageEvent(persistedMessages, conversationsById);
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
      conversationId: requestedConversationId,
      conversationRole,
      parentConversationId,
      sessionKey: requestedSessionKey,
      status,
      injectToGateway = true,
    } = req.body || {};

    if (!normalizeMessageContent(workflowId) || !normalizeMessageContent(content)) {
      return res.status(400).json({ error: 'workflowId and content are required' });
    }

    const safeRole = sanitizeMessageRole(role);
    const safeType = sanitizeMessageType(type);
    if (!safeRole || !safeType) {
      return res.status(400).json({ error: 'Invalid role or type' });
    }

    const normalizedWorkflowId = normalizeMessageContent(workflowId);
    const normalizedParentConversationId = normalizeMessageContent(parentConversationId) || null;
    const normalizedConversationRole = normalizeConversationRole(conversationRole || 'root', 'automation', normalizedParentConversationId);
    const safeTimestamp = Number(timestamp) || Date.now();
    const normalizedStatus =
      status
        ? normalizeWorkflowConversationStatus(status)
        : safeType === 'approval_request'
          ? 'pending_approval'
          : 'active';
    const messageId = eventId || `auto_msg_${normalizedWorkflowId}_${safeTimestamp}_${safeRole}_${safeType}`;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let shouldInjectToGateway = false;
      let conversationWasCreated = false;
      let conversationRecord = null;

      if (normalizeMessageContent(requestedConversationId)) {
        conversationRecord = (
          await client.query(
            'SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1',
            [requestedConversationId]
          )
        ).rows[0] || null;
      }

      if (!conversationRecord && normalizeMessageContent(requestedSessionKey)) {
        conversationRecord = (
          await client.query(
            'SELECT * FROM "Conversations" WHERE "sessionKey" = $1 LIMIT 1',
            [requestedSessionKey]
          )
        ).rows[0] || null;
      }

      if (!conversationRecord) {
        conversationRecord = (
          await client.query(
            `SELECT *
             FROM "Conversations"
             WHERE "workflowId" = $1
               AND "agentId" = $2
               AND COALESCE("role", 'root') = $3
               AND COALESCE("parentConversationId", '') = COALESCE($4, '')
             ORDER BY "updatedAt" DESC
             LIMIT 1`,
            [normalizedWorkflowId, agentId, normalizedConversationRole, normalizedParentConversationId]
          )
        ).rows[0] || null;
      }

      const finalConversationId =
        conversationRecord?.id
        || normalizeMessageContent(requestedConversationId)
        || buildCanonicalAutomationConversationId({
          workflowId: normalizedWorkflowId,
          agentId,
          conversationRole: normalizedConversationRole,
          parentConversationId: normalizedParentConversationId,
        });
      const finalSessionKey =
        normalizeMessageContent(requestedSessionKey)
        || conversationRecord?.sessionKey
        || buildConversationSessionKey(agentId, finalConversationId, 'automation', normalizedWorkflowId);
      const finalEmployeeId = conversationRecord?.employeeId || employeeId;
      const conversationTitle = title || `[AUTO] ${agentId} - ${normalizedWorkflowId}`;
      const hadConversationRecord = Boolean(conversationRecord);

      const messageExists = await client.query(
        'SELECT 1 FROM "Messages" WHERE "id" = $1 LIMIT 1',
        [messageId]
      );
      shouldInjectToGateway = messageExists.rows.length === 0;

      conversationRecord = (
        await client.query(
          `INSERT INTO "Conversations"
           ("id", "title", "agentId", "sessionKey", "projectId", "status", "createdAt", "updatedAt", "employeeId", "lane", "role", "workflowId", "parentConversationId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'automation', $10, $11, $12)
           ON CONFLICT ("id")
           DO UPDATE SET
             "title" = EXCLUDED."title",
             "agentId" = EXCLUDED."agentId",
             "sessionKey" = EXCLUDED."sessionKey",
             "status" = CASE
               WHEN "Conversations"."status" IN ('cancelled', 'stopped') THEN "Conversations"."status"
               ELSE EXCLUDED."status"
             END,
             "updatedAt" = EXCLUDED."updatedAt",
             "employeeId" = COALESCE("Conversations"."employeeId", EXCLUDED."employeeId"),
             "lane" = 'automation',
             "role" = EXCLUDED."role",
             "workflowId" = COALESCE("Conversations"."workflowId", EXCLUDED."workflowId"),
             "parentConversationId" = COALESCE("Conversations"."parentConversationId", EXCLUDED."parentConversationId")
           RETURNING *`,
          [
            finalConversationId,
            conversationTitle,
            agentId,
            finalSessionKey,
            null,
            normalizedStatus,
            conversationRecord?.createdAt || safeTimestamp,
            safeTimestamp,
            finalEmployeeId,
            normalizedConversationRole,
            normalizedWorkflowId,
            normalizedParentConversationId,
          ]
        )
      ).rows[0];
      conversationWasCreated = !hadConversationRecord;

      const workflowRecord = (
        await client.query(
          `INSERT INTO "Workflows" ("id","rootConversationId","initiatorAgentId","initiatorEmployeeId","status","title","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT ("id") DO UPDATE SET
             "status" = COALESCE(EXCLUDED."status", "Workflows"."status"),
             "updatedAt" = EXCLUDED."updatedAt",
             "rootConversationId" = COALESCE("Workflows"."rootConversationId", EXCLUDED."rootConversationId")
           RETURNING *`,
          [
            normalizedWorkflowId,
            normalizedConversationRole === 'root' ? conversationRecord.id : null,
            agentId,
            finalEmployeeId,
            normalizedStatus,
            conversationTitle,
            safeTimestamp,
            safeTimestamp,
          ]
        )
      ).rows[0];

      const insertedMessage = (
        await client.query(
          `INSERT INTO "Messages" ("id", "conversationId", "role", "type", "content", "timestamp")
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT ("id") DO UPDATE SET
             "role" = EXCLUDED."role",
             "type" = EXCLUDED."type",
             "content" = EXCLUDED."content",
             "timestamp" = EXCLUDED."timestamp"
           RETURNING *`,
          [messageId, conversationRecord.id, safeRole, safeType, normalizeMessageContent(content).slice(0, 4000), safeTimestamp]
        )
      ).rows[0];

      await client.query('COMMIT');

      broadcastWorkflowUpdated(workflowRecord);
      if (conversationWasCreated) {
        broadcastConversationCreated(conversationRecord);
      } else {
        broadcastConversationUpdated(conversationRecord);
      }
      broadcastMessageEvent([insertedMessage], { [conversationRecord.id]: conversationRecord });

      if (shouldInjectToGateway && injectToGateway !== false) {
        try {
          await injectAutomationMessage({
            sessionKey: finalSessionKey,
            content: normalizeMessageContent(content).slice(0, 4000),
            eventId: messageId,
            label: agentId,
          });
        } catch (syncError) {
          console.error('Failed to sync automation message to gateway transcript:', syncError.message);
        }
      }

      return res.json({ success: true, conversationId: conversationRecord.id, messageId });
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
      broadcastConversationDeleted(conversation);
      return res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

const PORT = Number(process.env.PORT) || 3001;

// ===================== INTERNAL API (Commit 5) =====================
// Orchestrator gọi các routes này để persist sub-agent conversations/messages.
// Xác thực bằng AUTOMATION_SYNC_TOKEN.

app.post('/internal/workflows/resolve-root', requireInternalAuth, async (req, res) => {
    const {
      agentId,
      employeeId,
      brief,
      sessionKey,
      rootConversationId,
    } = req.body || {};

    const normalizedAgentId = normalizeMessageContent(agentId);
    const normalizedEmployeeId = normalizeMessageContent(employeeId) || normalizedAgentId;
    const normalizedBrief = normalizeMessageContent(brief);
    const normalizedSessionKey = normalizeMessageContent(sessionKey);
    const normalizedRootConversationId = normalizeMessageContent(rootConversationId);

    if (!normalizedAgentId) {
      return res.status(400).json({ error: 'agentId is required' });
    }

    try {
      let rootConversation = null;

      if (normalizedRootConversationId) {
        rootConversation = (
          await pool.query(
            `SELECT *
             FROM "Conversations"
             WHERE "id" = $1
               AND "lane" = 'automation'
               AND COALESCE("role", 'root') = 'root'
             LIMIT 1`,
            [normalizedRootConversationId]
          )
        ).rows[0] || null;
      }

      if (normalizedSessionKey) {
        rootConversation = (
          await pool.query(
            `SELECT *
             FROM "Conversations"
             WHERE "sessionKey" = $1
               AND "lane" = 'automation'
               AND COALESCE("role", 'root') = 'root'
             LIMIT 1`,
            [normalizedSessionKey]
          )
        ).rows[0] || null;
      }

      if (!rootConversation && normalizedBrief) {
        const rootMatches = (
          await pool.query(
            `SELECT c.*
             FROM "Conversations" c
             JOIN LATERAL (
               SELECT m."content", m."timestamp"
               FROM "Messages" m
               WHERE m."conversationId" = c."id"
                 AND m."role" = 'user'
               ORDER BY m."timestamp" DESC
               LIMIT 1
             ) latest_user ON TRUE
             WHERE c."lane" = 'automation'
               AND COALESCE(c."role", 'root') = 'root'
               AND c."agentId" = $1
               AND ($2 = '' OR c."employeeId" = $2)
               AND latest_user."content" = $3
             ORDER BY latest_user."timestamp" DESC, c."updatedAt" DESC
             LIMIT 2`,
            [normalizedAgentId, normalizedEmployeeId || '', normalizedBrief]
          )
        ).rows;
        if (rootMatches.length === 1) {
          rootConversation = rootMatches[0];
        }
      }

      if (!rootConversation) {
        return res.json({
          success: true,
          rootConversation: null,
          workflowId: null,
          rootConversationId: null,
          sessionKey: null,
        });
      }

      const hydratedRoot = hydrateConversationRecord(rootConversation);
      return res.json({
        success: true,
        rootConversation: hydratedRoot,
        workflowId: hydratedRoot?.workflowId || null,
        rootConversationId: hydratedRoot?.id || null,
        sessionKey: hydratedRoot?.sessionKey || null,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
});

// 1. Tạo workflow
app.post('/internal/workflows', requireInternalAuth, async (req, res) => {
    const {
      id,
      workflowId,
      rootConversationId,
      initiatorAgentId,
      initiatorEmployeeId,
      title,
      inputPayload,
      status,
    } = req.body || {};
    const targetWorkflowId = normalizeMessageContent(id) || normalizeMessageContent(workflowId);
    if (!targetWorkflowId) return res.status(400).json({ error: 'id or workflowId is required' });
    const now = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const resolvedRootConversationId = rootConversationId || null;

      const workflowRecord = (
        await client.query(
          `INSERT INTO "Workflows"
           ("id","rootConversationId","initiatorAgentId","initiatorEmployeeId","status","title","inputPayload","createdAt","updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT ("id") DO UPDATE SET
             "updatedAt" = EXCLUDED."updatedAt",
             "status" = COALESCE(EXCLUDED."status", "Workflows"."status"),
             "rootConversationId" = COALESCE(EXCLUDED."rootConversationId", "Workflows"."rootConversationId")
          RETURNING *`,
          [
            targetWorkflowId,
            resolvedRootConversationId,
            initiatorAgentId,
            initiatorEmployeeId || initiatorAgentId,
            normalizeMessageContent(status) || 'active',
            title,
            inputPayload || null,
            now,
            now,
          ]
        )
      ).rows[0];

      let rootConversation = null;
      if (resolvedRootConversationId) {
        rootConversation = (
          await client.query(
            `UPDATE "Conversations"
             SET "workflowId" = $1,
                 "lane" = 'automation',
                 "role" = COALESCE("role", 'root'),
                 "updatedAt" = $2
             WHERE "id" = $3
             RETURNING *`,
            [targetWorkflowId, now, resolvedRootConversationId]
          )
        ).rows[0];
      }

      await client.query('COMMIT');
      if (rootConversation) {
        broadcastConversationUpdated(rootConversation);
      }
      broadcastWorkflowCreated(workflowRecord);
      return res.json({ success: true, id: targetWorkflowId, rootConversationId: resolvedRootConversationId });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

// 2. Tạo sub-agent conversation (orchestrator gọi khi giao việc)
app.post('/internal/conversations', requireInternalAuth, async (req, res) => {
    const {
      workflowId,
      agentId,
      employeeId,
      parentConversationId,
      title,
      lane = 'automation',
      role = 'sub_agent',
      sessionKey: requestedSessionKey,
    } = req.body || {};
    if (!workflowId || !agentId) {
      return res.status(400).json({ error: 'workflowId and agentId are required' });
    }

    const now = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let resolvedParentConversationId = parentConversationId || null;
      let resolvedEmployeeId = employeeId || agentId;
      const workflowResult = await client.query(
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

      let conversationRecord = (
        await client.query(
          `SELECT *
           FROM "Conversations"
           WHERE "workflowId" = $1
             AND "agentId" = $2
             AND COALESCE("role", 'sub_agent') = $3
             AND COALESCE("parentConversationId", '') = COALESCE($4, '')
           LIMIT 1`,
          [workflowId, agentId, normalizeConversationRole(role, 'automation', resolvedParentConversationId), resolvedParentConversationId]
        )
      ).rows[0];

      const conversationWasCreated = !conversationRecord;
      const conversationId = conversationRecord?.id || generateConversationId();
      const sessionKey =
        normalizeMessageContent(requestedSessionKey)
        || conversationRecord?.sessionKey
        || buildConversationSessionKey(agentId, conversationId, lane, workflowId);

      conversationRecord = (
        await client.query(
          `INSERT INTO "Conversations"
           ("id","title","agentId","sessionKey","status","createdAt","updatedAt","employeeId","lane","role","workflowId","parentConversationId")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'automation',$9,$10,$11)
           ON CONFLICT ("id") DO UPDATE SET
             "title" = EXCLUDED."title",
             "agentId" = EXCLUDED."agentId",
             "sessionKey" = EXCLUDED."sessionKey",
             "status" = EXCLUDED."status",
             "updatedAt" = EXCLUDED."updatedAt",
             "employeeId" = COALESCE("Conversations"."employeeId", EXCLUDED."employeeId"),
             "lane" = 'automation',
             "role" = EXCLUDED."role",
             "workflowId" = COALESCE("Conversations"."workflowId", EXCLUDED."workflowId"),
             "parentConversationId" = COALESCE("Conversations"."parentConversationId", EXCLUDED."parentConversationId")
           RETURNING *`,
          [
            conversationId,
            title || `[AUTO] ${agentId} - ${workflowId}`,
            agentId,
            sessionKey,
            'active',
            conversationRecord?.createdAt || now,
            now,
            resolvedEmployeeId,
            normalizeConversationRole(role, 'automation', resolvedParentConversationId),
            workflowId,
            resolvedParentConversationId,
          ]
        )
      ).rows[0];

      await client.query('COMMIT');
      if (conversationWasCreated) {
        broadcastConversationCreated(conversationRecord);
      } else {
        broadcastConversationUpdated(conversationRecord);
      }

      return res.json({
        id: conversationRecord.id,
        sessionKey: conversationRecord.sessionKey,
        agentId: conversationRecord.agentId,
        workflowId: conversationRecord.workflowId,
        parentConversationId: conversationRecord.parentConversationId,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

// 3. Persist messages từ orchestrator/sub-agent
app.post('/internal/messages', requireInternalAuth, async (req, res) => {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({ success: true });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const persistedMessages = [];
      const conversationsById = {};
      const completedInternalConversationIds = new Set();

      for (const message of messages) {
        const conversationResult = await client.query(
          'SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1',
          [message.conversationId]
        );
        const conversation = conversationResult.rows[0];
        const validation = validateMessagePayload(message, conversation);
        if (!validation.ok) {
          throw new Error(validation.error);
        }

        const insertedMessage = (
          await client.query(
            `INSERT INTO "Messages" ("id","conversationId","role","type","content","timestamp")
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT ("id") DO UPDATE SET
               "role" = EXCLUDED."role",
               "type" = EXCLUDED."type",
               "content" = EXCLUDED."content",
               "timestamp" = EXCLUDED."timestamp"
             RETURNING *`,
            [message.id, message.conversationId, validation.role, validation.type, validation.content, validation.timestamp]
          )
        ).rows[0];
        persistedMessages.push(insertedMessage);
        conversationsById[message.conversationId] = validation.conversation;
        if (validation.role === 'assistant' && message.final !== false) {
          completedInternalConversationIds.add(message.conversationId);
        }
      }

      for (const conversationId of Object.keys(conversationsById)) {
        const updatedConversation = (
          await client.query(
            `UPDATE "Conversations"
             SET "updatedAt" = $1,
                 "status" = CASE
                   WHEN $3::boolean
                     AND COALESCE("lane", 'user') = 'automation'
                     AND COALESCE("role", 'root') = 'sub_agent'
                     AND COALESCE("status", 'active') NOT IN ('cancelled', 'stopped', 'error')
                   THEN 'approved'
                   ELSE "status"
                 END
             WHERE "id" = $2
             RETURNING *`,
            [Date.now(), conversationId, completedInternalConversationIds.has(conversationId)]
          )
        ).rows[0];
        conversationsById[conversationId] = hydrateConversationRecord(updatedConversation || conversationsById[conversationId]);
      }

      await client.query('COMMIT');
      for (const conversationId of Object.keys(conversationsById)) {
        broadcastConversationUpdated(conversationsById[conversationId]);
      }
      broadcastMessageEvent(persistedMessages, conversationsById);
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
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status is required' });
    const now = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const workflowRecord = (
        await client.query(
          `UPDATE "Workflows"
           SET "status" = $1, "updatedAt" = $2
           WHERE "id" = $3
           RETURNING *`,
          [status, now, req.params.id]
        )
      ).rows[0];

      if (!workflowRecord) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Workflow not found' });
      }

      let rootConversation = null;
      if (workflowRecord.rootConversationId) {
        rootConversation = (
          await client.query(
            `UPDATE "Conversations"
             SET "status" = $1, "updatedAt" = $2
             WHERE "id" = $3
             RETURNING *`,
            [normalizeWorkflowConversationStatus(status), now, workflowRecord.rootConversationId]
          )
        ).rows[0];
      }

      await client.query('COMMIT');
      broadcastWorkflowUpdated(workflowRecord);
      if (rootConversation) {
        broadcastConversationUpdated(rootConversation);
      }
      return res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});

// ===================== SSE — Realtime events (Phase 3) =====================
// Clients connect to GET /api/events và nhận các event: workflow.*, conversation.*, message.*
// Mỗi event là text/event-stream theo chuẩn Server-Sent Events.

app.post('/internal/workflows/:id/progress', requireInternalAuth, async (req, res) => {
  const { workflowId, conversationId, agentId, stage, label, status } = req.body || {};
  const targetWorkflowId = normalizeMessageContent(workflowId) || req.params.id;
  const normalizedStage = normalizeMessageContent(stage);
  if (!targetWorkflowId || !normalizedStage) {
    return res.status(400).json({ error: 'workflowId/stage is required' });
  }

  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const workflowRecord = (
      await client.query(
        `UPDATE "Workflows"
         SET "updatedAt" = $1,
             "status" = COALESCE($2, "status")
         WHERE "id" = $3
         RETURNING *`,
        [now, status || null, targetWorkflowId]
      )
    ).rows[0] || null;

    let conversationRecord = null;
    if (normalizeMessageContent(conversationId)) {
      conversationRecord = (
        await client.query(
          `UPDATE "Conversations"
           SET "updatedAt" = $1
           WHERE "id" = $2
           RETURNING *`,
          [now, conversationId]
        )
      ).rows[0] || null;
    }

    await client.query('COMMIT');
    if (workflowRecord) {
      broadcastWorkflowUpdated(workflowRecord);
    }
    if (conversationRecord) {
      broadcastConversationUpdated(conversationRecord);
    }
    safeBroadcastSSE('workflow.progress', {
      workflowId: targetWorkflowId,
      conversationId: normalizeMessageContent(conversationId) || null,
      agentId: normalizeMessageContent(agentId) || null,
      stage: normalizedStage,
      label: normalizeMessageContent(label) || normalizedStage,
      status: normalizeMessageContent(status) || workflowRecord?.status || 'active',
      timestamp: now,
    });
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const sseClients = new Set();

function broadcastSSE(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* client da dong */ }
  }
}

app.locals.broadcastSSE = broadcastSSE;

app.get('/api/events', requireBackendAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(`event: realtime.snapshot\ndata: ${JSON.stringify({
    timestamp: Date.now(),
    employeeId: req.auth?.employeeId || null,
  })}\n\n`);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\\n\\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  sseClients.add(res);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: `Request body too large. Max JSON body size is ${mediaConfig.jsonBodyLimitMb} MB. Max decoded upload size is ${mediaConfig.maxUploadSizeMb} MB`,
    });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  return next(err);
});

void pool.checkConnection()
  .then(() => {
    console.log('Connected successfully to PostgreSQL Database.');
  })
  .catch((err) => {
    console.error('Could not connect to PostgreSQL. Check DATABASE_URL.', err.stack || err.message || err);
  });

const server = app.listen(PORT, () => {
  console.log(`Backend Server is running on http://localhost:${PORT}`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[STARTUP] Port ${PORT} is already in use. Stop the other backend process or run this server with PORT set to a different value.`);
    process.exit(1);
  }
  throw error;
});
