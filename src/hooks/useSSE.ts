"use client";

import { useEffect, useRef, useState } from "react";
import { buildBackendApiUrl } from "@/lib/runtimeUrls";

export type SSEEventName =
  | "realtime.snapshot"
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
    let openTimeout: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let cleanupCurrentEventSource: (() => void) | null = null;

    function clearRetryTimeout() {
      if (!retryTimeout) {
        return;
      }
      clearTimeout(retryTimeout);
      retryTimeout = null;
    }

    function scheduleReconnect(delayMs = 5000) {
      clearRetryTimeout();
      retryTimeout = setTimeout(connect, delayMs);
    }

    function clearOpenTimeout() {
      if (!openTimeout) {
        return;
      }
      clearTimeout(openTimeout);
      openTimeout = null;
    }

    function closeEventSource(eventSource: EventSource, handlers: Array<{ name: SSEEventName; fn: SSEHandler }>) {
      clearOpenTimeout();
      eventSource.close();
      for (const { name, fn } of handlers) {
        eventSource.removeEventListener(name, fn as EventListener);
      }
    }

    function cleanupCurrentConnection() {
      cleanupCurrentEventSource?.();
      cleanupCurrentEventSource = null;
      esRef.current = null;
    }

    function connect() {
      if (stopped) {
        return;
      }
      if (esRef.current && esRef.current.readyState !== EventSource.CLOSED) {
        return;
      }
      clearRetryTimeout();

      const url = new URL(buildBackendApiUrl("events"), window.location.origin);
      url.searchParams.set("token", token);

      const eventSource = new EventSource(url.toString());
      esRef.current = eventSource;
      setStatus("reconnecting");
      openTimeout = setTimeout(() => {
        if (stopped || esRef.current !== eventSource || eventSource.readyState === EventSource.OPEN) {
          return;
        }
        cleanupCurrentConnection();
        setStatus("reconnecting");
        scheduleReconnect(1000);
      }, 8000);

      const eventNames: SSEEventName[] = [
        "realtime.snapshot",
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
            clearOpenTimeout();
            setStatus("connected");
            const data = JSON.parse((event as MessageEvent).data);
            onEventRef.current(name, data);
          } catch {
            // Ignore malformed SSE payloads.
          }
        };
        eventSource.addEventListener(name, fn as EventListener);
        return { name, fn };
      });
      cleanupCurrentEventSource = () => closeEventSource(eventSource, handlers);

      eventSource.onopen = () => {
        clearOpenTimeout();
        setStatus("connected");
      };

      eventSource.onerror = () => {
        clearOpenTimeout();
        if (esRef.current === eventSource) {
          cleanupCurrentConnection();
        } else {
          closeEventSource(eventSource, handlers);
        }
        if (!stopped) {
          setStatus("reconnecting");
          scheduleReconnect();
        } else {
          setStatus("disconnected");
        }
      };
    }

    function reconnectAfterResume() {
      if (stopped) {
        return;
      }
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }
      if (!esRef.current || esRef.current.readyState !== EventSource.OPEN) {
        cleanupCurrentConnection();
        setStatus("reconnecting");
        scheduleReconnect(0);
      }
    }

    connect();
    window.addEventListener("focus", reconnectAfterResume);
    window.addEventListener("online", reconnectAfterResume);
    document.addEventListener("visibilitychange", reconnectAfterResume);

    return () => {
      stopped = true;
      clearRetryTimeout();
      window.removeEventListener("focus", reconnectAfterResume);
      window.removeEventListener("online", reconnectAfterResume);
      document.removeEventListener("visibilitychange", reconnectAfterResume);
      cleanupCurrentConnection();
      setStatus("disconnected");
    };
  }, [backendToken, enabled]);

  return status;
}
