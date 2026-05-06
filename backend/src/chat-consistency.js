function normalizeText(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function normalizeConversationLane(lane, workflowId) {
  const normalizedLane = normalizeText(lane).toLowerCase();
  if (normalizedLane === "automation" || normalizeText(workflowId)) {
    return "automation";
  }
  return "user";
}

function normalizeConversationRole(role, lane, parentConversationId) {
  const normalizedRole = normalizeText(role).toLowerCase();
  if (normalizedRole === "root" || normalizedRole === "sub_agent") {
    return normalizedRole;
  }
  if (normalizeConversationLane(lane) === "automation" && normalizeText(parentConversationId)) {
    return "sub_agent";
  }
  return "root";
}

function buildConversationSessionKey(agentId, conversationId, lane, workflowId) {
  const normalizedAgentId = normalizeText(agentId);
  const normalizedConversationId = normalizeText(conversationId);
  const normalizedWorkflowId = normalizeText(workflowId);
  if (normalizeConversationLane(lane, normalizedWorkflowId) === "automation" && normalizedWorkflowId) {
    return `agent:${normalizedAgentId}:automation:${normalizedWorkflowId}:${normalizedConversationId}`;
  }
  return `chat:${normalizedAgentId}:${normalizedConversationId}`;
}

function buildCanonicalAutomationConversationId(params) {
  const workflowId = normalizeText(params.workflowId);
  const agentId = normalizeText(params.agentId);
  const parentConversationId = normalizeText(params.parentConversationId);
  const role = normalizeConversationRole(params.conversationRole, "automation", parentConversationId);

  if (role === "root") {
    return `auto_${agentId}_${workflowId}`;
  }

  const parentSuffix = parentConversationId || "sub";
  return `auto_${agentId}_${workflowId}_${parentSuffix}`;
}

function inferConversationLane(conversation) {
  if (conversation?.lane === "automation" || normalizeText(conversation?.workflowId)) {
    return "automation";
  }
  const sessionKey = normalizeText(conversation?.sessionKey).toLowerCase();
  if (sessionKey.startsWith("automation:") || sessionKey.includes(":automation:")) {
    return "automation";
  }
  return "user";
}

function hydrateConversationRecord(record) {
  if (!record) {
    return null;
  }
  const lane = normalizeConversationLane(record.lane, record.workflowId);
  const parentConversationId = normalizeText(record.parentConversationId) || null;
  return {
    ...record,
    lane,
    workflowId: normalizeText(record.workflowId) || null,
    parentConversationId,
    role: normalizeConversationRole(record.role, lane, parentConversationId),
  };
}

function buildWorkflowBroadcastPayload(record) {
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    rootConversationId: record.rootConversationId || null,
    initiatorAgentId: record.initiatorAgentId || null,
    initiatorEmployeeId: record.initiatorEmployeeId || null,
    status: record.status || null,
  };
}

function buildConversationBroadcastPayload(record) {
  const conversation = hydrateConversationRecord(record);
  if (!conversation) {
    return null;
  }
  return {
    id: conversation.id,
    agentId: conversation.agentId || null,
    employeeId: conversation.employeeId || null,
    workflowId: conversation.workflowId,
    sessionKey: conversation.sessionKey || null,
    lane: conversation.lane,
    role: conversation.role,
    parentConversationId: conversation.parentConversationId,
    status: conversation.status || null,
  };
}

function buildMessageBroadcastPayload(message, conversation) {
  const hydratedConversation = hydrateConversationRecord(conversation);
  return {
    id: message.id,
    conversationId: message.conversationId,
    conversationIds: [message.conversationId],
    workflowId: hydratedConversation?.workflowId || null,
    agentId: hydratedConversation?.agentId || null,
    role: message.role,
    type: message.type || "regular",
    timestamp: message.timestamp,
  };
}

const ALLOWED_MESSAGE_ROLES = new Set(["user", "assistant", "manager", "system"]);
const ALLOWED_MESSAGE_TYPES = new Set(["regular", "manager_note", "approval_request"]);

function sanitizeMessageRole(role) {
  const normalized = normalizeText(role).toLowerCase();
  return ALLOWED_MESSAGE_ROLES.has(normalized) ? normalized : null;
}

function sanitizeMessageType(type) {
  const normalized = normalizeText(type).toLowerCase() || "regular";
  return ALLOWED_MESSAGE_TYPES.has(normalized) ? normalized : null;
}

function normalizeMessageContent(content) {
  const normalized = String(content || "").replace(/\r\n/g, "\n").trim();
  return normalized;
}

module.exports = {
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
};
