"use client";

import { useEffect, useRef, useState } from "react";
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
  const shouldFetch = Boolean(targetLoadId && backendToken);
  const refreshInterval = enablePolling && streamingConvIds.size === 0 ? 10000 : 0;

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

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    const laneConversations = conversations.filter(
      (conversation) => conversation.agentId === viewingAgentId && (conversation.lane || "user") === chatLane,
    );

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
  }, [chatLane, conversations, viewingAgentId]);

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
      toast.error("Không thể đồng bộ trạng thái hội thoại.");
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
      toast.error("Không thể lưu phản hồi của AI. Vui lòng tải lại hội thoại.");
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
    );
    nextConversation.employeeId = targetLoadId || undefined;

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
      toast.error("Lỗi kết nối, không thể tạo hội thoại mới.");
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
      const remaining = nextConversations.filter(
        (conversation) => conversation.agentId === viewingAgentId && (conversation.lane || "user") === chatLane,
      );
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
      toast.error("Lỗi kết nối, không thể xóa hội thoại.");
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
      );
      conversation.employeeId = targetLoadId || undefined;
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
        if (!conversationExists) {
          await apiCreateConversation({ ...conversation, messages: [] }, { backendToken });
        }

        await persistConversationUpdate(conversationId, { title: nextTitle, status: nextStatus, updatedAt }, [newMessage]);
      }
    } catch {
      await applyConversations(snapshotBeforeSend);
      setActiveId(previousActiveId);
      toast.error("Lỗi kết nối, không thể gửi tin nhắn.");
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
        messages: updatedMessages.map((message) => ({
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
          toast.error("Kết nối tới AI bị gián đoạn. Vui lòng thử lại.");
          void commitAssistantMessage(conversationId, aiMessageId, errorContent, "pending_approval");
        },
      });
    } catch {
      cleanupStreaming(conversationId, aiMessageId);
      toast.error("Không thể bắt đầu phiên streaming.");
    }
  };

  const handleStopStreaming = async () => {
    if (!activeIdRef.current) {
      return;
    }

    await abortStreamingConversation(activeIdRef.current, "stopped");
  };

  const filteredConversations = conversations.filter(
    (conversation) => conversation.agentId === viewingAgentId && (conversation.lane || "user") === chatLane,
  );
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
