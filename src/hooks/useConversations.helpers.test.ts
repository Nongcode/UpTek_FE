import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  findPersistedCheckpointMessage,
  getStreamPhaseLabel,
  hasFreshApprovalCheckpoint,
  isPersistedCheckpointMessage,
  mergeFetchedConversations,
  shouldIgnoreLateStreamChunk,
  type StreamState,
} from "./useConversations.helpers";

const baseConversation = {
  id: "conv_1",
  title: "Test",
  lane: "automation" as const,
  agentId: "pho_phong",
  sessionKey: "agent:pho_phong:automation:wf_demo:auto_pho_phong_wf_demo",
  workflowId: "wf_demo",
  role: "root" as const,
  createdAt: 1,
  updatedAt: 1,
  messages: [],
};

const hookSource = fs.readFileSync(path.join(process.cwd(), "src/hooks/useConversations.ts"), "utf8");
const apiSource = fs.readFileSync(path.join(process.cwd(), "src/lib/api.ts"), "utf8");
const storageSource = fs.readFileSync(path.join(process.cwd(), "src/lib/storage.ts"), "utf8");

test("progress assistant after latest input does not block approval fallback", () => {
  const result = hasFreshApprovalCheckpoint(
    {
      ...baseConversation,
      messages: [
        {
          id: "msg_progress",
          role: "assistant",
          type: "regular",
          content: "Dang xu ly tiep...",
          timestamp: 200,
        },
      ],
    },
    100,
    "Can ban duyet content nay",
  );

  assert.equal(result, false);
});

test("approval_request after latest input blocks duplicate fallback", () => {
  const result = hasFreshApprovalCheckpoint(
    {
      ...baseConversation,
      messages: [
        {
          id: "msg_approval",
          role: "assistant",
          type: "approval_request",
          content: "Dang cho duyet content",
          timestamp: 200,
        },
      ],
    },
    100,
    "Dang cho duyet content",
  );

  assert.equal(result, true);
});

test("exact final content match blocks duplicate fallback", () => {
  const result = hasFreshApprovalCheckpoint(
    {
      ...baseConversation,
      messages: [
        {
          id: "msg_final",
          role: "assistant",
          type: "regular",
          content: "Ban da duyet noi dung nay",
          timestamp: 200,
        },
      ],
    },
    100,
    "Ban da duyet noi dung nay",
  );

  assert.equal(result, true);
});

test("assistant message before latest input does not block fallback", () => {
  const result = hasFreshApprovalCheckpoint(
    {
      ...baseConversation,
      messages: [
        {
          id: "msg_old",
          role: "assistant",
          type: "approval_request",
          content: "Checkpoint cu",
          timestamp: 50,
        },
      ],
    },
    100,
    "Checkpoint moi",
  );

  assert.equal(result, false);
});

test("mergeFetchedConversations preserves streaming local message when remote snapshot is stale", () => {
  const merged = mergeFetchedConversations({
    localConversations: [
        {
          ...baseConversation,
          lane: "user",
          workflowId: undefined,
          sessionKey: "chat:nv_content:conv_1",
          messages: [
          {
            id: "msg_stream",
            role: "assistant",
            type: "regular",
            content: "",
            timestamp: 300,
            conversationId: "conv_1",
          },
        ],
      },
    ],
    remoteConversations: [
        {
          ...baseConversation,
          lane: "user",
          workflowId: undefined,
          sessionKey: "chat:nv_content:conv_1",
          messages: [],
      },
    ],
    pendingMessageIdsByConversation: new Map([["conv_1", new Set(["msg_stream"])]]),
    preserveConversationIds: new Set(["conv_1"]),
    streamingMessageIdsByConversation: new Map([["conv_1", "msg_stream"]]),
  });

  assert.equal(merged[0]?.messages.length, 1);
  assert.equal(merged[0]?.messages[0]?.id, "msg_stream");
});

test("mergeFetchedConversations drops local streaming placeholder when backend has persisted approval checkpoint", () => {
  const merged = mergeFetchedConversations({
    localConversations: [
      {
        ...baseConversation,
        messages: [
          {
            id: "msg_stream",
            role: "assistant",
            type: "regular",
            content: "",
            timestamp: 300,
            conversationId: "conv_1",
          },
        ],
      },
    ],
    remoteConversations: [
      {
        ...baseConversation,
        messages: [
          {
            id: "msg_checkpoint",
            role: "assistant",
            type: "approval_request",
            content: "Cho ban duyet noi dung nay",
            timestamp: 400,
            conversationId: "conv_1",
          },
        ],
      },
    ],
    pendingMessageIdsByConversation: new Map([["conv_1", new Set(["msg_stream"])]]),
    preserveConversationIds: new Set(["conv_1"]),
    streamingMessageIdsByConversation: new Map([["conv_1", "msg_stream"]]),
    streamStateByConversation: new Map([
      [
        "conv_1",
        {
          latestInputTimestamp: 250,
          finalContent: "",
        },
      ],
    ]),
  });

  assert.equal(merged[0]?.messages.length, 1);
  assert.equal(merged[0]?.messages[0]?.id, "msg_checkpoint");
});

test("persisted automation approval_request is treated as authoritative backend checkpoint", () => {
  const checkpoint = findPersistedCheckpointMessage(
    {
      ...baseConversation,
      messages: [
        {
          id: "msg_checkpoint",
          role: "assistant",
          type: "approval_request",
          content: "Cho ban duyet noi dung nay",
          timestamp: 400,
          conversationId: "conv_1",
        },
      ],
    },
    250,
    "",
  );

  assert.equal(checkpoint?.id, "msg_checkpoint");
  assert.equal(
    isPersistedCheckpointMessage({
      message: checkpoint,
      latestInputTimestamp: 250,
      finalContent: "",
    }),
    true,
  );
});

test("late stream chunks from superseded request ids are ignored", () => {
  assert.equal(shouldIgnoreLateStreamChunk("stream_old", "stream_new"), true);
  assert.equal(shouldIgnoreLateStreamChunk("stream_same", "stream_same"), false);
  assert.equal(shouldIgnoreLateStreamChunk("stream_old", null), true);
});

test("useConversations sends existing conversation with conversation agentId and sessionKey", () => {
  assert.match(hookSource, /agentId: conversation\.agentId,/);
  assert.match(hookSource, /sessionKey: conversation\.sessionKey,/);
  assert.doesNotMatch(hookSource, /agentId: selectedAgentId/);
  assert.match(hookSource, /activeConversationAgentId: conversation\.agentId/);
  assert.match(hookSource, /activeConversationSessionKey: conversation\.sessionKey/);
  assert.match(hookSource, /selectedAgentId: viewingAgentId/);
  assert.match(hookSource, /model: `openclaw\/\$\{conversation\.agentId\}`/);
});

test("new personal conversation creation uses the currently viewed backend agent", () => {
  assert.match(hookSource, /apiCreateConversation\(\s*\{ agentId: viewingAgentId, lane: laneForConversation, employeeId: targetLoadId \|\| undefined \}/);
});

test("gateway stream request uses conversation agent headers, session key, and model mapping", () => {
  assert.match(apiSource, /headers\["X-OpenClaw-Session-Key"\] = opts\.sessionKey/);
  assert.match(apiSource, /headers\["X-OpenClaw-Agent-Id"\] = opts\.agentId/);
  assert.match(apiSource, /model: opts\.agentId \? `openclaw\/\$\{opts\.agentId\}` : \(opts\.model \|\| "openclaw"\)/);
});

test("useConversations persists assistant final content and exposes backend sync failure", () => {
  assert.match(hookSource, /onDone: \(\) => {\s*if \(shouldIgnoreLateStreamChunk\(streamRequestId, getActiveStreamRequestId\(conversation\.id\)\)\) {\s*return;\s*}\s*void commitAssistantMessage\(conversation\.id, assistantMessageId, finalContent, latestInputTimestamp\);/);
  assert.match(hookSource, /phase: "backend_sync_error"/);
  assert.match(hookSource, /finalContent: assistantMessage\.content/);
  assert.match(hookSource, /setTimeout\(\(\) => {\s*void retryPersistAssistantMessage/);
});

test("automation backend checkpoint finalizes active stream and clears stale local placeholder", () => {
  assert.match(hookSource, /const finalizeActiveStreamFromBackendCheckpoint = async/);
  assert.match(hookSource, /activeStream\.controller\.abort\(\)/);
  assert.match(hookSource, /messages: conversation\.messages\.filter\(\(message\) => message\.id !== activeStream\.messageId\)/);
  assert.match(hookSource, /phase: "completed"/);
  assert.match(hookSource, /setTransientError\(null\)/);
  assert.match(hookSource, /findPersistedCheckpointMessage\(/);
});

test("late stale stream callbacks are ignored once a new active stream request id wins", () => {
  assert.match(hookSource, /const streamRequestId = `stream_\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 9\)\}`/);
  assert.match(hookSource, /shouldIgnoreLateStreamChunk\(streamRequestId, getActiveStreamRequestId\(conversation\.id\)\)/);
});

test("personal chat is not auto-finalized by automation checkpoint reconcile effect", () => {
  assert.match(hookSource, /return normalizeConversationRecord\(conversation\)\.lane === "automation";/);
});

test("transport errors and UX-only status are not persisted as assistant messages", () => {
  assert.doesNotMatch(hookSource, /createMessage\(\s*"assistant"\s*,\s*".*Failed to fetch/i);
  assert.doesNotMatch(hookSource, /\[Lỗi: Failed to fetch\]/);
  assert.match(hookSource, /phase: "transport_error"/);
  assert.match(hookSource, /setTransientError\("Ket noi bi gian doan, dang doi du lieu dong bo tu backend\.\.\."\)/);
});

test("abort path clears streaming placeholder via controller abort and cleanup", () => {
  assert.match(hookSource, /activeStream\.controller\.abort\(\)/);
  assert.match(hookSource, /cleanupStreaming\(conversationId, activeStream\.messageId, "aborted"\)/);
  assert.match(hookSource, /clearInterval\(heartbeatRef\.current\)/);
});

test("storage layer no longer catches fetch failure and returns empty arrays", () => {
  assert.match(storageSource, /throw new BackendRequestError\(\s*errorData\?\.error\?\.message \|\| `Request failed with status \${response\.status}`,\s*response\.status,\s*\);/);
  assert.doesNotMatch(storageSource, /catch\s*\(\)\s*{\s*return \[\];\s*}/);
});

test("stream phase labels keep backend_sync_error and transport_error separate", () => {
  const state = {
    conversationId: "conv_1",
    messageId: "msg_1",
    phase: "backend_sync_error",
    startedAt: Date.now() - 1000,
    lastActivityAt: Date.now(),
    firstTokenAt: Date.now(),
    latestInputTimestamp: Date.now() - 2000,
  } satisfies StreamState;

  assert.equal(state.phase, "backend_sync_error");
});

test("completed stream no longer keeps workflow progress label alive", () => {
  const label = getStreamPhaseLabel({
    state: {
      conversationId: "conv_1",
      messageId: "msg_1",
      phase: "completed",
      startedAt: Date.now() - 1000,
      lastActivityAt: Date.now(),
      firstTokenAt: Date.now(),
      latestInputTimestamp: Date.now() - 2000,
    },
    workflowProgressLabel: "Dang cho duyet...",
  });

  assert.equal(label, null);
});
