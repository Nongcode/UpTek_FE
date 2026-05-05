
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

} = require("./auth");
const {
  ACTIVE_STATUS,
  DISABLED_STATUS,
  canManageUsers,
  deleteUser,
  initializeUserStore,
  listUsers,
  updateUserStatus,
} = require("./user-management");
const { injectAutomationMessage } = require("./gateway-sync");
const {
  DEFAULT_MANAGER_INSTANCE_ID,
  getWorkersForManager,
  listManagerInstances,
  validateManagerInstanceId,
} = require("./manager-instances");
const { resolveManagerForConversation } = require("./manager-router");

const app = express();
app.use(cors());
app.use(express.json({ limit: `${Math.ceil(mediaConfig.maxUploadSizeMb * 1.5)}mb` }));

const automationSyncToken = process.env.AUTOMATION_SYNC_TOKEN || "";

function normalizeAgentId(value) {
  const normalized = String(value || "").trim().toLowerCase();
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

app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

(async () => {
  try {
    await initializeUserStore();
    const result = await pool.query('DELETE FROM "Messages" WHERE "conversationId" IS NULL');
    if (result.rowCount > 0) {
      console.log(`Deleted ${result.rowCount} orphaned messages.`);
    }
  } catch (err) {
    console.error("Startup initialization failed:", err.message);
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
  const result = await buildLoginResponse(email, password);
  if (!result) {
    return res.status(401).json({
      error: { message: "Invalid email or password", type: "unauthorized" },
    });
  }
  if (result.ok === false) {
    return res.status(403).json({ error: result.error });
  }
  return res.json(result);
});


app.get("/api/users", requireBackendAuth, async (req, res) => {
  if (!canManageUsers(req.auth)) {
    return res.status(403).json({ error: "Forbidden" });
  }

  try {
    const users = await listUsers();
    return res.json({ users, stats: buildUserStats(users) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch("/api/users/:id/status", requireBackendAuth, async (req, res) => {
  try {
    const nextStatus = req.body?.status === DISABLED_STATUS ? DISABLED_STATUS : ACTIVE_STATUS;
    const user = await updateUserStatus(req.params.id, nextStatus, req.auth);
    return res.json({ success: true, user });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete("/api/users/:id", requireBackendAuth, async (req, res) => {
  try {
    await deleteUser(req.params.id, req.auth);
    return res.json({ success: true });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });

  }
  return res.json(result);
});

app.get("/api/conversations/:employeeId", requireBackendAuth, async (req, res) => {
  const { employeeId } = req.params;
  const includeAutomation = req.query.includeAutomation === "1" || req.query.includeAutomation === "true";
  const requestedManagerInstanceId =
    typeof req.query?.managerInstanceId === "string" && req.query.managerInstanceId.trim()
      ? req.query.managerInstanceId.trim()
      : undefined;
  if (!canAccessEmployeeId(req.auth, employeeId)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const convResult = await pool.query(
      'SELECT * FROM "Conversations" WHERE "employeeId" = $1 ORDER BY "updatedAt" DESC',
      [employeeId],
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
           ORDER BY "updatedAt" DESC`,

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
            [accessibleAgentIds],
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
          [requestedAgentId],
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
    const placeholders = convIds.map((_, index) => `$${index + 1}`).join(",");

    const msgResult = await pool.query(

      `SELECT * FROM "Messages" WHERE "conversationId" IN (${placeholders}) ORDER BY "timestamp" ASC`,
      convIds,

    );
    const msgRows = msgResult.rows;

    const result = convRows
      .map((conversation) => ({
        ...hydrateConversationRecord(conversation),
        messages: msgRows.filter((message) => message.conversationId === conversation.id),
      }))
      .filter((conversation) =>
        requestedManagerInstanceId
          ? conversation.managerInstanceId === requestedManagerInstanceId
          : true,
      )
      .filter((conversation) => canAccessConversation(req.auth, conversation));

    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/conversations-global", requireBackendAuth, async (req, res) => {
  if (!req.auth?.canViewAllSessions) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const convResult = await pool.query('SELECT * FROM "Conversations" ORDER BY "updatedAt" DESC');
    return res.json(convResult.rows.map(hydrateConversationRecord).filter((row) => canAccessConversation(req.auth, row)));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


app.post("/api/conversations", requireBackendAuth, async (req, res) => {
  const { id, title, agentId, sessionKey, projectId, status, createdAt, updatedAt, employeeId, managerInstanceId: reqManagerInstanceId } = req.body;
  const requestedConversation = { id, title, agentId, sessionKey, employeeId, managerInstanceId: reqManagerInstanceId };
  if (!canAccessConversation(req.auth, requestedConversation)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    // GP3: resolve managerInstanceId — nếu không truyền thì dùng router để chọn
    const resolvedManagerInstanceId = await resolveManagerForConversation({
      managerInstanceId: reqManagerInstanceId,
      employeeId: req.auth?.employeeId,
      agentId,
    });

    await pool.query(
      `INSERT INTO "Conversations" ("id", "title", "agentId", "sessionKey", "projectId", "status", "createdAt", "updatedAt", "employeeId", "managerInstanceId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT ("id")
       DO UPDATE SET
         "title" = COALESCE(EXCLUDED."title", "Conversations"."title"),
         "agentId" = COALESCE(EXCLUDED."agentId", "Conversations"."agentId"),
         "sessionKey" = COALESCE(EXCLUDED."sessionKey", "Conversations"."sessionKey"),
         "projectId" = COALESCE(EXCLUDED."projectId", "Conversations"."projectId"),
         "status" = COALESCE(EXCLUDED."status", "Conversations"."status"),
         "updatedAt" = COALESCE(EXCLUDED."updatedAt", "Conversations"."updatedAt"),
         "employeeId" = COALESCE(EXCLUDED."employeeId", "Conversations"."employeeId")`,
      // managerInstanceId KHÔNG update khi conflict: giữ cố định sau lần tạo đầu
      [id, title, agentId, sessionKey, projectId, status, createdAt, updatedAt, employeeId, resolvedManagerInstanceId],
    );
    return res.json({ success: true, id, managerInstanceId: resolvedManagerInstanceId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.put("/api/conversations/:id", requireBackendAuth, async (req, res) => {
  const { id } = req.params;
  const { title, status, updatedAt } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1', [id]);
    const conversation = existing.rows[0];
    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }
    if (!canAccessConversation(req.auth, conversation)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await pool.query(
      `UPDATE "Conversations"
       SET "title" = COALESCE($1, "title"),
           "status" = COALESCE($2, "status"),
           "updatedAt" = COALESCE($3, "updatedAt")
       WHERE "id" = $4`,
      [title, status, updatedAt, id],
    );
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/messages", requireBackendAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !messages.length) {
    return res.json({ success: true });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const message of messages) {
      const conversationResult = await client.query(
        'SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1',
        [message.conversationId],

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
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Forbidden" });
      }

      await client.query(
        `INSERT INTO "Messages" ("id", "conversationId", "role", "type", "content", "timestamp", "managerInstanceId")
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content"`,
        [
          message.id,
          message.conversationId,
          message.role,
          message.type,
          message.content,
          message.timestamp,
          conversation.managerInstanceId || message.managerInstanceId || req.auth?.managerInstanceId || null,
        ],
      );
    }
    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.post("/api/automation/agent-event", async (req, res) => {
  if (automationSyncToken) {
    const incomingToken = req.get("x-automation-sync-token") || "";
    if (incomingToken !== automationSyncToken) {
      return res.status(401).json({ error: "Unauthorized automation sync token" });

    }


  const {
    workflowId,
    // GP3: employeeId/agentId vẫn giữ default "pho_phong" để backward-compatible
    // nhưng managerInstanceId giờ là trường chính xác định luồng
    employeeId = "pho_phong",
    agentId = "pho_phong",
    title,
    role = "assistant",
    type = "regular",
    content,
    timestamp = Date.now(),
    eventId,
    // GP3: managerInstanceId xác định instance cụ thể (A, B, C...)
    // Worker phải truyền field này khi gửi result về manager
    managerInstanceId: reqManagerInstanceId,
    // GP3: workerAgentId xác định worker nào đang gửi result (để tránh nhầm context)
    workerAgentId,
  } = req.body || {};

  if (!workflowId || !content) {
    return res.status(400).json({ error: "workflowId and content are required" });
  }

  // GP3: resolve managerInstanceId — nếu không truyền thì fallback về default
  // Không validate strict ở đây để không break luồng cũ (backward-compatible)
  const resolvedManagerInstanceId = reqManagerInstanceId || DEFAULT_MANAGER_INSTANCE_ID;

  const safeTimestamp = Number(timestamp) || Date.now();
  const sessionKey = `automation:${agentId}:${workflowId}`;
  const canonicalConversationId = `auto_${employeeId}_${workflowId}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");


      if (!rootConversation) {
        return res.json({
          success: true,
          rootConversation: null,
          workflowId: null,
          rootConversationId: null,
          sessionKey: null,
        });
      }


    const existingResult = await client.query(
      'SELECT "id", "employeeId" FROM "Conversations" WHERE "sessionKey" = $1 LIMIT 1',
      [sessionKey],
    );


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

        [
          agentId,
          `automation:${agentId}:conv_%`,
          `automation:${agentId}:${employeeId}:conv_%`,
        ],

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


        await client.query('DELETE FROM "Conversations" WHERE "id" = $1', [conversationId]);
        await client.query(
          'UPDATE "Messages" SET "conversationId" = $1 WHERE "conversationId" = $2',
          [conversationId, draftConversationId],

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


    const messageId = eventId || `auto_msg_${workflowId}_${safeTimestamp}_${role}_${type}`;
    const conversationTitle = title || `[AUTO] ${agentId} • ${workflowId}`;
    const nextStatus = type === "approval_request" ? "pending_approval" : "active";

    const existingMessageResult = await client.query(
      'SELECT 1 FROM "Messages" WHERE "id" = $1 LIMIT 1',
      [messageId],
    );
    shouldInjectToGateway = existingMessageResult.rows.length === 0;

    // GP3: lưu managerInstanceId vào Conversations — giữ cố định sau lần tạo đầu
    await client.query(
      `INSERT INTO "Conversations" ("id", "title", "agentId", "sessionKey", "projectId", "status", "createdAt", "updatedAt", "employeeId", "managerInstanceId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
      // managerInstanceId KHÔNG update khi conflict: giữ cố định sau lần tạo đầu
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
        resolvedManagerInstanceId,
      ],
    );

    // GP3: lưu managerInstanceId vào Messages để worker result không bị nhầm context
    await client.query(
      `INSERT INTO "Messages" ("id", "conversationId", "role", "type", "content", "timestamp", "managerInstanceId")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT ("id") DO UPDATE SET "content" = EXCLUDED."content", "timestamp" = EXCLUDED."timestamp"`,
      [messageId, conversationId, role, type, String(content).slice(0, 4000), safeTimestamp, resolvedManagerInstanceId],
    );

    await client.query("COMMIT");

    if (shouldInjectToGateway) {
      try {
        await injectAutomationMessage({
          sessionKey,
          content: String(content).slice(0, 4000),
          eventId: messageId,
          label: agentId,
        });
      } catch (syncError) {
        console.error("Failed to sync automation message to gateway transcript:", syncError.message);

      }
      return res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
});


    // GP3: response bao gồm managerInstanceId + workerAgentId để caller trace đúng context
    return res.json({
      success: true,
      conversationId,
      messageId,
      managerInstanceId: resolvedManagerInstanceId,
      workerAgentId: workerAgentId || null,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();

  }

+
// ─── GP3: Manager Instance API endpoints ─────────────────────────────────────

/** List tất cả manager instances (chỉ admin/giam_doc) */
app.get("/api/manager-instances", requireBackendAuth, async (req, res) => {
  if (!req.auth?.canViewAllSessions) {
    return res.status(403).json({ error: "Forbidden" });
  }
  try {
    const instances = await listManagerInstances();
    return res.json({ instances });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** Lấy danh sách workers của một manager instance */
app.get("/api/manager-instances/:id/workers", requireBackendAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const { valid, reason } = await validateManagerInstanceId(id);
    if (!valid) {
      return res.status(404).json({ error: reason });
    }
    const workers = await getWorkersForManager(id);
    return res.json({ managerInstanceId: id, workers });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.delete("/api/conversations/:id", requireBackendAuth, async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query('SELECT * FROM "Conversations" WHERE "id" = $1 LIMIT 1', [id]);
    const conversation = existing.rows[0];
    if (!conversation) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Conversation not found" });
    }
    if (!canAccessConversation(req.auth, conversation)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Forbidden" });
    }
    await client.query('DELETE FROM "Messages" WHERE "conversationId" = $1', [id]);
    await client.query('DELETE FROM "Conversations" WHERE "id" = $1', [id]);
    await client.query("COMMIT");

    return res.json({ success: true });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: `Request body too large. Max upload size is ${mediaConfig.maxUploadSizeMb} MB` });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: "Invalid JSON request body" });

  }
  return next(err);
});


const PORT = 3001;
void pool.checkConnection()
  .then(() => {
    console.log("Connected successfully to PostgreSQL Database.");
  })
  .catch((err) => {
    console.error("Could not connect to PostgreSQL. Check DATABASE_URL.", err.stack || err.message || err);
  });

app.listen(PORT, () => {

  console.log(`Backend Server is running on http://localhost:${PORT}`);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[STARTUP] Port ${PORT} is already in use. Stop the other backend process or run this server with PORT set to a different value.`);
    process.exit(1);
  }
  throw error;
});
