"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import toast from "react-hot-toast";
import { AccessPolicy, Conversation, Message } from "@/lib/types";
import {
  apiCreateConversation,
  apiDeleteConversation,
  apiSaveMessages,
  apiUpdateConversation,
  BackendRequestError,
  createMessage,
  generateConversationTitle,
  loadConversations,
} from "@/lib/storage";
import { streamChatCompletion } from "@/lib/api";
import {
  canAccessAutomationLane,
  ChatLane,
  detectAutomationCancellationIntent,
  extractAutomationWorkflowId,
  normalizeAutomationStatus,
} from "@/utils/chatLogic";
import { SSEConnectionStatus, SSEEventName, useSSE } from "@/hooks/useSSE";
import {
  findPersistedCheckpointMessage,
  formatWorkflowProgressLabel,
  buildRestoredAutomationStreamState,
  getStreamPhaseLabel,
  hasFreshApprovalCheckpoint,
  isTerminalStreamPhase,
  mergeFetchedConversations,
  normalizeConversationRecord,
  resolveNextActiveConversationId,
  resolveConversationLoadTarget,
  shouldIgnoreLateStreamChunk,
  type StreamPhase,
  type StreamState,
} from "@/hooks/useConversations.helpers";

export interface StreamingStore {
  getSnapshot: (messageId: string) => string;
  subscribe: (messageId: string, listener: () => void) => () => void;
}

interface UseConversationsOptions {
  token: string | null;
  backendToken: string | null;
  employeeId: string | null;
  accessPolicy: AccessPolicy | null;
  viewingAgentId: string;
  chatLane: ChatLane;
  canUseAutomationLane: boolean;
  enablePolling: boolean;
}

interface SendMessageType {
  type?: "manager_note";
}

export type SessionBoxConversation = Conversation & {
  memberConversationIds: string[];
  memberConversations: Conversation[];
};

export type WorkflowConversationGroup = {
  workflowId: string;
  title: string;
  updatedAt: number;
  rootConversationId: string | null;
  memberConversationIds: string[];
  memberConversations: Conversation[];
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

function isTechnicalAutomationTitle(title: string | undefined): boolean {
  const normalized = String(title || "").trim();
  return (
    normalized.length === 0
    || normalized.startsWith("[AUTO]")
    || normalized.includes("wf_")
    || normalized.includes("automation:")
    || normalized.includes("auto_")
  );
}

function resolveConversationRole(conversation: Conversation): "root" | "sub_agent" {
  return conversation.role || (conversation.parentConversationId ? "sub_agent" : "root");
}

function buildWorkflowConversationGroups(
  conversations: Conversation[],
  viewingAgentId: string,
): WorkflowConversationGroup[] {
  const grouped = new Map<string, Conversation[]>();

  for (const conversation of conversations) {
    const workflowId = conversation.workflowId || extractAutomationWorkflowId(conversation);
    if (!workflowId) {
      continue;
    }
    const list = grouped.get(workflowId) || [];
    list.push(conversation);
    grouped.set(workflowId, list);
  }

  return [...grouped.entries()]
    .map(([workflowId, group]) => {
      const latestConversation = group.reduce((latest, current) =>
        current.updatedAt > latest.updatedAt ? current : latest,
      );
      const rootConversation =
        group.find((conversation) => resolveConversationRole(conversation) === "root")
        || group.find((conversation) => conversation.agentId === viewingAgentId)
        || null;
      const preferredTitle = group.find(
        (conversation) => !isTechnicalAutomationTitle(conversation.title),
      )?.title;
      return {
        workflowId,
        title:
          rootConversation?.title
          || preferredTitle
          || latestConversation.title
          || "Luong tu dong",
        updatedAt: latestConversation.updatedAt,
        rootConversationId: rootConversation?.id || null,
        memberConversationIds: group.map((conversation) => conversation.id),
        memberConversations: group.sort((left, right) => left.createdAt - right.createdAt),
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function tagMessages(conversationId: string, messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    conversationId,
  }));
}

function toProgressState(data: unknown): WorkflowProgressState | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const payload = data as Record<string, unknown>;
  const workflowId = String(payload.workflowId || "").trim();
  const stage = String(payload.stage || "").trim();
  if (!workflowId || !stage) {
    return null;
  }
  const timestamp = Number(payload.timestamp) || Date.now();
  return {
    workflowId,
    conversationId: String(payload.conversationId || "").trim() || null,
    agentId: String(payload.agentId || "").trim() || null,
    stage,
    label: String(payload.label || "").trim() || stage,
    status: String(payload.status || "").trim() || null,
    timestamp,
  };
}

function shouldReuseDraftConversation(
  conversation: Conversation | null,
  lane: ChatLane,
  viewingAgentId: string,
): boolean {
  if (!conversation) {
    return false;
  }
  if (normalizeConversationRecord(conversation).lane !== lane) {
    return false;
  }
  if (conversation.agentId !== viewingAgentId) {
    return false;
  }
  return conversation.messages.length === 0;
}

function getRequestErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof BackendRequestError) {
    if (error.status === 401) {
      return "Phien dang nhap backend da het han. Hay dang nhap lai.";
    }
    if (error.status === 403) {
      return "Ban khong co quyen thuc hien thao tac nay.";
    }
    return error.message || fallback;
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function useConversations({
  token,
  backendToken,
  employeeId,
  accessPolicy,
  viewingAgentId,
  chatLane,
  canUseAutomationLane,
  enablePolling,
}: UseConversationsOptions) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [streamStates, setStreamStates] = useState<Record<string, StreamState>>({});
  const [workflowProgressById, setWorkflowProgressById] = useState<Record<string, WorkflowProgressState>>({});
  const [createInFlight, setCreateInFlight] = useState(false);
  const [transientError, setTransientError] = useState<string | null>(null);

  const conversationsRef = useRef<Conversation[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const mutateRef = useRef<(() => void) | null>(null);
  const createConversationPromiseRef = useRef<Promise<Conversation> | null>(null);
  const pendingMessageIdsByConversationRef = useRef<Map<string, Set<string>>>(new Map());
  const pendingConversationIdsRef = useRef<Set<string>>(new Set());
  const streamingMapRef = useRef<
    Map<string, { messageId: string; controller: AbortController; requestId: string; superseded?: boolean }>
  >(new Map());
  const streamStatesRef = useRef<Record<string, StreamState>>({});
  const streamContentRef = useRef<Map<string, string>>(new Map());
  const streamListenersRef = useRef<Map<string, Set<() => void>>>(new Map());
  const streamingStoreRef = useRef<StreamingStore | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const targetLoadId = resolveConversationLoadTarget({
    chatLane,
    employeeId,
    viewingAgentId,
  });
  const shouldFetch = Boolean(targetLoadId && backendToken);

  const updateStreamState = (conversationId: string, updater: StreamState | ((previous: StreamState | null) => StreamState | null)) => {
    setStreamStates((previous) => {
      const current = previous[conversationId] || null;
      const nextState = typeof updater === "function" ? updater(current) : updater;
      if (!nextState) {
        const next = { ...previous };
        delete next[conversationId];
        return next;
      }
      return {
        ...previous,
        [conversationId]: nextState,
      };
    });
  };

  const notifyStreamListeners = (messageId: string) => {
    const listeners = streamListenersRef.current.get(messageId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener();
    }
  };

  const setStreamContent = (messageId: string, content: string) => {
    streamContentRef.current.set(messageId, content);
    notifyStreamListeners(messageId);
  };

  const clearStreamContent = (messageId: string) => {
    streamContentRef.current.delete(messageId);
    notifyStreamListeners(messageId);
  };

  if (!streamingStoreRef.current) {
    streamingStoreRef.current = {
      getSnapshot: (messageId: string) => streamContentRef.current.get(messageId) || "",
      subscribe: (messageId: string, listener: () => void) => {
        const listeners = streamListenersRef.current.get(messageId) || new Set<() => void>();
        listeners.add(listener);
        streamListenersRef.current.set(messageId, listeners);
        return () => {
          const currentListeners = streamListenersRef.current.get(messageId);
          if (!currentListeners) {
            return;
          }
          currentListeners.delete(listener);
          if (currentListeners.size === 0) {
            streamListenersRef.current.delete(messageId);
          }
        };
      },
    };
  }

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    streamStatesRef.current = streamStates;
  }, [streamStates]);

  useEffect(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    const activeStreamIds = Object.keys(streamStates);
    if (activeStreamIds.length === 0) {
      return;
    }
    heartbeatRef.current = setInterval(() => {
      setStreamStates((previous) => ({ ...previous }));
    }, 3000);
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [streamStates]);

  const sseStatus = useSSE({
    backendToken,
    enabled: enablePolling,
    onEvent: (eventName: SSEEventName, data) => {
      if (eventName === "realtime.snapshot") {
        void mutateRef.current?.();
        return;
      }

      if (eventName === "workflow.progress") {
        const progress = toProgressState(data);
        if (progress) {
          setWorkflowProgressById((previous) => ({
            ...previous,
            [progress.workflowId]: progress,
          }));
        }
        return;
      }

      if (eventName === "conversation.deleted" && data && typeof data === "object") {
        const deletedId = String((data as Record<string, unknown>).id || "").trim();
        if (deletedId) {
          void mutateRef.current?.();
        }
        return;
      }

      void mutateRef.current?.();
    },
  });

  const refreshInterval = useMemo(() => {
    if (!enablePolling) {
      return 0;
    }
    const hasActiveAutomationStream =
      chatLane === "automation"
      && Object.values(streamStates).some((state) => !isTerminalStreamPhase(state.phase));
    if (hasActiveAutomationStream) {
      return 3000;
    }
    if (sseStatus !== "connected") {
      return chatLane === "automation" ? 5000 : 10000;
    }
    if (Object.keys(streamStates).length > 0) {
      return 15000;
    }
    return chatLane === "automation" ? 15000 : 30000;
  }, [chatLane, enablePolling, sseStatus, streamStates]);

  const swrKey = shouldFetch
    ? `conversations:${targetLoadId}:${canUseAutomationLane ? "all" : "user"}`
    : null;

  const { data: conversations = [], mutate } = useSWR<Conversation[]>(
    swrKey,
    async () => {
      const remoteConversations = (await loadConversations(
        targetLoadId as string,
        { includeAutomation: canUseAutomationLane },
        { backendToken: backendToken as string },
      )).map(normalizeConversationRecord);

      const merged = mergeFetchedConversations({
        localConversations: conversationsRef.current,
        remoteConversations,
        pendingMessageIdsByConversation: pendingMessageIdsByConversationRef.current,
        preserveConversationIds: pendingConversationIdsRef.current,
        streamingMessageIdsByConversation: new Map(
          [...streamingMapRef.current.entries()].map(([conversationId, value]) => [conversationId, value.messageId]),
        ),
        streamStateByConversation: new Map(
          Object.entries(streamStates).map(([conversationId, state]) => [
            conversationId,
            {
              phase: state.phase,
              messageId: state.messageId,
              latestInputTimestamp: state.latestInputTimestamp,
              finalContent: state.finalContent || streamContentRef.current.get(state.messageId) || "",
            },
          ]),
        ),
      });

      for (const conversation of merged) {
        const pendingIds = pendingMessageIdsByConversationRef.current.get(conversation.id);
        if (!pendingIds) {
          continue;
        }
        const remoteMessageIds = new Set((remoteConversations.find((item) => item.id === conversation.id)?.messages || []).map((message) => message.id));
        for (const messageId of [...pendingIds]) {
          if (remoteMessageIds.has(messageId)) {
            pendingIds.delete(messageId);
          }
        }
        if (pendingIds.size === 0) {
          pendingMessageIdsByConversationRef.current.delete(conversation.id);
        }
        if (!streamingMapRef.current.has(conversation.id) && !pendingMessageIdsByConversationRef.current.has(conversation.id)) {
          pendingConversationIdsRef.current.delete(conversation.id);
        }
      }

      return merged;
    },
    {
      fallbackData: [],
      keepPreviousData: true,
      refreshInterval,
      revalidateOnFocus: enablePolling,
      revalidateOnReconnect: true,
      dedupingInterval: 3000,
      shouldRetryOnError: true,
    },
  );

  mutateRef.current = () => {
    void mutate();
  };

  useEffect(() => {
    if (!enablePolling || !backendToken) {
      return;
    }

    const refreshAfterRealtimeResume = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      void mutateRef.current?.();
    };

    window.addEventListener("focus", refreshAfterRealtimeResume);
    window.addEventListener("online", refreshAfterRealtimeResume);
    document.addEventListener("visibilitychange", refreshAfterRealtimeResume);
    return () => {
      window.removeEventListener("focus", refreshAfterRealtimeResume);
      window.removeEventListener("online", refreshAfterRealtimeResume);
      document.removeEventListener("visibilitychange", refreshAfterRealtimeResume);
    };
  }, [backendToken, enablePolling]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    for (const [conversationId, streamState] of Object.entries(streamStates)) {
      if (isTerminalStreamPhase(streamState.phase)) {
        continue;
      }

      const streamConversation =
        conversations.find((conversation) => {
          if (conversation.id !== conversationId) {
            return false;
          }
          return normalizeConversationRecord(conversation).lane === "automation";
        }) || null;
      if (!streamConversation) {
        continue;
      }

      const checkpointMessage = findPersistedCheckpointMessage(
        streamConversation,
        streamState.latestInputTimestamp,
        streamState.finalContent || streamContentRef.current.get(streamState.messageId) || "",
      );
      if (!checkpointMessage) {
        continue;
      }

      void finalizeActiveStreamFromBackendCheckpoint(conversationId, checkpointMessage);
    }
  }, [conversations, streamStates]);

  const matchesLaneConversation = (conversation: Conversation) => {
    const normalizedConversation = normalizeConversationRecord(conversation);
    if (normalizedConversation.lane !== chatLane) {
      return false;
    }

    if (chatLane === "user") {
      return normalizedConversation.agentId === viewingAgentId;
    }

    const role = resolveConversationRole(normalizedConversation);
    const isOwnAutomationScope = viewingAgentId === employeeId;
    if (isOwnAutomationScope) {
      return normalizedConversation.agentId === viewingAgentId && role === "root";
    }
    return normalizedConversation.agentId === viewingAgentId || normalizedConversation.employeeId === viewingAgentId;
  };

  const matchesWorkflowGroupConversation = (conversation: Conversation) => {
    const normalizedConversation = normalizeConversationRecord(conversation);
    if (normalizedConversation.lane !== "automation") {
      return false;
    }
    if (viewingAgentId === employeeId) {
      return normalizedConversation.employeeId === employeeId || Boolean(normalizedConversation.workflowId);
    }
    return normalizedConversation.agentId === viewingAgentId || normalizedConversation.employeeId === viewingAgentId;
  };

  const filteredSourceConversations = useMemo(
    () => conversations.filter(matchesLaneConversation),
    [chatLane, conversations, employeeId, viewingAgentId],
  );

  const filteredConversations = useMemo(() => {
    return [...filteredSourceConversations]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((conversation) => ({
        ...conversation,
        memberConversationIds: [conversation.id],
        memberConversations: [conversation],
      })) as SessionBoxConversation[];
  }, [filteredSourceConversations]);

  const workflowGroups = useMemo(() => {
    if (chatLane !== "automation") {
      return [] as WorkflowConversationGroup[];
    }
    return buildWorkflowConversationGroups(
      conversations.filter(matchesWorkflowGroupConversation),
      viewingAgentId,
    );
  }, [chatLane, conversations, employeeId, viewingAgentId]);

  useEffect(() => {
    const nextActiveId = resolveNextActiveConversationId({
      currentActiveId: activeIdRef.current,
      filteredConversationIds: filteredConversations.map((conversation) => conversation.id),
      workflowGroups,
    });
    if (nextActiveId !== activeIdRef.current) {
      setActiveId(nextActiveId);
    }
  }, [filteredConversations, workflowGroups]);

  const applyConversations = async (nextConversations: Conversation[]) => {
    conversationsRef.current = nextConversations;
    await mutate(nextConversations, false);
  };

  const markPendingMessage = (conversationId: string, messageId: string) => {
    const set = pendingMessageIdsByConversationRef.current.get(conversationId) || new Set<string>();
    set.add(messageId);
    pendingMessageIdsByConversationRef.current.set(conversationId, set);
    pendingConversationIdsRef.current.add(conversationId);
  };

  const clearPendingMessage = (conversationId: string, messageId: string) => {
    const set = pendingMessageIdsByConversationRef.current.get(conversationId);
    if (!set) {
      return;
    }
    set.delete(messageId);
    if (set.size === 0) {
      pendingMessageIdsByConversationRef.current.delete(conversationId);
      if (!streamingMapRef.current.has(conversationId)) {
        pendingConversationIdsRef.current.delete(conversationId);
      }
    }
  };

  useEffect(() => {
    if (chatLane !== "automation" || !enablePolling) {
      return;
    }

    let nextConversations: Conversation[] | null = null;
    const now = Date.now();
    const activeConversationId = activeIdRef.current;
    if (!activeConversationId) {
      return;
    }

    for (const conversation of conversationsRef.current) {
      if (conversation.id !== activeConversationId) {
        continue;
      }
      const restoredState = buildRestoredAutomationStreamState(conversation, now);
      if (!restoredState) {
        continue;
      }
      const currentState = streamStatesRef.current[conversation.id] || null;
      if (currentState && !isTerminalStreamPhase(currentState.phase)) {
        continue;
      }
      if (streamingMapRef.current.has(conversation.id)) {
        continue;
      }

      markPendingMessage(conversation.id, restoredState.messageId);
      pendingConversationIdsRef.current.add(conversation.id);
      setStreamContent(restoredState.messageId, restoredState.finalContent || "");
      updateStreamState(conversation.id, restoredState);

      if (!conversation.messages.some((message) => message.id === restoredState.messageId)) {
        nextConversations = (nextConversations || conversationsRef.current).map((item) => {
          if (item.id !== conversation.id) {
            return item;
          }
          return {
            ...item,
            messages: [
              ...item.messages,
              {
                id: restoredState.messageId,
                role: "assistant",
                type: "regular",
                content: "",
                timestamp: restoredState.latestInputTimestamp + 1,
                conversationId: conversation.id,
              },
            ],
          };
        });
      }
    }

    if (nextConversations) {
      void applyConversations(nextConversations);
    }
  }, [activeId, chatLane, conversations, enablePolling]);

  const getActiveStreamRequestId = (conversationId: string): string | null => {
    return streamingMapRef.current.get(conversationId)?.requestId || null;
  };

  const finalizeActiveStreamFromBackendCheckpoint = async (
    conversationId: string,
    checkpointMessage: Message,
  ) => {
    const activeStream = streamingMapRef.current.get(conversationId);
    const streamMessageId = activeStream?.messageId || streamStates[conversationId]?.messageId || "";
    if (activeStream) {
      activeStream.superseded = true;
      activeStream.controller.abort();
      streamingMapRef.current.delete(conversationId);
    }

    if (streamMessageId) {
      clearStreamContent(streamMessageId);
      clearPendingMessage(conversationId, streamMessageId);

      if (streamMessageId !== checkpointMessage.id) {
        await applyConversations(
          conversationsRef.current.map((conversation) => {
            if (conversation.id !== conversationId) {
              return conversation;
            }

            return {
              ...conversation,
              messages: conversation.messages.filter((message) => message.id !== streamMessageId),
            };
          }),
        );
      }
    }

    const currentConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId) || null;
    const workflowId =
      currentConversation?.workflowId
      || extractAutomationWorkflowId(currentConversation || { id: "", sessionKey: "", workflowId: undefined })
      || null;
    if (workflowId) {
      setWorkflowProgressById((previous) => {
        if (!previous[workflowId]) {
          return previous;
        }
        const next = { ...previous };
        delete next[workflowId];
        return next;
      });
    }

    updateStreamState(conversationId, (previous) =>
      previous
        ? {
            ...previous,
            phase: "completed",
            messageId: checkpointMessage.id,
            finalContent: checkpointMessage.content,
            lastActivityAt: Date.now(),
            errorMessage: null,
          }
        : previous,
    );
    setTransientError(null);
  };

  const cleanupStreaming = (conversationId: string, messageId: string, nextPhase: StreamPhase = "completed", errorMessage?: string | null) => {
    streamingMapRef.current.delete(conversationId);
    clearStreamContent(messageId);
    clearPendingMessage(conversationId, messageId);
    updateStreamState(conversationId, (previous) => {
      if (!previous) {
        return null;
      }
      return {
        ...previous,
        phase: nextPhase,
        lastActivityAt: Date.now(),
        errorMessage: errorMessage || null,
      };
    });
  };

  const waitForBackendCheckpointAfterTransportDrop = (
    conversationId: string,
    messageId: string,
    finalContent: string,
    errorMessage?: string | null,
  ) => {
    const activeStream = streamingMapRef.current.get(conversationId);
    if (activeStream) {
      activeStream.superseded = true;
      activeStream.controller.abort();
      streamingMapRef.current.delete(conversationId);
    }

    markPendingMessage(conversationId, messageId);
    pendingConversationIdsRef.current.add(conversationId);
    setStreamContent(messageId, finalContent);
    updateStreamState(conversationId, (previous) =>
      previous
        ? {
            ...previous,
            phase: "syncing_backend",
            finalContent,
            lastActivityAt: Date.now(),
            errorMessage: errorMessage || null,
          }
        : previous,
    );
    void mutate();
  };

  const persistConversationUpdate = async (
    conversationId: string,
    updates: Partial<Conversation>,
    messagesToSave?: Message[],
  ) => {
    if (!backendToken) {
      return;
    }
    const requests: Promise<void>[] = [];
    if (Object.keys(updates).length > 0) {
      requests.push(apiUpdateConversation(conversationId, updates, { backendToken }));
    }
    if (messagesToSave && messagesToSave.length > 0) {
      requests.push(apiSaveMessages(tagMessages(conversationId, messagesToSave), { backendToken }));
    }
    await Promise.all(requests);
  };

  const createConversationIfNeeded = async (forceNew = false): Promise<Conversation | null> => {
    const existingConversation = conversationsRef.current.find((conversation) => conversation.id === activeIdRef.current) || null;
    if (existingConversation && !forceNew) {
      return existingConversation;
    }
    if (!backendToken || !viewingAgentId) {
      return null;
    }

    if (createConversationPromiseRef.current) {
      return createConversationPromiseRef.current;
    }

    const laneForConversation: ChatLane =
      canUseAutomationLane && chatLane === "automation" ? "automation" : "user";

    updateStreamState(existingConversation?.id || `draft:${laneForConversation}:${viewingAgentId}`, {
      conversationId: existingConversation?.id || "",
      messageId: "",
      phase: "creating_conversation",
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      firstTokenAt: null,
      latestInputTimestamp: Date.now(),
      errorMessage: null,
    });
    setCreateInFlight(true);
    const promise = apiCreateConversation(
      { agentId: viewingAgentId, lane: laneForConversation, employeeId: targetLoadId || undefined },
      { backendToken },
    )
      .then(async (conversation) => {
        const normalizedConversation = normalizeConversationRecord(conversation);
        pendingConversationIdsRef.current.add(conversation.id);
        await applyConversations([normalizedConversation, ...conversationsRef.current]);
        setActiveId(conversation.id);
        updateStreamState(normalizedConversation.id, (previous) =>
          previous
            ? {
                ...previous,
                conversationId: normalizedConversation.id,
                phase: "completed",
                lastActivityAt: Date.now(),
              }
            : null,
        );
        return normalizedConversation;
      })
      .finally(() => {
        createConversationPromiseRef.current = null;
        setCreateInFlight(false);
      });

    createConversationPromiseRef.current = promise;
    return promise;
  };

  const retryPersistAssistantMessage = async (
    conversationId: string,
    assistantMessage: Message,
    updates: Partial<Conversation>,
    attempt = 0,
  ): Promise<void> => {
    try {
      await persistConversationUpdate(conversationId, updates, [assistantMessage]);
      clearPendingMessage(conversationId, assistantMessage.id);
      cleanupStreaming(conversationId, assistantMessage.id, "completed");
      setTransientError(null);
    } catch (error) {
      if (attempt >= 2) {
        updateStreamState(conversationId, (previous) =>
          previous
            ? {
                ...previous,
                phase: "backend_sync_error",
                errorMessage: error instanceof Error ? error.message : "Backend sync failed",
                finalContent: assistantMessage.content,
                lastActivityAt: Date.now(),
              }
            : previous,
        );
        setTransientError("Da co phan hoi nhung luu backend loi. Dang doi dong bo lai.");
        return;
      }

      setTimeout(() => {
        void retryPersistAssistantMessage(conversationId, assistantMessage, updates, attempt + 1);
      }, 1500 * (attempt + 1));
    }
  };

  const commitAssistantMessage = async (
    conversationId: string,
    messageId: string,
    finalContent: string,
    latestInputTimestamp: number,
  ) => {
    const currentConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId) || null;
    if (!currentConversation) {
      cleanupStreaming(conversationId, messageId, "completed");
      return;
    }

    if (!String(finalContent || "").trim()) {
      if (hasFreshApprovalCheckpoint(currentConversation, latestInputTimestamp, finalContent)) {
        cleanupStreaming(conversationId, messageId, "completed");
      } else {
        cleanupStreaming(conversationId, messageId, "completed");
      }
      return;
    }

    if (hasFreshApprovalCheckpoint(currentConversation, latestInputTimestamp, finalContent)) {
      cleanupStreaming(conversationId, messageId, "completed");
      return;
    }

    const normalizedConversation = normalizeConversationRecord(currentConversation);
    const nextStatus =
      normalizedConversation.lane === "automation"
        ? normalizeAutomationStatus(finalContent)
        : normalizedConversation.status;
    const updatedAt = Date.now();
    const assistantMessage: Message = {
      id: messageId,
      role: "assistant",
      type: "regular",
      content: finalContent,
      timestamp: updatedAt,
      conversationId,
    };

    markPendingMessage(conversationId, assistantMessage.id);
    updateStreamState(conversationId, (previous) =>
      previous
        ? {
            ...previous,
            phase: "saving_assistant_message",
            finalContent,
            lastActivityAt: Date.now(),
          }
        : previous,
    );

    await applyConversations(
      conversationsRef.current.map((conversation) => {
        if (conversation.id !== conversationId) {
          return conversation;
        }
        const existingIndex = conversation.messages.findIndex((message) => message.id === messageId);
        const nextMessages =
          existingIndex >= 0
            ? conversation.messages.map((message) => (message.id === messageId ? assistantMessage : message))
            : [...conversation.messages, assistantMessage];
        return {
          ...conversation,
          messages: nextMessages,
          status: nextStatus,
          updatedAt,
        };
      }),
    );

    await retryPersistAssistantMessage(
      conversationId,
      assistantMessage,
      nextStatus !== normalizedConversation.status ? { status: nextStatus, updatedAt } : { updatedAt },
    );
  };

  const handleNewConversation = async () => {
    if (!viewingAgentId || !backendToken) {
      return;
    }

    const laneForConversation: ChatLane =
      canUseAutomationLane && chatLane === "automation" ? "automation" : "user";
    const activeConversation = conversationsRef.current.find((conversation) => conversation.id === activeIdRef.current) || null;
    if (shouldReuseDraftConversation(activeConversation, laneForConversation, viewingAgentId)) {
      setActiveId(activeConversation?.id || null);
      return;
    }

    try {
      await createConversationIfNeeded(true);
    } catch {
      toast.error("Khong the tao cuoc tro chuyen moi.");
      setTransientError("Khong the tao cuoc tro chuyen moi.");
    }
  };

  const handleSelectConversation = (conversationId: string) => {
    setActiveId(conversationId);
  };

  const handleDeleteConversation = async (conversationId: string) => {
    const previousConversations = conversationsRef.current;
    const previousActiveId = activeIdRef.current;
    const nextConversations = previousConversations.filter((conversation) => conversation.id !== conversationId);

    await applyConversations(nextConversations);
    if (previousActiveId === conversationId) {
      setActiveId(nextConversations[0]?.id || null);
    }

    if (!backendToken) {
      return;
    }

    try {
      await apiDeleteConversation(conversationId, { backendToken });
    } catch {
      await applyConversations(previousConversations);
      setActiveId(previousActiveId);
      toast.error("Khong the xoa cuoc tro chuyen.");
      setTransientError("Khong the xoa cuoc tro chuyen.");
    }
  };

  const handleSendMessage = async (content: string, options?: SendMessageType) => {
    if (!token || !viewingAgentId) {
      return;
    }

    setTransientError(null);
    const snapshotBeforeSend = conversationsRef.current;
    const previousActiveId = activeIdRef.current;
    const laneForConversation: ChatLane =
      canUseAutomationLane && chatLane === "automation" ? "automation" : "user";

    try {
      let conversation = snapshotBeforeSend.find((item) => item.id === activeIdRef.current) || null;
      if (!conversation) {
        conversation = await createConversationIfNeeded();
        if (!conversation) {
          toast.error("Khong the tao cuoc tro chuyen.");
          return;
        }
      }

      if (!conversation.id || !conversation.agentId || !conversation.sessionKey) {
        setTransientError("Cuoc tro chuyen hien tai thieu agentId hoac sessionKey.");
        toast.error("Khong the ket noi toi agent cho cuoc tro chuyen nay.");
        return;
      }

      const userMessage = createMessage(
        options?.type === "manager_note" ? "manager" : "user",
        content,
        options?.type,
      );
      const requestedCancellation =
        laneForConversation === "automation" && detectAutomationCancellationIntent(content);
      const latestInputTimestamp = userMessage.timestamp;
      markPendingMessage(conversation.id, userMessage.id);

      updateStreamState(conversation.id, {
        conversationId: conversation.id,
        messageId: "",
        phase: "saving_user_message",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        firstTokenAt: null,
        latestInputTimestamp,
        errorMessage: null,
      });

      const nextTitle =
        conversation.messages.length === 0 ? generateConversationTitle([...conversation.messages, userMessage]) : conversation.title;
      const updatedAt = Date.now();
      const nextStatus =
        requestedCancellation ? "cancelled" : normalizeConversationRecord(conversation).lane === "automation" ? "active" : conversation.status;

      const optimisticConversation: Conversation = {
        ...conversation,
        title: nextTitle,
        status: nextStatus,
        updatedAt,
        messages: [...conversation.messages, { ...userMessage, conversationId: conversation.id }],
      };

      await applyConversations(
        conversationsRef.current.map((item) => (item.id === conversation.id ? optimisticConversation : item)),
      );
      setActiveId(conversation.id);

      try {
        if (backendToken) {
          await persistConversationUpdate(
            conversation.id,
            {
              title: nextTitle,
              status: nextStatus,
              updatedAt,
            },
            [userMessage],
          );
        }
      } catch {
        clearPendingMessage(conversation.id, userMessage.id);
        await applyConversations(snapshotBeforeSend);
        setActiveId(previousActiveId);
        updateStreamState(conversation.id, (previous) =>
          previous ? { ...previous, phase: "transport_error", errorMessage: "User message save failed" } : previous,
        );
        toast.error("Khong the luu yeu cau cua ban.");
        setTransientError("Khong the luu yeu cau cua ban.");
        return;
      }

      const assistantMessageId = `msg_${Date.now()}_ai`;
      const streamRequestId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      const controller = new AbortController();
      streamingMapRef.current.set(conversation.id, { messageId: assistantMessageId, controller, requestId: streamRequestId });
      markPendingMessage(conversation.id, assistantMessageId);
      pendingConversationIdsRef.current.add(conversation.id);
      setStreamContent(assistantMessageId, "");
      updateStreamState(conversation.id, {
        conversationId: conversation.id,
        messageId: assistantMessageId,
        streamRequestId,
        phase: "connecting",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        firstTokenAt: null,
        latestInputTimestamp,
        errorMessage: null,
      });

      await applyConversations(
        conversationsRef.current.map((item) => {
          if (item.id !== conversation.id) {
            return item;
          }
          return {
            ...item,
            messages: [
              ...item.messages,
              {
                id: assistantMessageId,
                role: "assistant",
                type: "regular",
                content: "",
                timestamp: Date.now(),
                conversationId: conversation.id,
              },
            ],
          };
        }),
      );

      let finalContent = "";
      updateStreamState(conversation.id, (previous) =>
        previous
          ? {
              ...previous,
              phase: "waiting_first_token",
              messageId: assistantMessageId,
            }
          : previous,
      );

      try {
        if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
          console.debug("[useConversations] sending conversation to gateway", {
            lane: laneForConversation,
            activeConversationId: conversation.id,
            activeConversationAgentId: conversation.agentId,
            activeConversationSessionKey: conversation.sessionKey,
            selectedAgentId: viewingAgentId,
            model: `openclaw/${conversation.agentId}`,
            requestAgentId: conversation.agentId,
            requestSessionKey: conversation.sessionKey,
          });
        }

        await streamChatCompletion({
          token,
          agentId: conversation.agentId,
          sessionKey: conversation.sessionKey,
          messages: optimisticConversation.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          signal: controller.signal,
          onDelta: (text) => {
            if (shouldIgnoreLateStreamChunk(streamRequestId, getActiveStreamRequestId(conversation.id))) {
              return;
            }
            finalContent += text;
            setStreamContent(assistantMessageId, finalContent);
            updateStreamState(conversation.id, (previous) =>
              previous
                ? {
                    ...previous,
                    phase: "streaming",
                    firstTokenAt: previous.firstTokenAt || Date.now(),
                    lastActivityAt: Date.now(),
                  }
                : previous,
            );
          },
          onDone: () => {
            if (shouldIgnoreLateStreamChunk(streamRequestId, getActiveStreamRequestId(conversation.id))) {
              return;
            }
            void commitAssistantMessage(conversation.id, assistantMessageId, finalContent, latestInputTimestamp);
          },
          onError: (error) => {
            if (shouldIgnoreLateStreamChunk(streamRequestId, getActiveStreamRequestId(conversation.id))) {
              return;
            }
            const currentConversation = conversationsRef.current.find((item) => item.id === conversation.id) || null;
            const backendCheckpoint = findPersistedCheckpointMessage(
              currentConversation,
              latestInputTimestamp,
              finalContent,
            );
            if (backendCheckpoint) {
              void finalizeActiveStreamFromBackendCheckpoint(conversation.id, backendCheckpoint);
              return;
            }
            if (hasFreshApprovalCheckpoint(currentConversation, latestInputTimestamp, finalContent)) {
              cleanupStreaming(conversation.id, assistantMessageId, "completed");
              return;
            }
            if (laneForConversation === "automation") {
              waitForBackendCheckpointAfterTransportDrop(
                conversation.id,
                assistantMessageId,
                finalContent,
                error.message,
              );
              return;
            }
            cleanupStreaming(conversation.id, assistantMessageId, "transport_error", error.message);
            toast.error("Ket noi toi agent bi gian doan.");
            setTransientError("Ket noi bi gian doan, dang doi du lieu dong bo tu backend...");
          },
        });
      } catch (error) {
        if (shouldIgnoreLateStreamChunk(streamRequestId, getActiveStreamRequestId(conversation.id))) {
          return;
        }
        if (laneForConversation === "automation") {
          waitForBackendCheckpointAfterTransportDrop(
            conversation.id,
            assistantMessageId,
            finalContent,
            error instanceof Error ? error.message : "Stream failed",
          );
          return;
        }
        cleanupStreaming(conversation.id, assistantMessageId, "transport_error", error instanceof Error ? error.message : "Stream failed");
        toast.error("Khong the bat dau streaming.");
        setTransientError("Khong the bat dau streaming.");
      }
    } catch (error) {
      const message = getRequestErrorMessage(error, "Khong the gui yeu cau luc nay.");
      toast.error(message);
      setTransientError(message);
    }
  };

  const handleStopStreaming = async () => {
    const conversationId = activeIdRef.current;
    if (!conversationId) {
      return;
    }
    const activeStream = streamingMapRef.current.get(conversationId);
    const streamMessageId = activeStream?.messageId || streamStates[conversationId]?.messageId || "";
    if (!streamMessageId) {
      return;
    }
    activeStream?.controller.abort();
    await applyConversations(
      conversationsRef.current.map((conversation) => ({
        ...conversation,
        messages: conversation.id === conversationId
          ? conversation.messages.filter((message) => message.id !== streamMessageId)
          : conversation.messages,
      })),
    );
    cleanupStreaming(conversationId, streamMessageId, "aborted");
  };

  const activeConversation =
    conversations.find((conversation) => {
      if (conversation.id !== activeId) {
        return false;
      }
      const normalizedConversation = normalizeConversationRecord(conversation);
      return normalizedConversation.lane === chatLane;
    }) || null;
  const activeStreamState = activeConversation ? streamStates[activeConversation.id] || null : null;
  const activeWorkflowId = activeConversation?.workflowId || extractAutomationWorkflowId(activeConversation || { id: "", sessionKey: "", workflowId: undefined }) || null;
  const activeWorkflowProgress = activeWorkflowId ? workflowProgressById[activeWorkflowId] || null : null;
  const activeStatusLabel = getStreamPhaseLabel({
    state: activeStreamState,
    workflowProgressLabel: formatWorkflowProgressLabel(activeWorkflowProgress),
  });
  const isStreaming = Boolean(activeStreamState && !isTerminalStreamPhase(activeStreamState.phase));
  const streamingMessageId = activeStreamState?.messageId || null;

  return {
    conversations,
    filteredConversations,
    workflowGroups,
    activeConversation,
    activeId,
    isStreaming,
    streamingMessageId,
    streamingStore: streamingStoreRef.current,
    refreshConversations: async () => mutate(),
    setActiveId,
    handleNewConversation,
    handleSelectConversation,
    handleDeleteConversation,
    handleSendMessage,
    handleStopStreaming,
    activeStreamState,
    activeStatusLabel,
    activeWorkflowProgress,
    createInFlight,
    transientError,
    clearTransientError: () => setTransientError(null),
    sseStatus,
    canUseAutomationLane: canUseAutomationLane || canAccessAutomationLane(employeeId, accessPolicy),
  };
}
