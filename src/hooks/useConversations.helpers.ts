import type { Conversation, Message } from "../lib/types";
import { normalizeAutomationStatus } from "../utils/chatLogic";

export type StreamPhase =
  | "idle"
  | "creating_conversation"
  | "saving_user_message"
  | "connecting"
  | "waiting_first_token"
  | "streaming"
  | "saving_assistant_message"
  | "syncing_backend"
  | "completed"
  | "aborted"
  | "transport_error"
  | "backend_sync_error";

export type StreamState = {
  conversationId: string;
  messageId: string;
  streamRequestId?: string;
  phase: StreamPhase;
  startedAt: number;
  lastActivityAt: number;
  firstTokenAt: number | null;
  latestInputTimestamp: number;
  finalContent?: string;
  errorMessage?: string | null;
};

export function isTerminalStreamPhase(phase: StreamPhase): boolean {
  return ["completed", "aborted", "transport_error", "backend_sync_error"].includes(phase);
}

export type WorkflowProgressState = {
  workflowId: string;
  conversationId: string | null;
  agentId: string | null;
  stage: string;
  label: string;
  status: string | null;
  timestamp: number;
};

export const RESTORED_AUTOMATION_STREAM_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function normalizeText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isPlaceholderOnlyContent(value: string): boolean {
  return value === "." || value === ".." || value === "...";
}

function normalizeLane(conversation: Conversation): "user" | "automation" {
  if (conversation.lane === "automation" || conversation.workflowId) {
    return "automation";
  }
  const sessionKey = String(conversation.sessionKey || "");
  if (sessionKey.startsWith("automation:") || sessionKey.includes(":automation:")) {
    return "automation";
  }
  return "user";
}

export function normalizeConversationRecord(conversation: Conversation): Conversation {
  return {
    ...conversation,
    lane: normalizeLane(conversation),
  };
}

export function resolveConversationLoadTarget(params: {
  chatLane: "user" | "automation";
  employeeId: string | null;
  viewingAgentId: string;
}): string | null {
  const employeeId = normalizeText(params.employeeId);
  const viewingAgentId = normalizeText(params.viewingAgentId);

  if (params.chatLane === "user") {
    return employeeId || viewingAgentId || null;
  }

  if (viewingAgentId && viewingAgentId !== employeeId) {
    return viewingAgentId;
  }

  return employeeId || viewingAgentId || null;
}

export function hasFreshApprovalCheckpoint(
  conversation: Conversation | null | undefined,
  latestInputTimestamp: number,
  finalContent: string,
): boolean {
  if (!conversation) {
    return false;
  }

  const normalizedFinalContent = normalizeText(finalContent);

  return conversation.messages.some((message) => {
    if (message.role !== "assistant") {
      return false;
    }
    if (Number(message.timestamp) < latestInputTimestamp) {
      return false;
    }

    const normalizedContent = normalizeText(message.content);
    if (!normalizedContent) {
      return false;
    }

    if (message.type === "approval_request") {
      return true;
    }

    const normalizedStatus = String(normalizeAutomationStatus(normalizedContent) || "");
    if (normalizedStatus === "pending_approval" || normalizedStatus === "awaiting_approval") {
      return true;
    }

    return normalizedFinalContent.length > 0 && normalizedContent === normalizedFinalContent;
  });
}

export function isPersistedCheckpointMessage(params: {
  message: Message | null | undefined;
  latestInputTimestamp: number;
  finalContent?: string | null;
}): boolean {
  const message = params.message;
  if (!message || message.role !== "assistant") {
    return false;
  }
  if (Number(message.timestamp) < params.latestInputTimestamp) {
    return false;
  }

  const normalizedContent = normalizeText(message.content);
  if (!normalizedContent || isPlaceholderOnlyContent(normalizedContent)) {
    return false;
  }

  if (message.type === "approval_request") {
    return true;
  }

  const normalizedStatus = String(normalizeAutomationStatus(normalizedContent) || "");
  if (
    normalizedStatus === "pending_approval"
    || normalizedStatus === "awaiting_approval"
    || normalizedStatus === "approved"
    || normalizedStatus === "cancelled"
  ) {
    return true;
  }

  const normalizedFinalContent = normalizeText(params.finalContent);
  if (normalizedFinalContent.length > 0 && normalizedContent === normalizedFinalContent) {
    return true;
  }

  // Automation backend can persist a regular assistant reply instead of an approval_request.
  // Once a real assistant message exists after the user's input, the UI must stop blocking input.
  return true;
}

export function findPersistedCheckpointMessage(
  conversation: Conversation | null | undefined,
  latestInputTimestamp: number,
  finalContent?: string | null,
): Message | null {
  if (!conversation) {
    return null;
  }

  for (const message of [...conversation.messages].sort((left, right) => right.timestamp - left.timestamp)) {
    if (
      isPersistedCheckpointMessage({
        message,
        latestInputTimestamp,
        finalContent,
      })
    ) {
      return message;
    }
  }

  return null;
}

export function findLatestUserInputMessage(conversation: Conversation | null | undefined): Message | null {
  if (!conversation) {
    return null;
  }
  for (const message of [...conversation.messages].sort((left, right) => right.timestamp - left.timestamp)) {
    if (message.role === "user" || message.role === "manager") {
      return message;
    }
  }
  return null;
}

export function buildRestoredAutomationStreamState(
  conversation: Conversation,
  now = Date.now(),
  maxAgeMs = RESTORED_AUTOMATION_STREAM_MAX_AGE_MS,
): StreamState | null {
  const normalizedConversation = normalizeConversationRecord(conversation);
  if (normalizedConversation.lane !== "automation") {
    return null;
  }

  const status = String(normalizedConversation.status || "active").trim();
  if (status && status !== "active") {
    return null;
  }

  const latestInput = findLatestUserInputMessage(normalizedConversation);
  if (!latestInput) {
    return null;
  }

  const latestInputTimestamp = Number(latestInput.timestamp) || 0;
  if (!latestInputTimestamp || now - latestInputTimestamp > maxAgeMs) {
    return null;
  }

  const checkpointMessage = findPersistedCheckpointMessage(
    normalizedConversation,
    latestInputTimestamp,
    "",
  );
  if (checkpointMessage) {
    return null;
  }

  const messageId = `msg_resume_${normalizedConversation.id}_${latestInputTimestamp}`;
  return {
    conversationId: normalizedConversation.id,
    messageId,
    streamRequestId: `resume_${normalizedConversation.id}_${latestInputTimestamp}`,
    phase: "syncing_backend",
    startedAt: latestInputTimestamp,
    lastActivityAt: now,
    firstTokenAt: null,
    latestInputTimestamp,
    finalContent: "",
    errorMessage: null,
  };
}

export function shouldIgnoreLateStreamChunk(
  streamRequestId: string | null | undefined,
  activeStreamRequestId: string | null | undefined,
): boolean {
  const current = normalizeText(streamRequestId);
  const active = normalizeText(activeStreamRequestId);
  if (!current || !active) {
    return true;
  }
  return current !== active;
}

function uniqueMessages(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const ordered: Message[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    ordered.push(message);
  }
  return ordered.sort(compareMessagesForDisplay);
}

function messageRoleRank(role: Message["role"]): number {
  if (role === "system") return 0;
  if (role === "manager") return 1;
  if (role === "user") return 2;
  if (role === "assistant") return 3;
  return 4;
}

function compareMessagesForDisplay(left: Message, right: Message): number {
  const timestampDiff = (Number(left.timestamp) || 0) - (Number(right.timestamp) || 0);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  const roleDiff = messageRoleRank(left.role) - messageRoleRank(right.role);
  if (roleDiff !== 0) {
    return roleDiff;
  }

  return String(left.id || "").localeCompare(String(right.id || ""));
}

export function resolveNextActiveConversationId(params: {
  currentActiveId: string | null;
  filteredConversationIds: string[];
  workflowGroups: Array<{
    rootConversationId: string | null;
    memberConversationIds: string[];
  }>;
}): string | null {
  const visibleIds = new Set(params.filteredConversationIds);
  for (const group of params.workflowGroups) {
    for (const conversationId of group.memberConversationIds) {
      visibleIds.add(conversationId);
    }
  }

  if (params.currentActiveId && visibleIds.has(params.currentActiveId)) {
    return params.currentActiveId;
  }

  const firstFilteredId = params.filteredConversationIds[0];
  if (firstFilteredId) {
    return firstFilteredId;
  }

  for (const group of params.workflowGroups) {
    if (group.rootConversationId) {
      return group.rootConversationId;
    }
    const firstMemberId = group.memberConversationIds[0];
    if (firstMemberId) {
      return firstMemberId;
    }
  }

  return null;
}

export function mergeFetchedConversations(params: {
  localConversations: Conversation[];
  remoteConversations: Conversation[];
  pendingMessageIdsByConversation: Map<string, Set<string>>;
  preserveConversationIds: Set<string>;
  streamingMessageIdsByConversation: Map<string, string>;
  streamStateByConversation?: Map<
    string,
    Pick<StreamState, "phase" | "messageId" | "latestInputTimestamp" | "finalContent">
  >;
}): Conversation[] {
  const localById = new Map(params.localConversations.map((conversation) => [conversation.id, normalizeConversationRecord(conversation)]));
  const remoteById = new Map(params.remoteConversations.map((conversation) => [conversation.id, normalizeConversationRecord(conversation)]));
  const merged: Conversation[] = [];

  for (const remoteConversation of remoteById.values()) {
    const localConversation = localById.get(remoteConversation.id);
    const pendingIds = params.pendingMessageIdsByConversation.get(remoteConversation.id) || new Set<string>();
    const streamState = params.streamStateByConversation?.get(remoteConversation.id);
    const streamingMessageId =
      params.streamingMessageIdsByConversation.get(remoteConversation.id)
      || (streamState && !isTerminalStreamPhase(streamState.phase) ? streamState.messageId : undefined);
    const backendCheckpointMessage = streamState
      ? findPersistedCheckpointMessage(
          remoteConversation,
          streamState.latestInputTimestamp,
          streamState.finalContent,
        )
      : null;
    const localMessagesToPreserve =
      localConversation?.messages.filter((message) => {
        if (backendCheckpointMessage && streamingMessageId && message.id === streamingMessageId) {
          return false;
        }
        if (streamingMessageId && message.id === streamingMessageId) {
          return true;
        }
        return pendingIds.has(message.id);
      }) || [];

    const remoteMessageIds = new Set(remoteConversation.messages.map((message) => message.id));
    const preservedMessages = localMessagesToPreserve.filter((message) => !remoteMessageIds.has(message.id));

    merged.push({
      ...remoteConversation,
      messages: uniqueMessages([...remoteConversation.messages, ...preservedMessages]),
      updatedAt: Math.max(
        Number(remoteConversation.updatedAt) || 0,
        Number(localConversation?.updatedAt) || 0,
      ),
    });
  }

  for (const localConversation of localById.values()) {
    if (remoteById.has(localConversation.id)) {
      continue;
    }
    if (params.preserveConversationIds.has(localConversation.id)) {
      merged.push(localConversation);
    }
  }

  return merged.sort((left, right) => right.updatedAt - left.updatedAt);
}

export function getStreamPhaseLabel(params: {
  state: StreamState | null;
  workflowProgressLabel?: string | null;
}): string | null {
  const { state } = params;
  if (!state) {
    return null;
  }

  const isActiveStreamPhase = !isTerminalStreamPhase(state.phase);

  if (params.workflowProgressLabel && isActiveStreamPhase) {
    return params.workflowProgressLabel;
  }

  const elapsedMs = Math.max(0, Date.now() - state.startedAt);
  switch (state.phase) {
    case "creating_conversation":
      return "Dang tao cuoc tro chuyen...";
    case "saving_user_message":
      return "Dang luu yeu cau cua ban...";
    case "connecting":
      return "Dang ket noi toi agent...";
    case "waiting_first_token":
      if (elapsedMs < 2_000) return "Dang gui yeu cau...";
      if (elapsedMs < 6_000) return "Agent dang phan tich...";
      if (elapsedMs < 15_000) return "Dang xu ly, tac vu co the mat them chut thoi gian...";
      if (elapsedMs < 90_000) return "Van dang chay. Ban co the tiep tuc cho hoac bam Dung.";
      return "Tac vu dang lau hon binh thuong. Ban co the thu dong bo lai hoac bam Dung.";
    case "streaming":
      if (elapsedMs < 20_000) return "Agent dang tra loi...";
      if (elapsedMs < 90_000) return "Van dang xu ly...";
      return "Tac vu nay lau hon binh thuong, nhung van dang cho phan hoi.";
    case "saving_assistant_message":
      return "Dang luu phan hoi...";
    case "syncing_backend":
      return "Dang doi du lieu dong bo tu backend...";
    case "aborted":
      return "Da dung phan hoi.";
    case "transport_error":
      return "Ket noi bi gian doan. Phan hoi chua duoc luu.";
    case "backend_sync_error":
      return "Da co phan hoi nhung luu backend loi, dang thu dong bo lai...";
    default:
      return null;
  }
}

export function formatWorkflowProgressLabel(progress: {
  label?: string | null;
  stage?: string | null;
  agentId?: string | null;
  timestamp?: number | null;
} | null | undefined): string | null {
  if (!progress) {
    return null;
  }
  if (normalizeText(progress.label)) {
    return normalizeText(progress.label);
  }
  const stage = normalizeText(progress.stage);
  const agent = normalizeText(progress.agentId);
  if (!stage) {
    return null;
  }
  return agent ? `${stage} · ${agent}` : stage;
}
