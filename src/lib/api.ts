import { BootstrapConfig, LoginResponse } from "./types";
import { buildBackendApiUrl, buildGatewayProxyUrl } from "./runtimeUrls";

export const BACKEND_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "/api";

export async function fetchBootstrapConfig(): Promise<BootstrapConfig> {
  const res = await fetch(buildGatewayProxyUrl("__openclaw/control-ui-config.json"));
  if (!res.ok) {
    throw new Error(`Failed to fetch bootstrap config: ${res.status}`);
  }
  return res.json();
}

export async function login(
  email: string,
  password: string
): Promise<LoginResponse> {
  const res = await fetch(buildBackendApiUrl("auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(
      data?.error?.message || `Login failed with status ${res.status}`
    );
  }
  return res.json();
}

export async function refreshBackendAuth(params: {
  token: string;
  employeeId: string;
  employeeName?: string | null;
}): Promise<LoginResponse> {
  const res = await fetch(buildBackendApiUrl("auth/refresh"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(
      data?.error?.message || `Refresh failed with status ${res.status}`
    );
  }
  return res.json();
}

export interface ChatCompletionOptions {
  token: string;
  messages: Array<{ role: string; content: string }>;
  model?: string;
  sessionKey?: string;
  agentId?: string;
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
  signal?: AbortSignal;
}

export async function streamChatCompletion(
  opts: ChatCompletionOptions
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  };

  if (opts.sessionKey) {
    headers["X-OpenClaw-Session-Key"] = opts.sessionKey;
  }

  // Gửi agent ID qua header để Gateway route chính xác đến đúng bộ não agent
  if (opts.agentId) {
    headers["X-OpenClaw-Agent-Id"] = opts.agentId;
  }

  const body = {
    // Gateway yêu cầu format "openclaw/<agentId>" hoặc "agent:<agentId>" để parse đúng
    model: opts.agentId ? `openclaw/${opts.agentId}` : (opts.model || "openclaw"),
    stream: true,
    messages: opts.messages,
  };

  try {
    const res = await fetch(buildGatewayProxyUrl("v1/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      throw new Error(
        errData?.error?.message || `Chat request failed: ${res.status}`
      );
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("No response body reader available");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === ":" || trimmed === "data: [DONE]") {
          if (trimmed === "data: [DONE]") {
            opts.onDone();
            return;
          }
          continue;
        }

        if (trimmed.startsWith("data: ")) {
          const jsonStr = trimmed.slice(6);
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              opts.onDelta(delta);
            }
            const finishReason = parsed.choices?.[0]?.finish_reason;
            if (finishReason === "stop") {
              opts.onDone();
              return;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    }

    opts.onDone();
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    opts.onError(err as Error);
  }
}
