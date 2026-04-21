"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import toast from "react-hot-toast";
import {
  Conversation,
  Message,
  AccessPolicy,
} from "@/lib/types";
import {
  loadConversations,
  createMessage,
  generateConversationTitle,
  apiCreateConversation,
  apiDeleteConversation,
  apiSaveMessages,
  apiUpdateConversation,
} from "@/lib/storage";
import { streamChatCompletion } from "@/lib/api";
import {
  ChatLane,
  detectAutomationCancellationIntent,
  extractAutomationWorkflowId,
  hydrateConversationLane,
  normalizeAutomationStatus,
} from "@/utils/chatLogic";
import { useSSE } from "@/hooks/useSSE";

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

function isTechnicalAutomationTitle(title: string | undefined): boolean {
  const normalized = String(title || "").trim();
  return (
    normalized.length === 0
    || normalized.startsWith("[AUTO]")
    || normalized.includes("wf_test_")
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
      const preferredConversationTitle = group.find(
        (conversation) => !isTechnicalAutomationTitle(conversation.title),
      )?.title;
      const title =
        rootConversation?.title
        || preferredConversationTitle
        || latestConversation.title
        || "Luá»“ng tá»± Ä‘á»™ng";

      return {
        workflowId,
        title,
        updatedAt: latestConversation.updatedAt,
        rootConversationId: rootConversation?.id || null,
        memberConversationIds: group.map((conversation) => conversation.id),
        memberConversations: group,
      };
    })
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function isConversationCancellation(
  conversation: Conversation | undefined,
  content: string,
): boolean {
  return (conversation?.lane || "user") === "automation" && detectAutomationCancellationIntent(content);
}

function tagMessages(conversationId: string, messages: Message[]): Message[] {
  return messages.map((message) => ({
    ...message,
    conversationId,
  }));
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
  const [streamingConvIds, setStreamingConvIds] = useState<Set<string>>(new Set());

  const conversationsRef = useRef<Conversation[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const streamingMapRef = useRef<Map<string, { messageId: string; controller: AbortController }>>(new Map());
  const streamContentRef = useRef<Map<string, string>>(new Map());
  const streamListenersRef = useRef<Map<string, Set<() => void>>>(new Map());
  const streamingStoreRef = useRef<StreamingStore | null>(null);
  const progressTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>[]>>(new Map());
  const pendingRefreshRef = useRef(false);

  const isViewingSubordinate = viewingAgentId !== "" && viewingAgentId !== employeeId;
  const targetLoadId = isViewingSubordinate ? viewingAgentId : employeeId;
  const shouldFetch = Boolean(targetLoadId && backendToken);

  const mutateRef = useRef<(() => void) | null>(null);

  useSSE({
    backendToken,
    enabled: enablePolling,
    onEvent: (eventName, _data) => {
      const shouldRefreshDuringStreaming =
        chatLane === "automation"
        && (eventName === "workflow.updated" || eventName === "message.created" || eventName === "conversation.created");

      if (streamingMapRef.current.size === 0 || shouldRefreshDuringStreaming) {
        pendingRefreshRef.current = false;
        mutateRef.current?.();
        return;
      }

      pendingRefreshRef.current = true;
    },
  });

  const refreshInterval = enablePolling
    ? (chatLane === "automation" ? 10000 : (streamingConvIds.size === 0 ? 30000 : 0))
    : 0;

  useEffect(() => {
    if (streamingConvIds.size !== 0 || !pendingRefreshRef.current) {
      return;
    }

    pendingRefreshRef.current = false;
    mutateRef.current?.();
  }, [streamingConvIds.size]);

  const matchesLaneConversation = (conversation: Conversation) => {
    if ((conversation.lane || "user") !== chatLane) {
      return false;
    }

    if (chatLane === "user") {
      return conversation.agentId === viewingAgentId;
    }

    const role = resolveConversationRole(conversation);
    const isOwnAutomationScope = viewingAgentId === employeeId;

    if (isOwnAutomationScope) {
      return conversation.agentId === viewingAgentId && role === "root";
    }

    return conversation.agentId === viewingAgentId && role === "sub_agent";
  };

  const matchesWorkflowGroupConversation = (conversation: Conversation) => {
    if ((conversation.lane || "user") !== "automation") {
      return false;
    }

    if (viewingAgentId === employeeId) {
      return conversation.employeeId === employeeId;
    }

    return conversation.agentId === viewingAgentId || conversation.employeeId === viewingAgentId;
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

  const swrKey = shouldFetch
    ? `conversations:${targetLoadId}:${canUseAutomationLane ? "all" : "user"}`
    : null;

  const { data: conversations = [], mutate } = useSWR<Conversation[]>(
    swrKey,
    async () => {
      const loaded = await loadConversations(
        targetLoadId as string,
        { includeAutomation: canUseAutomationLane },
        { backendToken: backendToken as string },
      );
      return loaded.map(hydrateConversationLane);
    },
    {
      fallbackData: [],
      keepPreviousData: true,
      refreshInterval,
      revalidateOnFocus: enablePolling,
      revalidateOnReconnect: true,
      dedupingInterval: 5000,
    },
  );

  mutateRef.current = () => { void mutate(); };

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

    const automationConversations = conversations.filter(matchesWorkflowGroupConversation);
    return buildWorkflowConversationGroups(automationConversations, viewingAgentId);
  }, [chatLane, conversations, employeeId, viewingAgentId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const laneConversations = filteredConversations;

    if (laneConversations.length === 0) {
      if (activeIdRef.current !== null) {
        setActiveId(null);
      }
      return;
    }

    if (activeIdRef.current && laneConversations.some((conversation) => conversation.id === activeIdRef.current)) {
      return;
    }

    setActiveId(laneConversations[0].id);
  }, [filteredConversations]);

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

  const applyConversations = async (nextConversations: Conversation[]) => {
    conversationsRef.current = nextConversations;
    await mutate(nextConversations, false);
  };

  const refreshConversations = async () => {
    return mutate();
  };

  const cleanupStreaming = (conversationId: string, messageId: string) => {
    const timers = progressTimersRef.current.get(messageId);
    if (timers) {
      timers.forEach(clearTimeout);
      progressTimersRef.current.delete(messageId);
    }
    streamingMapRef.current.delete(conversationId);
    clearStreamContent(messageId);
    setStreamingConvIds((previous) => {
      const next = new Set(previous);
      next.delete(conversationId);
      return next;
    });
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

  const abortStreamingConversation = async (
    conversationId: string,
    status?: Conversation["status"],
  ) => {
    const activeStream = streamingMapRef.current.get(conversationId);
    if (!activeStream) {
      return;
    }

    activeStream.controller.abort();

    const updatedAt = Date.now();
    const nextConversations = conversationsRef.current.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }

      return {
        ...conversation,
        messages: conversation.messages.filter((message) => message.id !== activeStream.messageId),
        ...(status ? { status, updatedAt } : {}),
      };
    });

    cleanupStreaming(conversationId, activeStream.messageId);
    await applyConversations(nextConversations);

    if (!status || !backendToken) {
      return;
    }

    try {
      await apiUpdateConversation(conversationId, { status, updatedAt }, { backendToken });
    } catch {
      toast.error("KhÃƒÂ´ng thÃ¡Â»Æ’ Ã„â€˜Ã¡Â»â€œng bÃ¡Â»â„¢ trÃ¡ÂºÂ¡ng thÃƒÂ¡i hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i.");
    }
  };

  const commitAssistantMessage = async (
    conversationId: string,
    messageId: string,
    finalContent: string,
    errorFallbackStatus?: Conversation["status"],
  ) => {
    const currentConversation = conversationsRef.current.find((conversation) => conversation.id === conversationId);
    if (!currentConversation) {
      cleanupStreaming(conversationId, messageId);
      return;
    }

    let nextStatus = currentConversation.status;
    if ((currentConversation.lane || "user") === "automation") {
      if (currentConversation.status === "cancelled" || currentConversation.status === "stopped") {
        nextStatus = currentConversation.status;
      } else if (errorFallbackStatus) {
        nextStatus = errorFallbackStatus;
      } else {
        nextStatus = normalizeAutomationStatus(finalContent);
      }
    }

    const updatedAt = Date.now();
    const nextConversations = conversationsRef.current.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }

      const hasPlaceholder = conversation.messages.some((message) => message.id === messageId);
      const nextMessages = hasPlaceholder
        ? conversation.messages.map((message) =>
          message.id === messageId ? { ...message, content: finalContent } : message,
        )
        : [
          ...conversation.messages,
          {
            id: messageId,
            role: "assistant" as const,
            content: finalContent,
            timestamp: updatedAt,
            conversationId,
          },
        ];

      return {
        ...conversation,
        messages: nextMessages,
        status: nextStatus,
        updatedAt,
      };
    });

    await applyConversations(nextConversations);
    cleanupStreaming(conversationId, messageId);

    try {
      await persistConversationUpdate(
        conversationId,
        nextStatus !== currentConversation.status ? { status: nextStatus, updatedAt } : {},
        [
          {
            id: messageId,
            role: "assistant",
            content: finalContent,
            timestamp: updatedAt,
          },
        ],
      );
    } catch {
      toast.error("KhÃƒÂ´ng thÃ¡Â»Æ’ lÃ†Â°u phÃ¡ÂºÂ£n hÃ¡Â»â€œi cÃ¡Â»Â§a AI. Vui lÃƒÂ²ng tÃ¡ÂºÂ£i lÃ¡ÂºÂ¡i hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i.");
    }
  };

  const handleNewConversation = async () => {
    if (!viewingAgentId || !backendToken) {
      return;
    }

    const laneForNewConversation: ChatLane =
      canUseAutomationLane && chatLane === "automation" ? "automation" : "user";

    try {
      const newConv = await apiCreateConversation(
        { agentId: viewingAgentId, lane: laneForNewConversation, employeeId: targetLoadId || undefined },
        { backendToken },
      );
      await applyConversations([newConv, ...conversationsRef.current]);
      setActiveId(newConv.id);
    } catch {
      toast.error("LÃ¡Â»â€”i kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i, khÃƒÂ´ng thÃ¡Â»Æ’ tÃ¡ÂºÂ¡o hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i mÃ¡Â»â€ºi.");
    }
  };

  const handleSelectConversation = (conversationId: string) => {
    setActiveId(conversationId);
  };

  const handleDeleteConversation = async (conversationId: string) => {
    const previousConversations = conversationsRef.current;
    const previousActiveId = activeIdRef.current;
    const nextConversations = previousConversations.filter(
      (conversation) => conversation.id !== conversationId,
    );

    await applyConversations(nextConversations);

    if (previousActiveId === conversationId) {
      const remaining = nextConversations.filter(matchesLaneConversation);
      setActiveId(remaining[0]?.id || null);
    }

    if (!backendToken) {
      return;
    }

    try {
      await apiDeleteConversation(conversationId, { backendToken });
    } catch {
      await applyConversations(previousConversations);
      setActiveId(previousActiveId);
      toast.error("LÃ¡Â»â€”i kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i, khÃƒÂ´ng thÃ¡Â»Æ’ xÃƒÂ³a hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i.");
    }
  };

  const handleSendMessage = async (content: string, options?: SendMessageType) => {
    if (!token || !viewingAgentId) {
      return;
    }

    const snapshotBeforeSend = conversationsRef.current;
    const previousActiveId = activeIdRef.current;

    let conversation = snapshotBeforeSend.find((item) => item.id === activeIdRef.current);
    const conversationExists = Boolean(conversation);
    const laneForConversation: ChatLane =
      canUseAutomationLane && chatLane === "automation" ? "automation" : "user";

    if (!conversation) {
      if (!backendToken) return;
      try {
        conversation = await apiCreateConversation(
          { agentId: viewingAgentId, lane: laneForConversation, employeeId: targetLoadId || undefined },
          { backendToken },
        );
      } catch {
        toast.error("Lá»—i káº¿t ná»‘i, khÃ´ng thá»ƒ táº¡o há»™i thoáº¡i má»›i.");
        return;
      }
    }

    const conversationId = conversation.id;
    const newMessage = createMessage(
      options?.type === "manager_note" ? "manager" : "user",
      content,
      options?.type,
    );

    const requestedCancellation = isConversationCancellation(conversation, content);
    if (requestedCancellation) {
      await abortStreamingConversation(conversationId);
    }

    const updatedMessages = [...conversation.messages, { ...newMessage, conversationId }];
    const nextTitle = conversation.messages.length === 0
      ? generateConversationTitle(updatedMessages)
      : conversation.title;
    const nextStatus = requestedCancellation
      ? "cancelled"
      : laneForConversation === "automation"
        ? "active"
        : conversation.status;
    const updatedAt = Date.now();

    const nextConversation: Conversation = {
      ...conversation,
      title: nextTitle,
      messages: updatedMessages,
      status: nextStatus,
      updatedAt,
    };

    const nextConversations = conversationExists
      ? conversationsRef.current.map((item) => (item.id === conversationId ? nextConversation : item))
      : [nextConversation, ...conversationsRef.current];

    await applyConversations(nextConversations);
    setActiveId(conversationId);

    try {
      if (backendToken) {
        await persistConversationUpdate(conversationId, { title: nextTitle, status: nextStatus, updatedAt }, [newMessage]);
      }
    } catch {
      await applyConversations(snapshotBeforeSend);
      setActiveId(previousActiveId);
      toast.error("LÃ¡Â»â€”i kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i, khÃƒÂ´ng thÃ¡Â»Æ’ gÃ¡Â»Â­i tin nhÃ¡ÂºÂ¯n.");
      return;
    }

    const aiMessageId = `msg_${Date.now()}_ai`;
    const controller = new AbortController();
    setStreamContent(aiMessageId, "");
    streamingMapRef.current.set(conversationId, { messageId: aiMessageId, controller });
    setStreamingConvIds((previous) => {
      const next = new Set(previous);
      next.add(conversationId);
      return next;
    });

    await applyConversations(
      conversationsRef.current.map((item) => {
        if (item.id !== conversationId) {
          return item;
        }

        return {
          ...item,
          messages: [
            ...item.messages,
            {
              id: aiMessageId,
              role: "assistant" as const,
              content: "",
              timestamp: Date.now(),
              conversationId,
            },
          ],
        };
      }),
    );

    let aiContent = "";

    const PROGRESS_STAGES = [
      { delay: 3000, text: "Dang xu ly..." },
      { delay: 30000, text: "Dang xu ly, tac vu co the mat vai phut..." },
      { delay: 120000, text: "Workflow dang chay (thuong mat 5-10 phut)..." },
    ];
    progressTimersRef.current.set(
      aiMessageId,
      PROGRESS_STAGES.map(({ delay, text }) =>
        setTimeout(() => {
          if (!aiContent) setStreamContent(aiMessageId, text);
        }, delay),
      ),
    );

    try {
      await streamChatCompletion({
        token,
        agentId: conversation.agentId,
        sessionKey: conversation.sessionKey,
        messages: updatedMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        signal: controller.signal,
        onDelta: (text) => {
          if (!aiContent) {
            const timers = progressTimersRef.current.get(aiMessageId);
            if (timers) {
              timers.forEach(clearTimeout);
              progressTimersRef.current.delete(aiMessageId);
            }
            setStreamContent(aiMessageId, "");
          }
          aiContent += text;
          setStreamContent(aiMessageId, aiContent);
        },
        onDone: () => {
          void commitAssistantMessage(conversationId, aiMessageId, aiContent);
        },
        onError: (error) => {
          const errorContent = aiContent
            ? `${aiContent}\n\n**[Loi: ${error.message}]**`
            : `**[Loi: ${error.message}]**`;
          toast.error("KÃ¡ÂºÂ¿t nÃ¡Â»â€˜i tÃ¡Â»â€ºi AI bÃ¡Â»â€¹ giÃƒÂ¡n Ã„â€˜oÃ¡ÂºÂ¡n. Vui lÃƒÂ²ng thÃ¡Â»Â­ lÃ¡ÂºÂ¡i.");
          void commitAssistantMessage(conversationId, aiMessageId, errorContent, "pending_approval");
        },
      });
    } catch {
      cleanupStreaming(conversationId, aiMessageId);
      toast.error("KhÃƒÂ´ng thÃ¡Â»Æ’ bÃ¡ÂºÂ¯t Ã„â€˜Ã¡ÂºÂ§u phiÃƒÂªn streaming.");
    }
  };

  const handleStopStreaming = async () => {
    if (!activeIdRef.current) {
      return;
    }

    await abortStreamingConversation(activeIdRef.current, "stopped");
  };

  const activeConversation = filteredConversations.find((conversation) => conversation.id === activeId) || null;
  const isStreaming = activeId ? streamingConvIds.has(activeId) : false;
  const streamingMessageId = activeId ? (streamingMapRef.current.get(activeId)?.messageId || null) : null;

  return {
    conversations,
    filteredConversations,
    workflowGroups,
    activeConversation,
    activeId,
    isStreaming,
    streamingMessageId,
    streamingStore: streamingStoreRef.current,
    refreshConversations,
    setActiveId,
    handleNewConversation,
    handleSelectConversation,
    handleDeleteConversation,
    handleSendMessage,
    handleStopStreaming,
  };
}
