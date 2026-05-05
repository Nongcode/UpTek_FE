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
  createConversation,
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

type SessionBoxConversation = Conversation & {
  memberConversationIds: string[];
};

function sortMessages(messages: Message[]): Message[] {
  return [...messages].sort((left, right) => {
    if (left.timestamp !== right.timestamp) {
      return left.timestamp - right.timestamp;
    }
    return left.id.localeCompare(right.id);
  });
}

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

function resolveSessionBoxTitle(
  group: Conversation[],
  mergedMessages: Message[],
  representative: Conversation,
  latestConversation: Conversation,
): string {
  const preferredConversationTitle = group.find(
    (conversation) => !isTechnicalAutomationTitle(conversation.title),
  )?.title;
  if (preferredConversationTitle) {
    return preferredConversationTitle;
  }

  const firstHumanMessage = mergedMessages.find(
    (message) => message.role === "user" || message.role === "manager",
  );
  if (firstHumanMessage) {
    return generateConversationTitle([firstHumanMessage]);
  }

  return representative.title || latestConversation.title || "Luá»“ng tá»± Ä‘á»™ng";
}

function buildSessionBoxConversations(
  conversations: Conversation[],
  viewingAgentId: string,
): SessionBoxConversation[] {
  const grouped = new Map<string, Conversation[]>();
  const singles: SessionBoxConversation[] = [];

  for (const conversation of conversations) {
    const workflowId = extractAutomationWorkflowId(conversation);
    if (!workflowId) {
      singles.push({
        ...conversation,
        memberConversationIds: [conversation.id],
      });
      continue;
    }

    const existingGroup = grouped.get(workflowId) || [];
    existingGroup.push(conversation);
    grouped.set(workflowId, existingGroup);
  }

  const sessionBoxes = [...grouped.values()].map((group) => {
    const representative =
      group.find(
        (conversation) =>
          conversation.agentId === viewingAgentId || conversation.employeeId === viewingAgentId,
      ) || group.reduce((latest, conversation) =>
        conversation.updatedAt > latest.updatedAt ? conversation : latest,
      );

    const dedupedMessages = new Map<string, Message>();
    for (const conversation of group) {
      for (const message of conversation.messages) {
        const existing = dedupedMessages.get(message.id);
        if (!existing || existing.timestamp <= message.timestamp) {
          dedupedMessages.set(message.id, {
            ...message,
            conversationId: representative.id,
          });
        }
      }
    }

    const mergedMessages = sortMessages([...dedupedMessages.values()]);
    const updatedAt = Math.max(...group.map((conversation) => conversation.updatedAt));
    const createdAt = Math.min(...group.map((conversation) => conversation.createdAt));
    const latestConversation = group.reduce((latest, conversation) =>
      conversation.updatedAt > latest.updatedAt ? conversation : latest,
    );
    const title = resolveSessionBoxTitle(group, mergedMessages, representative, latestConversation);

    return {
      ...representative,
      title,
      messages: mergedMessages,
      status: latestConversation.status || representative.status,
      updatedAt,
      createdAt,
      memberConversationIds: group.map((conversation) => conversation.id),
    };
  });

  return [...sessionBoxes, ...singles].sort((left, right) => right.updatedAt - left.updatedAt);
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

  const isViewingSubordinate = viewingAgentId !== "" && viewingAgentId !== employeeId;
  const targetLoadId = isViewingSubordinate ? viewingAgentId : employeeId;
  const managerInstanceId = accessPolicy?.managerInstanceId;
  const shouldFetch = Boolean(targetLoadId && backendToken);
  const refreshInterval = enablePolling && streamingConvIds.size === 0 ? 10000 : 0;

  const matchesLaneConversation = (conversation: Conversation) => {
    if ((conversation.lane || "user") !== chatLane) {
      return false;
    }

    if (chatLane === "automation") {
      return true;
    }

    return conversation.agentId === viewingAgentId;
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
    ? `conversations:${targetLoadId}:${managerInstanceId || "default"}:${canUseAutomationLane ? "all" : "user"}`
    : null;

  const { data: conversations = [], mutate } = useSWR<Conversation[]>(
    swrKey,
    async () => {
      const loaded = await loadConversations(
        targetLoadId as string,
        { includeAutomation: canUseAutomationLane, managerInstanceId },
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

  const filteredSourceConversations = useMemo(
    () => conversations.filter(matchesLaneConversation),
    [chatLane, conversations, viewingAgentId],
  );

  const filteredConversations = useMemo(() => {
    if (chatLane !== "automation") {
      return filteredSourceConversations.map((conversation) => ({
        ...conversation,
        memberConversationIds: [conversation.id],
      })) as SessionBoxConversation[];
    }

    return buildSessionBoxConversations(filteredSourceConversations, viewingAgentId);
  }, [chatLane, filteredSourceConversations, viewingAgentId]);

  const conversationMemberIds = useMemo(
    () =>
      new Map(
        filteredConversations.map((conversation) => [
          conversation.id,
          conversation.memberConversationIds,
        ]),
      ),
    [filteredConversations],
  );

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
    if (!viewingAgentId) {
      return;
    }

    const previousConversations = conversationsRef.current;
    const previousActiveId = activeIdRef.current;
    const laneForNewConversation: ChatLane =
      canUseAutomationLane && chatLane === "automation" ? "automation" : "user";

    const nextConversation = createConversation(
      viewingAgentId,
      undefined,
      laneForNewConversation,
      targetLoadId || undefined,
      managerInstanceId,
    );
    nextConversation.employeeId = targetLoadId || undefined;
    nextConversation.managerInstanceId = managerInstanceId || nextConversation.managerInstanceId;

    await applyConversations([nextConversation, ...previousConversations]);
    setActiveId(nextConversation.id);

    if (!backendToken) {
      return;
    }

    try {
      await apiCreateConversation(nextConversation, { backendToken });
    } catch {
      await applyConversations(previousConversations);
      setActiveId(previousActiveId);
      toast.error("LÃ¡Â»â€”i kÃ¡ÂºÂ¿t nÃ¡Â»â€˜i, khÃƒÂ´ng thÃ¡Â»Æ’ tÃ¡ÂºÂ¡o hÃ¡Â»â„¢i thoÃ¡ÂºÂ¡i mÃ¡Â»â€ºi.");
    }
  };

  const handleSelectConversation = (conversationId: string) => {
    setActiveId(conversationId);
  };

  const handleDeleteConversation = async (conversationId: string) => {
    const previousConversations = conversationsRef.current;
    const previousActiveId = activeIdRef.current;
    const memberIds = conversationMemberIds.get(conversationId) || [conversationId];
    const nextConversations = previousConversations.filter(
      (conversation) => !memberIds.includes(conversation.id),
    );

    await applyConversations(nextConversations);

    if (previousActiveId === conversationId) {
      const remaining = nextConversations.filter(
        matchesLaneConversation,
      );
      setActiveId(remaining[0]?.id || null);
    }

    if (!backendToken) {
      return;
    }

    try {
      await Promise.all(memberIds.map((memberId) => apiDeleteConversation(memberId, { backendToken })));
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
      conversation = createConversation(
        viewingAgentId,
        undefined,
        laneForConversation,
        targetLoadId || undefined,
        managerInstanceId,
      );
      conversation.employeeId = targetLoadId || undefined;
      conversation.managerInstanceId = managerInstanceId || conversation.managerInstanceId;
    }

    const conversationId = conversation.id;
    const conversationManagerInstanceId = conversation.managerInstanceId || managerInstanceId;
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
    const scopedMessages = updatedMessages.map((message) => ({
      ...message,
      managerInstanceId: message.managerInstanceId || conversationManagerInstanceId,
    }));
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
      messages: scopedMessages,
      managerInstanceId: conversationManagerInstanceId,
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
        if (!conversationExists) {
          await apiCreateConversation({ ...conversation, messages: [] }, { backendToken });
        }

        await persistConversationUpdate(
          conversationId,
          { title: nextTitle, status: nextStatus, updatedAt, managerInstanceId: conversationManagerInstanceId },
          [{ ...newMessage, managerInstanceId: conversationManagerInstanceId }],
        );
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

    try {
      await streamChatCompletion({
        token,
        agentId: conversation.agentId,
        sessionKey: conversation.sessionKey,
        messages: scopedMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        signal: controller.signal,
        onDelta: (text) => {
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

