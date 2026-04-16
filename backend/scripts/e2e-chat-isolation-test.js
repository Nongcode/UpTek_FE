require("dotenv").config();
const { Pool } = require("pg");

const API_BASE = process.env.UPTEK_FE_API_URL || "http://localhost:3001/api";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} :: ${JSON.stringify(data)}`);
  }
  return data;
}

async function resetDatabase(pool) {
  await pool.query('DELETE FROM "Messages"');
  await pool.query('DELETE FROM "Conversations"');
}

async function createConversation(payload) {
  return requestJson(`${API_BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function saveMessages(messages) {
  return requestJson(`${API_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

async function fetchConversations(employeeId, includeAutomation) {
  const query = includeAutomation ? "1" : "0";
  return requestJson(`${API_BASE}/conversations/${employeeId}?includeAutomation=${query}`);
}

async function sendAutomationEvent(payload) {
  const headers = { "Content-Type": "application/json" };
  if (process.env.AUTOMATION_SYNC_TOKEN) {
    headers["x-automation-sync-token"] = process.env.AUTOMATION_SYNC_TOKEN;
  }
  return requestJson(`${API_BASE}/automation/agent-event`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const ts = Date.now();
  const employeeId = "pho_phong";
  const agentId = "pho_phong";
  const convA = `conv_test_${ts}_a`;
  const convB = `conv_test_${ts}_b`;
  const workflowId = `wf_test_iso_${ts}`;

  try {
    console.log("1) Reset database...");
    await resetDatabase(pool);

    console.log("2) Create 2 personal conversations...");
    await createConversation({
      id: convA,
      title: "Test Session A",
      agentId,
      sessionKey: `agent:${agentId}:${employeeId}:${convA}`,
      projectId: null,
      status: "active",
      createdAt: ts,
      updatedAt: ts,
      employeeId,
    });
    await createConversation({
      id: convB,
      title: "Test Session B",
      agentId,
      sessionKey: `agent:${agentId}:${employeeId}:${convB}`,
      projectId: null,
      status: "active",
      createdAt: ts + 1,
      updatedAt: ts + 1,
      employeeId,
    });

    console.log("3) Save interleaved messages into A/B...");
    await saveMessages([
      { id: `msg_${ts}_a1`, conversationId: convA, role: "user", type: "regular", content: "A-1", timestamp: ts + 10 },
      { id: `msg_${ts}_b1`, conversationId: convB, role: "user", type: "regular", content: "B-1", timestamp: ts + 11 },
      { id: `msg_${ts}_a2`, conversationId: convA, role: "assistant", type: "regular", content: "A-2", timestamp: ts + 12 },
      { id: `msg_${ts}_b2`, conversationId: convB, role: "assistant", type: "regular", content: "B-2", timestamp: ts + 13 },
    ]);

    console.log("4) Inject automation events (manager + employee lanes)...");
    await sendAutomationEvent({
      workflowId,
      employeeId: "pho_phong",
      agentId: "pho_phong",
      role: "assistant",
      type: "regular",
      content: "Automation manager event",
      timestamp: ts + 20,
    });
    await sendAutomationEvent({
      workflowId,
      employeeId: "nv_content",
      agentId: "nv_content",
      role: "assistant",
      type: "approval_request",
      content: "Automation employee event",
      timestamp: ts + 21,
    });

    console.log("5) Validate personal conversations are isolated...");
    const personal = await fetchConversations(employeeId, false);
    const personalIds = new Set(personal.map((c) => c.id));
    assert(personalIds.has(convA), "Missing conversation A in personal list");
    assert(personalIds.has(convB), "Missing conversation B in personal list");

    const personalA = personal.find((c) => c.id === convA);
    const personalB = personal.find((c) => c.id === convB);
    assert(personalA.messages.length === 2, `Conversation A expected 2 messages, got ${personalA.messages.length}`);
    assert(personalB.messages.length === 2, `Conversation B expected 2 messages, got ${personalB.messages.length}`);
    assert(personalA.messages.every((m) => m.content.startsWith("A-")), "Conversation A contains foreign messages");
    assert(personalB.messages.every((m) => m.content.startsWith("B-")), "Conversation B contains foreign messages");

    console.log("6) Validate automation hidden for includeAutomation=0...");
    assert(!personal.some((c) => String(c.sessionKey || "").startsWith("automation:")), "Personal list must not include automation sessions");

    console.log("7) Validate automation visible for includeAutomation=1...");
    const withAutomation = await fetchConversations(employeeId, true);
    const hasAutomationForManager = withAutomation.some((c) => String(c.id).includes(`auto_pho_phong_${workflowId}`));
    assert(hasAutomationForManager, "Automation conversation for pho_phong not found when includeAutomation=1");

    const nvContentConversations = await fetchConversations("nv_content", true);
    const hasAutomationForEmployee = nvContentConversations.some((c) => String(c.id).includes(`auto_nv_content_${workflowId}`));
    assert(hasAutomationForEmployee, "Automation conversation for nv_content not found");

    console.log("PASS: Session isolation + automation visibility controls are working.");
    console.log(`Created personal conversations: ${convA}, ${convB}`);
    console.log(`Created automation workflow: ${workflowId}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`FAIL: ${error.message || error}`);
  process.exit(1);
});
