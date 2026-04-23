import { Conversation, Message, Project } from "./types";

const STORAGE_PREFIX = "openclaw_chat_";
const API_BASE = "http://localhost:3001/api";

type BackendAuth = {
  backendToken: string;
};

export class BackendRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "BackendRequestError";
    this.status = status;
  }
}

function buildAuthHeaders(auth: BackendAuth): HeadersInit {
  return {
    Authorization: `Bearer ${auth.backendToken}`,
  };
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new BackendRequestError(
      errorData?.error?.message || `Request failed with status ${response.status}`,
      response.status,
    );
  }
  return (await response.json()) as T;
}

async function requestVoid(input: RequestInfo | URL, init?: RequestInit): Promise<void> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new BackendRequestError(
      errorData?.error?.message || `Request failed with status ${response.status}`,
      response.status,
    );
  }
}

export async function loadConversations(
  employeeId: string,
  options?: { includeAutomation?: boolean },
  auth?: BackendAuth,
): Promise<Conversation[]> {
  if (!auth?.backendToken) {
    throw new Error("Missing backend token");
  }

  const includeAutomation = options?.includeAutomation ? "1" : "0";
  return requestJson<Conversation[]>(
    `${API_BASE}/conversations/${employeeId}?includeAutomation=${includeAutomation}`,
    {
      headers: buildAuthHeaders(auth),
    },
  );
}

export async function saveConversations(
  employeeId: string,
  conversations: Conversation[],
): Promise<void> {
  void employeeId;
  void conversations;
}

export async function apiCreateConversation(
  params: {
    agentId: string;
    lane?: "user" | "automation";
    title?: string;
    employeeId?: string;
    workflowId?: string;
  },
  auth: BackendAuth,
): Promise<Conversation> {
  // BE sinh id + sessionKey, trả full Conversation object
  return requestJson<Conversation>(`${API_BASE}/conversations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders(auth) },
    body: JSON.stringify(params),
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
  return requestJson<Conversation[]>(`${API_BASE}/conversations-global`, {
    headers: buildAuthHeaders(auth),
  });
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
