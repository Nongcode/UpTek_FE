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

export type WorkflowProgressState = {
  workflowId: string;
  conversationId: string | null;
  agentId: string | null;
  stage: string;
  label: string;
  status: string | null;
  timestamp: number;
};

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
  return normalizedFinalContent.length > 0 && normalizedContent === normalizedFinalContent;
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
  return ordered.sort((left, right) => left.timestamp - right.timestamp);
}

export function mergeFetchedConversations(params: {
  localConversations: Conversation[];
  remoteConversations: Conversation[];
  pendingMessageIdsByConversation: Map<string, Set<string>>;
  preserveConversationIds: Set<string>;
  streamingMessageIdsByConversation: Map<string, string>;
  streamStateByConversation?: Map<
    string,
    Pick<StreamState, "latestInputTimestamp" | "finalContent">
  >;
}): Conversation[] {
  const localById = new Map(params.localConversations.map((conversation) => [conversation.id, normalizeConversationRecord(conversation)]));
  const remoteById = new Map(params.remoteConversations.map((conversation) => [conversation.id, normalizeConversationRecord(conversation)]));
  const merged: Conversation[] = [];

  for (const remoteConversation of remoteById.values()) {
    const localConversation = localById.get(remoteConversation.id);
    const pendingIds = params.pendingMessageIdsByConversation.get(remoteConversation.id) || new Set<string>();
    const streamingMessageId = params.streamingMessageIdsByConversation.get(remoteConversation.id);
    const streamState = params.streamStateByConversation?.get(remoteConversation.id);
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

  const isActiveStreamPhase = ![
    "completed",
    "aborted",
    "transport_error",
    "backend_sync_error",
  ].includes(state.phase);

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
      return "Dang dong bo workflow...";
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
