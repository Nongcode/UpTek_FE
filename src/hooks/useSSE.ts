"use client";

import { useEffect, useRef, useState } from "react";

const API_BASE = "http://localhost:3001/api";

export type SSEEventName =
  | "workflow.created"
  | "workflow.updated"
  | "workflow.progress"
  | "conversation.created"
  | "conversation.updated"
  | "conversation.deleted"
  | "message.created";

export type SSEConnectionStatus = "connected" | "reconnecting" | "disconnected";

type SSEHandler = (data: unknown) => void;

interface UseSSEOptions {
  backendToken: string | null;
  enabled: boolean;
  onEvent: (eventName: SSEEventName, data: unknown) => void;
}

export function useSSE({ backendToken, enabled, onEvent }: UseSSEOptions): SSEConnectionStatus {
  const esRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  const [status, setStatus] = useState<SSEConnectionStatus>("disconnected");
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || !backendToken) {
      setStatus("disconnected");
      return;
    }
    const token = backendToken;

    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function connect() {
      if (stopped) {
        return;
      }

      const url = new URL(`${API_BASE}/events`);
      url.searchParams.set("token", token);

      const eventSource = new EventSource(url.toString());
      esRef.current = eventSource;
      setStatus("reconnecting");

      const eventNames: SSEEventName[] = [
        "workflow.created",
        "workflow.updated",
        "workflow.progress",
        "conversation.created",
        "conversation.updated",
        "conversation.deleted",
        "message.created",
      ];

      const handlers: Array<{ name: SSEEventName; fn: SSEHandler }> = eventNames.map((name) => {
        const fn: SSEHandler = (event) => {
          try {
            const data = JSON.parse((event as MessageEvent).data);
            onEventRef.current(name, data);
          } catch {
            // Ignore malformed SSE payloads.
          }
        };
        eventSource.addEventListener(name, fn as EventListener);
        return { name, fn };
      });

      eventSource.onopen = () => {
        setStatus("connected");
      };

      eventSource.onerror = () => {
        eventSource.close();
        esRef.current = null;
        for (const { name, fn } of handlers) {
          eventSource.removeEventListener(name, fn as EventListener);
        }
        if (!stopped) {
          setStatus("reconnecting");
          retryTimeout = setTimeout(connect, 5000);
        } else {
          setStatus("disconnected");
        }
      };
    }

    connect();

    return () => {
      stopped = true;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
      esRef.current?.close();
      esRef.current = null;
      setStatus("disconnected");
    };
  }, [backendToken, enabled]);

  return status;
}
