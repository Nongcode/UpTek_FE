import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  buildRestoredAutomationStreamState,
  findPersistedCheckpointMessage,
  getStreamPhaseLabel,
  hasFreshApprovalCheckpoint,
  isTerminalStreamPhase,
  isPersistedCheckpointMessage,
  mergeFetchedConversations,
  resolveNextActiveConversationId,
  resolveConversationLoadTarget,
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
const sseSource = fs.readFileSync(path.join(process.cwd(), "src/hooks/useSSE.ts"), "utf8");
const sidebarSource = fs.readFileSync(path.join(process.cwd(), "src/components/Sidebar.tsx"), "utf8");
const globalStylesSource = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const chatAreaSource = fs.readFileSync(path.join(process.cwd(), "src/components/ChatArea.tsx"), "utf8");
const pageSource = fs.readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");

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

test("personal lane always reloads conversations from the signed-in employee scope", () => {
  assert.equal(
    resolveConversationLoadTarget({
      chatLane: "user",
      employeeId: "pho_phong",
      viewingAgentId: "nv_content",
    }),
    "pho_phong",
  );
});

test("automation lane keeps subordinate scope when manager is monitoring another agent", () => {
  assert.equal(
    resolveConversationLoadTarget({
      chatLane: "automation",
      employeeId: "pho_phong",
      viewingAgentId: "nv_content",
    }),
    "nv_content",
  );
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
          phase: "streaming",
          messageId: "msg_stream",
          latestInputTimestamp: 250,
          finalContent: "",
        },
      ],
    ]),
  });

  assert.equal(merged[0]?.messages.length, 1);
  assert.equal(merged[0]?.messages[0]?.id, "msg_checkpoint");
});

test("mergeFetchedConversations drops backend-sync placeholder when remote checkpoint arrives", () => {
  const merged = mergeFetchedConversations({
    localConversations: [
      {
        ...baseConversation,
        messages: [
          {
            id: "msg_user",
            role: "user",
            type: "regular",
            content: "Duyet content, tao anh",
            timestamp: 200,
            conversationId: "conv_1",
          },
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
            id: "msg_user",
            role: "user",
            type: "regular",
            content: "Duyet content, tao anh",
            timestamp: 200,
            conversationId: "conv_1",
          },
          {
            id: "msg_checkpoint",
            role: "assistant",
            type: "approval_request",
            content: "NV Media da tao xong media.",
            timestamp: 400,
            conversationId: "conv_1",
          },
        ],
      },
    ],
    pendingMessageIdsByConversation: new Map([["conv_1", new Set(["msg_stream"])]]),
    preserveConversationIds: new Set(["conv_1"]),
    streamingMessageIdsByConversation: new Map(),
    streamStateByConversation: new Map([
      [
        "conv_1",
        {
          phase: "syncing_backend",
          messageId: "msg_stream",
          latestInputTimestamp: 250,
          finalContent: "",
        },
      ],
    ]),
  });

  assert.deepEqual(merged[0]?.messages.map((message) => message.id), ["msg_user", "msg_checkpoint"]);
});

test("mergeFetchedConversations keeps deterministic message order when timestamps tie", () => {
  const merged = mergeFetchedConversations({
    localConversations: [],
    remoteConversations: [
      {
        ...baseConversation,
        messages: [
          {
            id: "msg_z_assistant",
            role: "assistant",
            type: "regular",
            content: "Dang xu ly",
            timestamp: 300,
            conversationId: "conv_1",
          },
          {
            id: "msg_a_user",
            role: "user",
            type: "regular",
            content: "Tiep tuc",
            timestamp: 300,
            conversationId: "conv_1",
          },
          {
            id: "msg_manager",
            role: "manager",
            type: "manager_note",
            content: "Chi dao",
            timestamp: 300,
            conversationId: "conv_1",
          },
        ],
      },
    ],
    pendingMessageIdsByConversation: new Map(),
    preserveConversationIds: new Set(),
    streamingMessageIdsByConversation: new Map(),
  });

  assert.deepEqual(
    merged[0]?.messages.map((message) => message.id),
    ["msg_manager", "msg_a_user", "msg_z_assistant"],
  );
});

test("resolveNextActiveConversationId preserves selected workflow sub-agent across refresh", () => {
  assert.equal(
    resolveNextActiveConversationId({
      currentActiveId: "conv_nv_content",
      filteredConversationIds: ["conv_root"],
      workflowGroups: [
        {
          rootConversationId: "conv_root",
          memberConversationIds: ["conv_root", "conv_nv_content", "conv_nv_media"],
        },
      ],
    }),
    "conv_nv_content",
  );
});

test("resolveNextActiveConversationId falls back to workflow root when only workflow groups are visible", () => {
  assert.equal(
    resolveNextActiveConversationId({
      currentActiveId: null,
      filteredConversationIds: [],
      workflowGroups: [
        {
          rootConversationId: "conv_root",
          memberConversationIds: ["conv_root", "conv_nv_prompt"],
        },
      ],
    }),
    "conv_root",
  );
});

test("syncing_backend remains active and transport_error remains terminal", () => {
  assert.equal(isTerminalStreamPhase("syncing_backend"), false);
  assert.equal(isTerminalStreamPhase("transport_error"), true);
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

test("regular assistant reply after latest input clears backend-sync stream state", () => {
  const checkpoint = findPersistedCheckpointMessage(
    {
      ...baseConversation,
      messages: [
        {
          id: "msg_reply",
          role: "assistant",
          type: "regular",
          content: "Dang co workflow pending: Dang cho duyet content.",
          timestamp: 400,
          conversationId: "conv_1",
        },
      ],
    },
    250,
    "",
  );

  assert.equal(checkpoint?.id, "msg_reply");
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

test("active automation conversation restores waiting stream state after route remount", () => {
  const latestInputTimestamp = Date.now() - 10_000;
  const restored = buildRestoredAutomationStreamState(
    {
      ...baseConversation,
      status: "active",
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Trien khai quang cao",
          timestamp: latestInputTimestamp,
        },
      ],
    },
    Date.now(),
  );

  assert.equal(restored?.conversationId, "conv_1");
  assert.equal(restored?.phase, "syncing_backend");
  assert.equal(restored?.latestInputTimestamp, latestInputTimestamp);
  assert.match(restored?.messageId || "", /^msg_resume_conv_1_/);
});

test("automation restore is skipped once backend has an approval checkpoint", () => {
  const latestInputTimestamp = Date.now() - 10_000;
  const restored = buildRestoredAutomationStreamState(
    {
      ...baseConversation,
      status: "pending_approval",
      messages: [
        {
          id: "msg_user",
          role: "user",
          content: "Trien khai quang cao",
          timestamp: latestInputTimestamp,
        },
        {
          id: "msg_checkpoint",
          role: "assistant",
          type: "approval_request",
          content: "Duyet content",
          timestamp: latestInputTimestamp + 1000,
        },
      ],
    },
    Date.now(),
  );

  assert.equal(restored, null);
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

test("personal chat reload no longer uses subordinate agent id as the fetch bucket", () => {
  assert.match(hookSource, /const targetLoadId = resolveConversationLoadTarget\(\{\s*chatLane,\s*employeeId,\s*viewingAgentId,\s*\}\)/);
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
  assert.match(hookSource, /for \(const \[conversationId, streamState\] of Object\.entries\(streamStates\)\)/);
  assert.match(hookSource, /conversation\.id !== conversationId/);
  assert.match(hookSource, /normalizeConversationRecord\(conversation\)\.lane === "automation"/);
  assert.match(hookSource, /activeStream\.controller\.abort\(\)/);
  assert.match(hookSource, /messages: conversation\.messages\.filter\(\(message\) => message\.id !== streamMessageId\)/);
  assert.match(hookSource, /phase: "completed"/);
  assert.match(hookSource, /setTransientError\(null\)/);
  assert.match(hookSource, /finalizeActiveStreamFromBackendCheckpoint\(conversationId, checkpointMessage\)/);
});

test("realtime events include message checkpoints and trigger conversation reloads", () => {
  assert.match(sseSource, /"realtime\.snapshot"/);
  assert.match(sseSource, /"message\.created"/);
  assert.match(sseSource, /"conversation\.updated"/);
  assert.match(sseSource, /"workflow\.updated"/);
  assert.match(hookSource, /if \(eventName === "realtime\.snapshot"\)/);
  assert.match(hookSource, /if \(eventName === "workflow\.progress"\)/);
  assert.match(hookSource, /void mutateRef\.current\?\.\(\);/);
});

test("realtime resumes immediately after hidden tab, focus, or network restore", () => {
  assert.match(sseSource, /function reconnectAfterResume\(\)/);
  assert.match(sseSource, /window\.addEventListener\("focus", reconnectAfterResume\)/);
  assert.match(sseSource, /window\.addEventListener\("online", reconnectAfterResume\)/);
  assert.match(sseSource, /document\.addEventListener\("visibilitychange", reconnectAfterResume\)/);
  assert.match(sseSource, /scheduleReconnect\(0\)/);
  assert.match(sseSource, /openTimeout = setTimeout/);
  assert.match(sseSource, /setStatus\("connected"\);\s*const data = JSON\.parse/);
  assert.match(hookSource, /const refreshAfterRealtimeResume = \(\) => \{/);
  assert.match(hookSource, /window\.addEventListener\("focus", refreshAfterRealtimeResume\)/);
  assert.match(hookSource, /document\.addEventListener\("visibilitychange", refreshAfterRealtimeResume\)/);
});

test("automation route remount restores a backend-sync placeholder for active workflow", () => {
  assert.match(hookSource, /buildRestoredAutomationStreamState\(conversation, now\)/);
  assert.match(hookSource, /id: restoredState\.messageId/);
  assert.match(hookSource, /timestamp: restoredState\.latestInputTimestamp \+ 1/);
  assert.match(hookSource, /void applyConversations\(nextConversations\)/);
});

test("late stale stream callbacks are ignored once a new active stream request id wins", () => {
  assert.match(hookSource, /const streamRequestId = `stream_\$\{Date\.now\(\)\}_\$\{Math\.random\(\)\.toString\(36\)\.slice\(2, 9\)\}`/);
  assert.match(hookSource, /shouldIgnoreLateStreamChunk\(streamRequestId, getActiveStreamRequestId\(conversation\.id\)\)/);
});

test("personal chat is not auto-finalized by automation checkpoint reconcile effect", () => {
  assert.match(hookSource, /return normalizeConversationRecord\(conversation\)\.lane === "automation";/);
});

test("workflow grouping keeps fetched sub-agent conversations in manager automation scope", () => {
  assert.match(
    hookSource,
    /return normalizedConversation\.employeeId === employeeId \|\| Boolean\(normalizedConversation\.workflowId\);/,
  );
});

test("transport errors and UX-only status are not persisted as assistant messages", () => {
  assert.doesNotMatch(hookSource, /createMessage\(\s*"assistant"\s*,\s*".*Failed to fetch/i);
  assert.doesNotMatch(hookSource, /\[Lỗi: Failed to fetch\]/);
  assert.match(hookSource, /phase: "transport_error"/);
  assert.match(hookSource, /waitForBackendCheckpointAfterTransportDrop\(/);
  assert.match(hookSource, /phase: "syncing_backend"/);
});

test("abort path clears streaming placeholder via controller abort and cleanup", () => {
  assert.match(hookSource, /activeStream\?\.controller\.abort\(\)/);
  assert.match(hookSource, /cleanupStreaming\(conversationId, streamMessageId, "aborted"\)/);
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
  assert.equal(
    getStreamPhaseLabel({
      state: {
        ...state,
        phase: "syncing_backend",
      },
    }),
    "Dang doi du lieu dong bo tu backend...",
  );
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

test("automation error status has a dedicated sidebar label and badge style", () => {
  assert.match(sidebarSource, /status === "error"/);
  assert.match(sidebarSource, /return "Lỗi"/);
  assert.match(globalStylesSource, /\.conversation-status-badge\.error/);
});

test("chat area anchors scroll across conversation switches and media resizes", () => {
  assert.match(pageSource, /conversationId=\{activeConversation\?\.id \|\| null\}/);
  assert.match(chatAreaSource, /conversationId\?: string \| null/);
  assert.match(chatAreaSource, /resizeSnapshotRef/);
  assert.match(chatAreaSource, /currentMessageSnapshotRef/);
  assert.match(chatAreaSource, /new ResizeObserver/);
  assert.match(chatAreaSource, /!messageListChanged/);
  assert.match(chatAreaSource, /container\.scrollTop \+= heightDelta/);
  assert.match(chatAreaSource, /scrollToBottom\("auto"\)/);
});
