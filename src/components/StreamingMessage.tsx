"use client";

import { memo, useEffect, useSyncExternalStore } from "react";
import MessageBubble from "./MessageBubble";
import { StreamingStore } from "@/hooks/useConversations";

interface StreamingMessageProps {
  messageId: string;
  timestamp: number;
  streamingStore: StreamingStore;
  onContentChange?: () => void;
}

function StreamingMessage({
  messageId,
  timestamp,
  streamingStore,
  onContentChange,
}: StreamingMessageProps) {
  const content = useSyncExternalStore(
    (listener) => streamingStore.subscribe(messageId, listener),
    () => streamingStore.getSnapshot(messageId),
    () => "",
  );

  useEffect(() => {
    onContentChange?.();
  }, [content, onContentChange]);

  return (
    <MessageBubble
      role="assistant"
      content={content}
      timestamp={timestamp}
      isStreaming
      isStreamingMessage
    />
  );
}

export default memo(StreamingMessage);
