import { Conversation, Message, Project } from "./types";
import { BACKEND_BASE } from "./api";

const STORAGE_PREFIX = "openclaw_chat_";
const API_BASE = BACKEND_BASE;

type BackendAuth = {
  backendToken: string;
};

function buildAuthHeaders(auth: BackendAuth): HeadersInit {
  return {
    Authorization: `Bearer ${auth.backendToken}`,
  };
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.error?.message || `Request failed with status ${response.status}`);
  }
  return (await response.json()) as T;
}

async function requestVoid(input: RequestInfo | URL, init?: RequestInit): Promise<void> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(errorData?.error?.message || `Request failed with status ${response.status}`);
  }
}

export async function loadConversations(
  employeeId: string,
  options?: { includeAutomation?: boolean },
  auth?: BackendAuth,
): Promise<Conversation[]> {
  if (!auth?.backendToken) {
    return [];
  }

  try {
    const includeAutomation = options?.includeAutomation ? "1" : "0";
    return await requestJson<Conversation[]>(
      `${API_BASE}/conversations/${employeeId}?includeAutomation=${includeAutomation}`,
      {
        headers: buildAuthHeaders(auth),
      },
    );
  } catch {
    return [];
  }
}

export async function saveConversations(
  employeeId: string,
  conversations: Conversation[],
): Promise<void> {
  void employeeId;
  void conversations;
}

export async function apiCreateConversation(conv: Conversation, auth: BackendAuth): Promise<void> {
  await requestVoid(`${API_BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(auth) },
    body: JSON.stringify(conv),
  });
}

export async function apiUpdateConversation(
  id: string,
  updates: Partial<Conversation>,
  auth: BackendAuth,
): Promise<void> {
  await requestVoid(`${API_BASE}/conversations/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(auth) },
    body: JSON.stringify(updates),
  });
}

export async function apiSaveMessages(messages: Message[], auth: BackendAuth): Promise<void> {
  await requestVoid(`${API_BASE}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(auth) },
    body: JSON.stringify({ messages }),
  });
}

export async function apiDeleteConversation(id: string, auth: BackendAuth): Promise<void> {
  await requestVoid(`${API_BASE}/conversations/${id}`, {
    method: "DELETE",
    headers: buildAuthHeaders(auth),
  });
}

export function createConversation(
  agentId: string,
  projectId?: string,
  lane: "user" | "automation" = "user",
  ownerId?: string,
): Conversation {
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const ownerSegment = (ownerId || "anon").replace(/[^a-zA-Z0-9_-]/g, "_");
  const sessionKey = lane === "automation"
    ? `automation:${agentId}:${id}`
    : `agent:${agentId}:${ownerSegment}:${id}`;

  return {
    id,
    title: lane === "automation" ? "Luồng tự động mới" : "Cuộc trò chuyện mới",
    messages: [],
    lane,
    agentId,
    sessionKey,
    projectId,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function createMessage(
  role: "user" | "assistant" | "system" | "manager",
  content: string,
  type?: "regular" | "manager_note" | "approval_request",
): Message {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    role,
    type,
    content,
    timestamp: Date.now(),
  };
}

export function generateConversationTitle(messages: Message[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return "Cuộc trò chuyện mới";
  }

  const text = firstUserMessage.content.trim();
  if (text.length <= 40) {
    return text;
  }

  return `${text.slice(0, 40)}...`;
}

export async function loadAllConversationsGlobally(auth: BackendAuth): Promise<Conversation[]> {
  try {
    return await requestJson<Conversation[]>(`${API_BASE}/conversations-global`, {
      headers: buildAuthHeaders(auth),
    });
  } catch {
    return [];
  }
}

function getProjectsStorageKey(): string {
  return `${STORAGE_PREFIX}global_projects`;
}

export function loadProjects(): Project[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = localStorage.getItem(getProjectsStorageKey());
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as Project[];
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]): void {
  if (typeof window === "undefined") {
    return;
  }

  localStorage.setItem(getProjectsStorageKey(), JSON.stringify(projects));
}

export function createProject(name: string): Project {
  const newProject: Project = {
    id: `proj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    name,
    status: "planning",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const projects = loadProjects();
  projects.push(newProject);
  saveProjects(projects);
  return newProject;
}

export type { Conversation, Project };
