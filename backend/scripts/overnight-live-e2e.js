const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BASE_URL = process.env.UPTEK_LIVE_BASE_URL || "https://gods-sunday-latinas-gage.trycloudflare.com";
const EMAIL = process.env.UPTEK_LIVE_EMAIL || "pho_phong@uptek.ai";
const PASSWORD = process.env.UPTEK_LIVE_PASSWORD || "100904";
const BRIEF = 'triển khai quảng cáo cho sản phẩm "Mễ kê 6 Tấn, chiều cao nâng 382-600 mm (1 đôi)"';
const LOG_DIR = path.join(process.cwd(), "artifacts", "overnight-live");
const RESUME_CONVERSATION_ID = process.env.UPTEK_LIVE_CONVERSATION_ID || "";

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasUserFacingLeak(content) {
  const text = String(content || "").replace(/^MEDIA:\s*".*?"\s*$/gim, "");
  return (
    /[A-Za-z]:\\Users\\Administrator/i.test(text)
    || /\/Users\/Administrator\//i.test(text)
    || /IMAGE_DOWNLOAD_DIR|PRIMARY_PRODUCT_IMAGE|GENERATED_IMAGE_PATH|GENERATED_VIDEO_PATH/i.test(text)
    || /PROMPT ANH DA DUNG|PROMPT VIDEO DA DUNG/i.test(text)
    || /workspace_content|workspace_media|workspace_media_video|artifacts\/references|assets\/logos/i.test(text)
  );
}

function detectStageFromMessage(message) {
  const content = String(message?.content || "");
  if (message?.type === "approval_request" && /Duyet content, tao anh/i.test(content)) {
    return "awaiting_content_approval";
  }
  if (message?.type === "approval_request" && /Duyet anh|Duyet media/i.test(content)) {
    return "awaiting_media_approval";
  }
  if (message?.type === "approval_request" && /Duyet video/i.test(content)) {
    return "awaiting_video_approval";
  }
  if (message?.type === "approval_request" && /Dang ngay|Publish/i.test(content)) {
    return "awaiting_publish_decision";
  }
  if (message?.role === "assistant" && /Post IDs?:/i.test(content)) {
    return "published";
  }
  return "";
}

function detectConversationStage(conversation) {
  const assistantMessages = [...(conversation?.messages || [])]
    .filter((message) => message.role === "assistant")
    .sort((left, right) => Number(right.timestamp) - Number(left.timestamp));

  for (const message of assistantMessages) {
    const stage = detectStageFromMessage(message);
    if (stage) {
      return stage;
    }
  }

  return "";
}

function extractPostId(content) {
  const multiMatch = String(content || "").match(/Post IDs?:\s*([^\n]+)/i);
  if (!multiMatch) {
    return "";
  }
  const first = multiMatch[1]
    .split(",")
    .map((item) => item.trim())
    .find(Boolean);
  return first || "";
}

function isTargetBriefConversation(conversation) {
  return (conversation?.messages || []).some((message) => {
    if (message.role !== "user") {
      return false;
    }
    return normalizeText(message.content) === normalizeText(BRIEF);
  });
}

function hasPublishedMessage(conversation) {
  return (conversation?.messages || []).some((message) => detectStageFromMessage(message) === "published");
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} :: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function login() {
  return requestJson(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
}

async function createConversation(backendToken) {
  return requestJson(`${BASE_URL}/api/conversations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backendToken}`,
    },
    body: JSON.stringify({
      agentId: "pho_phong",
      lane: "automation",
      employeeId: "pho_phong",
    }),
  });
}

async function updateConversation(conversationId, backendToken, updates) {
  return requestJson(`${BASE_URL}/api/conversations/${conversationId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backendToken}`,
    },
    body: JSON.stringify(updates),
  });
}

async function saveMessages(backendToken, messages) {
  return requestJson(`${BASE_URL}/api/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backendToken}`,
    },
    body: JSON.stringify({ messages }),
  });
}

async function loadConversations(backendToken) {
  return requestJson(`${BASE_URL}/api/conversations/pho_phong?includeAutomation=1`, {
    headers: {
      Authorization: `Bearer ${backendToken}`,
    },
  });
}

async function streamChat({ token, sessionKey, agentId, messages }) {
  const response = await fetch(`${BASE_URL}/api/gateway/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-OpenClaw-Session-Key": sessionKey,
      "X-OpenClaw-Agent-Id": agentId,
    },
    body: JSON.stringify({
      model: `openclaw/${agentId}`,
      stream: true,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return {
      content: "",
      status: response.status,
      transportError: `stream failed ${response.status}: ${body.slice(0, 400)}`,
    };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return {
      content: "",
      status: response.status,
      transportError: "No stream reader",
    };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return { content, status: response.status, transportError: null };
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (trimmed === "data: [DONE]") {
        return { content, status: response.status, transportError: null };
      }
      if (!trimmed.startsWith("data: ")) {
        continue;
      }
      try {
        const payload = JSON.parse(trimmed.slice(6));
        const delta = payload?.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
        }
        if (payload?.choices?.[0]?.finish_reason === "stop") {
          return { content, status: response.status, transportError: null };
        }
      } catch {
        // Ignore malformed streaming chunks.
      }
    }
  }
}

async function resolveConversationContext(backendToken) {
  const conversations = await loadConversations(backendToken);

  if (RESUME_CONVERSATION_ID) {
    const resumed = conversations.find((item) => item.id === RESUME_CONVERSATION_ID);
    if (!resumed) {
      throw new Error(`Conversation ${RESUME_CONVERSATION_ID} not found`);
    }
    return resumed;
  }

  const resumable = conversations
    .filter((item) => item.agentId === "pho_phong")
    .filter((item) => item.lane === "automation" || item.workflowId)
    .filter((item) => isTargetBriefConversation(item))
    .filter((item) => !hasPublishedMessage(item))
    .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))[0];

  if (resumable) {
    return resumable;
  }

  return createConversation(backendToken);
}

async function waitForStage(backendToken, conversationId, stage, afterTimestamp, evidence) {
  const startedAt = Date.now();
  const timeoutMs = 12 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    const conversations = await loadConversations(backendToken);
    const conversation = conversations.find((item) => item.id === conversationId);
    if (conversation) {
      const assistantMessages = conversation.messages.filter(
        (message) => message.role === "assistant" && Number(message.timestamp) >= afterTimestamp,
      );
      const matched = assistantMessages.find((message) => detectStageFromMessage(message) === stage);
      if (matched) {
        if (hasUserFacingLeak(matched.content)) {
          throw new Error(`User-facing leak detected at ${stage}: ${matched.content.slice(0, 300)}`);
        }
        evidence.push({
          timestamp: new Date().toISOString(),
          workflowId: conversation.workflowId || null,
          rootConversationId: conversation.id,
          stage,
          messageId: matched.id,
          contentPreview: matched.content.slice(0, 240),
        });
        return { conversation, message: matched };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error(`Timed out waiting for ${stage}`);
}

async function sendTurn(context, content) {
  const now = Date.now();
  const userMessage = {
    id: `msg_${now}_${Math.random().toString(36).slice(2, 9)}`,
    conversationId: context.conversation.id,
    role: "user",
    type: "regular",
    content,
    timestamp: now,
  };

  const title =
    context.conversation.messages.length === 0
      ? content.slice(0, 40)
      : context.conversation.title;

  await updateConversation(context.conversation.id, context.backendToken, {
    title,
    status: "active",
    updatedAt: now,
  });
  await saveMessages(context.backendToken, [userMessage]);

  const optimisticMessages = [...context.conversation.messages, userMessage];
  const streamResult = await streamChat({
    token: context.gatewayToken,
    sessionKey: context.conversation.sessionKey,
    agentId: context.conversation.agentId,
    messages: optimisticMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  });

  context.conversation = {
    ...context.conversation,
    title,
    updatedAt: now,
    messages: optimisticMessages,
  };

  return {
    sentAt: now,
    streamContent: streamResult.content,
    transportError: streamResult.transportError,
    streamStatus: streamResult.status,
  };
}

function loadWorkflowHistory(workflowId) {
  if (!workflowId) {
    return null;
  }
  const historyPath = path.join(
    os.homedir(),
    ".openclaw",
    "workspace_phophong",
    "agent-orchestrator-test",
    "history",
    `${workflowId}.json`,
  );
  if (!fs.existsSync(historyPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(historyPath, "utf8").replace(/^\uFEFF/, ""));
}

async function main() {
  ensureDir(LOG_DIR);
  const evidence = [];
  const loginResult = await login();
  const context = {
    backendToken: loginResult.backendToken,
    gatewayToken: loginResult.token,
    conversation: await resolveConversationContext(loginResult.backendToken),
  };

  const steps = [
    { stage: "awaiting_content_approval", send: BRIEF },
    { stage: "awaiting_media_approval", send: "Duyệt content, tạo ảnh" },
    { stage: "awaiting_video_approval", send: "Duyệt ảnh, tạo video" },
    { stage: "awaiting_publish_decision", send: "Duyệt video" },
    { stage: "published", send: "Đăng ngay" },
  ];

  const currentStage = detectConversationStage(context.conversation);
  const currentIndex = currentStage ? steps.findIndex((step) => step.stage === currentStage) : -1;
  const pendingSteps = steps.slice(Math.max(currentIndex + 1, 0));

  evidence.push({
    timestamp: new Date().toISOString(),
    rootConversationId: context.conversation.id,
    workflowId: context.conversation.workflowId || null,
    stage: "context:resume",
    currentStage: currentStage || "new",
    status: context.conversation.status || null,
  });

  let lastStageMessage = null;
  if (currentStage === "published") {
    lastStageMessage = [...context.conversation.messages]
      .filter((message) => detectStageFromMessage(message) === "published")
      .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))[0] || null;
  }

  for (const step of pendingSteps) {
    const turn = await sendTurn(context, step.send);
    evidence.push({
      timestamp: new Date().toISOString(),
      workflowId: context.conversation.workflowId || null,
      rootConversationId: context.conversation.id,
      stage: `sent:${step.stage}`,
      userMessage: step.send,
      streamPreview: turn.streamContent.slice(0, 200),
      streamStatus: turn.streamStatus,
      transportError: turn.transportError || null,
    });
    const stageResult = await waitForStage(
      context.backendToken,
      context.conversation.id,
      step.stage,
      turn.sentAt,
      evidence,
    );
    context.conversation = stageResult.conversation;
    lastStageMessage = stageResult.message;
  }

  const workflowId = context.conversation.workflowId;
  const postId = extractPostId(lastStageMessage?.content || "");
  if (!postId) {
    throw new Error(`Publish completed without Post ID in root message: ${lastStageMessage?.content || ""}`);
  }

  const workflowState = loadWorkflowHistory(workflowId);
  const canonicalPostId =
    workflowState?.publish_canonical?.postId
    || workflowState?.publish_canonical?.postIds?.[0]
    || workflowState?.publish?.data?.post_ids?.[0]
    || "";

  const report = {
    baseUrl: BASE_URL,
    workflowId,
    rootConversationId: context.conversation.id,
    postId,
    canonicalPostId,
    permalink: workflowState?.publish_canonical?.permalink || "",
    finalStage: detectStageFromMessage(lastStageMessage),
    evidence,
  };

  const outputPath = path.join(LOG_DIR, `overnight-live-${Date.now()}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  detectStageFromMessage,
  extractPostId,
  hasUserFacingLeak,
};
