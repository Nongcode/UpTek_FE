"use client";

import { useEffect, useRef } from "react";

const API_BASE = "http://localhost:3001/api";

export type SSEEventName =
  | "workflow.created"
  | "workflow.updated"
  | "conversation.created"
  | "message.created"
  | "conversation.updated";

type SSEHandler = (data: unknown) => void;

interface UseSSEOptions {
  backendToken: string | null;
  enabled: boolean;
  onEvent: (eventName: SSEEventName, data: unknown) => void;
}

export function useSSE({ backendToken, enabled, onEvent }: UseSSEOptions) {
  const esRef = useRef<EventSource | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || !backendToken) {
      return;
    }

    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    function connect() {
      if (stopped) return;

      const url = new URL(`${API_BASE}/events`);
      // EventSource không hỗ trợ custom headers, dùng query param để truyền token
      url.searchParams.set("token", backendToken as string);

      const es = new EventSource(url.toString());
      esRef.current = es;

      const EVENTS: SSEEventName[] = [
        "workflow.created",
        "workflow.updated",
        "conversation.created",
        "message.created",
        "conversation.updated",
      ];

      const handlers: Array<{ name: string; fn: SSEHandler }> = EVENTS.map((name) => {
        const fn: SSEHandler = (e) => {
          try {
            const data = JSON.parse((e as MessageEvent).data);
            onEventRef.current(name, data);
          } catch {
            // ignore malformed event
          }
        };
        es.addEventListener(name, fn as EventListener);
        return { name, fn };
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        for (const { name, fn } of handlers) {
          es.removeEventListener(name, fn as EventListener);
        }
        // Reconnect sau 5s
        if (!stopped) {
          retryTimeout = setTimeout(connect, 5000);
        }
      };
    }

    connect();

    return () => {
      stopped = true;
      if (retryTimeout) clearTimeout(retryTimeout);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [backendToken, enabled]);
}
