import { BootstrapConfig, LoginResponse, UsersResponse } from "./types

const GATEWAY_BASE = "/api/gateway";
export const BACKEND_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "/api/backend";

function buildBackendAuthHeaders(backendToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${backendToken}`,
  };
}

export async function fetchBootstrapConfig(): Promise<BootstrapConfig> {
  const res = await fetch(`${GATEWAY_BASE}/__openclaw/control-ui-config.json`);
  if (!res.ok) {
    throw new Error(`Failed to fetch bootstrap config: ${res.status}`);
  }
  return res.json();
}

export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  const res = await fetch(`${BACKEND_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(
      data?.error?.message || `Login failed with status ${res.status}`,
    );
  }
  return res.json();
}

export async function fetchUsers(backendToken: string): Promise<UsersResponse> {
  const res = await fetch(`${BACKEND_BASE}/users`, {
    headers: buildBackendAuthHeaders(backendToken),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `Load users failed with status ${res.status}`);
  }
  return res.json();
}

export async function updateUserStatus(
  backendToken: string,
  userId: string,
  status: "active" | "disabled",
): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/users/${userId}/status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...buildBackendAuthHeaders(backendToken),
    },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `Update user failed with status ${res.status}`);
  }
}

export async function deleteUser(backendToken: string, userId: string): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/users/${userId}`, {
    method: "DELETE",
    headers: buildBackendAuthHeaders(backendToken),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || `Delete user failed with status ${res.status}`);
  }
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
  opts: ChatCompletionOptions,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${opts.token}`,
  };

  if (opts.sessionKey) {
    headers["X-OpenClaw-Session-Key"] = opts.sessionKey;
  }

  if (opts.agentId) {
    headers["X-OpenClaw-Agent-Id"] = opts.agentId;
  }

  const body = {
    model: opts.agentId ? `openclaw/${opts.agentId}` : (opts.model || "openclaw"),
    stream: true,
    messages: opts.messages,
  };

  try {
    const res = await fetch(`${GATEWAY_BASE}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      throw new Error(
        errData?.error?.message || `Chat request failed: ${res.status}`,
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

