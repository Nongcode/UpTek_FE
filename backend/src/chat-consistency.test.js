const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  buildCanonicalAutomationConversationId,
  buildConversationBroadcastPayload,
  buildConversationSessionKey,
  buildMessageBroadcastPayload,
  hydrateConversationRecord,
  inferConversationLane,
} = require("./chat-consistency");

const serverSource = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(source, literal) {
  const matches = source.match(new RegExp(escapeRegExp(literal), "g"));
  return matches ? matches.length : 0;
}

function routeSnippet(startLiteral, endLiteral) {
  const startIndex = serverSource.indexOf(startLiteral);
  assert.notEqual(startIndex, -1, `missing route start: ${startLiteral}`);

  const endIndex = endLiteral ? serverSource.indexOf(endLiteral, startIndex) : -1;
  assert.notEqual(endIndex, -1, `missing route end marker after ${startLiteral}`);
  return serverSource.slice(startIndex, endIndex);
}

test("personal conversation stays canonical for lane, workflow, parent, and session key", () => {
  const conversation = hydrateConversationRecord({
    id: "conv_123",
    agentId: "nv_content",
    employeeId: "nv_content",
    lane: "user",
    role: null,
    workflowId: null,
    parentConversationId: null,
    sessionKey: buildConversationSessionKey("nv_content", "conv_123", "user", null),
  });

  assert.equal(conversation.lane, "user");
  assert.equal(conversation.workflowId, null);
  assert.equal(conversation.parentConversationId, null);
  assert.equal(conversation.role, "root");
  assert.equal(conversation.sessionKey, "chat:nv_content:conv_123");
  assert.equal(inferConversationLane(conversation), "user");

  const assistantPayload = buildMessageBroadcastPayload(
    {
      id: "msg_assistant",
      conversationId: "conv_123",
      role: "assistant",
      type: "regular",
      timestamp: 200,
    },
    conversation,
  );

  assert.equal(assistantPayload.conversationId, "conv_123");
  assert.deepEqual(assistantPayload.conversationIds, ["conv_123"]);
  assert.equal(assistantPayload.workflowId, null);
  assert.equal(assistantPayload.agentId, "nv_content");
  assert.equal(assistantPayload.role, "assistant");
});

test("automation sub-agent hydration keeps automation lane and parent linkage", () => {
  const conversation = hydrateConversationRecord({
    id: buildCanonicalAutomationConversationId({
      workflowId: "wf_demo",
      agentId: "nv_media",
      conversationRole: "sub_agent",
      parentConversationId: "auto_pho_phong_wf_demo",
    }),
    agentId: "nv_media",
    employeeId: "pho_phong",
    lane: "automation",
    role: "sub_agent",
    workflowId: "wf_demo",
    parentConversationId: "auto_pho_phong_wf_demo",
    sessionKey: buildConversationSessionKey(
      "nv_media",
      "auto_nv_media_wf_demo_auto_pho_phong_wf_demo",
      "automation",
      "wf_demo",
    ),
  });

  assert.equal(conversation.lane, "automation");
  assert.equal(conversation.workflowId, "wf_demo");
  assert.equal(conversation.role, "sub_agent");
  assert.equal(conversation.parentConversationId, "auto_pho_phong_wf_demo");

  const conversationPayload = buildConversationBroadcastPayload(conversation);
  assert.equal(conversationPayload.lane, "automation");
  assert.equal(conversationPayload.workflowId, "wf_demo");
  assert.equal(conversationPayload.role, "sub_agent");
  assert.equal(conversationPayload.parentConversationId, "auto_pho_phong_wf_demo");
});

test("canonical route implementations exist only once for critical endpoints", () => {
  const criticalRoutes = [
    "app.post('/api/conversations'",
    "app.post('/api/messages'",
    "app.post('/api/automation/agent-event'",
    "app.post('/internal/workflows'",
    "app.post('/internal/conversations'",
    "app.post('/internal/messages'",
    "app.patch('/internal/workflows/:id/status'",
    "app.post('/internal/workflows/:id/progress'",
  ];

  for (const route of criticalRoutes) {
    assert.equal(countMatches(serverSource, route), 1, `${route} should have exactly one canonical implementation`);
  }
});

test("personal create route canonicalizes user lane and chat session key", () => {
  const snippet = routeSnippet(
    "app.post('/api/conversations'",
    "app.put('/api/conversations/:id'",
  );

  assert.match(snippet, /normalizeConversationLane\(lane, workflowId\)/);
  assert.match(snippet, /buildConversationSessionKey\(agentId, id, normalizedLane, effectiveWorkflowId\)/);
  assert.match(snippet, /workflowRecord = \(/);
  assert.match(snippet, /await client\.query\('COMMIT'\)/);
  assert.match(snippet, /broadcastConversationCreated\(insertedConversation\)/);
});

test("personal message route commits before broadcasting message.created", () => {
  const snippet = routeSnippet(
    "app.post('/api/messages'",
    "app.post('/api/automation/agent-event'",
  );
  const commitIndex = snippet.indexOf("await client.query('COMMIT')");
  const messageBroadcastIndex = snippet.indexOf("broadcastMessageEvent(");

  assert.notEqual(commitIndex, -1, "api/messages must commit");
  assert.notEqual(messageBroadcastIndex, -1, "api/messages must broadcast");
  assert.ok(commitIndex < messageBroadcastIndex, "api/messages must broadcast only after commit");
  assert.match(snippet, /validateMessagePayload\(message, conversation\)/);
});

test("automation event route forces automation lane and broadcasts after commit", () => {
  const snippet = routeSnippet(
    "app.post('/api/automation/agent-event'",
    "app.delete('/api/conversations/:id'",
  );
  const commitIndex = snippet.indexOf("await client.query('COMMIT')");
  const messageBroadcastIndex = snippet.indexOf("broadcastMessageEvent([insertedMessage]");

  assert.match(snippet, /"lane" = 'automation'/);
  assert.match(snippet, /COALESCE\("Conversations"\."workflowId", EXCLUDED\."workflowId"\)/);
  assert.match(snippet, /buildCanonicalAutomationConversationId/);
  assert.match(snippet, /shouldInjectToGateway = messageExists\.rows\.length === 0/);
  assert.ok(commitIndex < messageBroadcastIndex, "automation event must broadcast only after commit");
});

test("internal workflow routes broadcast after commit and progress does not insert messages", () => {
  const workflowResolveSnippet = routeSnippet(
    "app.post('/internal/workflows/resolve-root'",
    "app.post('/internal/workflows'",
  );
  const workflowCreateSnippet = routeSnippet(
    "app.post('/internal/workflows'",
    "app.post('/internal/conversations'",
  );
  const workflowMessageSnippet = routeSnippet(
    "app.post('/internal/messages'",
    "app.patch('/internal/workflows/:id/status'",
  );
  const workflowStatusSnippet = routeSnippet(
    "app.patch('/internal/workflows/:id/status'",
    "app.post('/internal/workflows/:id/progress'",
  );
  const workflowProgressSnippet = routeSnippet(
    "app.post('/internal/workflows/:id/progress'",
    "const sseClients = new Set();",
  );

  assert.match(workflowResolveSnippet, /latest_user/);
  assert.match(workflowResolveSnippet, /latest_user\."content" = \$3/);
  assert.match(workflowResolveSnippet, /COALESCE\(c\."role", 'root'\) = 'root'/);
  assert.match(workflowCreateSnippet, /id or workflowId is required/);
  assert.ok(
    workflowCreateSnippet.indexOf("await client.query('COMMIT')") < workflowCreateSnippet.indexOf("broadcastWorkflowCreated(workflowRecord)"),
    "internal/workflows must broadcast after commit",
  );
  assert.ok(
    workflowMessageSnippet.indexOf("await client.query('COMMIT')") < workflowMessageSnippet.indexOf("broadcastMessageEvent(persistedMessages, conversationsById)"),
    "internal/messages must broadcast after commit",
  );
  assert.ok(
    workflowStatusSnippet.indexOf("await client.query('COMMIT')") < workflowStatusSnippet.indexOf("broadcastWorkflowUpdated(workflowRecord)"),
    "workflow status route must broadcast after commit",
  );
  assert.match(workflowProgressSnippet, /safeBroadcastSSE\('workflow\.progress'/);
  assert.doesNotMatch(workflowProgressSnippet, /INSERT INTO "Messages"/);
});

test("backend startup handles EADDRINUSE with explicit diagnostics", () => {
  assert.match(serverSource, /server\.on\('error', \(error\) => \{/);
  assert.match(serverSource, /error\?\.code === 'EADDRINUSE'/);
  assert.match(serverSource, /Port \$\{PORT\} is already in use/);
});
