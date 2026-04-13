import { Conversation, Message, Project } from "./types";

const STORAGE_PREFIX = "openclaw_chat_";

const API_BASE = "http://localhost:3001/api";

export async function loadConversations(employeeId: string): Promise<Conversation[]> {
  try {
    const res = await fetch(`${API_BASE}/conversations/${employeeId}`);
    if (!res.ok) return [];
    return await res.json() as Conversation[];
  } catch {
    return [];
  }
}

export async function saveConversations(
  employeeId: string,
  conversations: Conversation[]
): Promise<void> {
  // We don't save the entire array to the DB like localStorage.
  // This function is kept for signature compatibility during transition,
  // but we will create dedicated API calls for creation and updates.
  // For full array replacement (e.g. from deletion), it's complex. Let's just do nothing here
  // and handle API sync in page.tsx.
}

export async function apiCreateConversation(conv: Conversation): Promise<void> {
  try {
    await fetch(`${API_BASE}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(conv)
    });
  } catch (err) {
    console.error("Lỗi khi lưu cuộc trò chuyện:", err);
  }
}

export async function apiUpdateConversation(id: string, updates: Partial<Conversation>): Promise<void> {
  try {
    await fetch(`${API_BASE}/conversations/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates)
    });
  } catch (err) {
    console.error("Lỗi khi cập nhật cuộc trò chuyện:", err);
  }
}

export async function apiSaveMessages(messages: Message[]): Promise<void> {
  try {
    await fetch(`${API_BASE}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    });
  } catch (err) {
    console.error("Lỗi khi lưu tin nhắn:", err);
  }
}

export async function apiDeleteConversation(id: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/conversations/${id}`, { method: "DELETE" });
  } catch (err) {
    console.error("Lỗi khi xóa cuộc trò chuyện:", err);
  }
}

export function createConversation(
  agentId: string,
  projectId?: string
): Conversation {
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const sessionKey = `thread:${agentId}:${id}`;
  return {
    id,
    title: "Cuộc trò chuyện mới",
    messages: [],
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
  type?: "regular" | "manager_note" | "approval_request"
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
  const firstUserMsg = messages.find((m) => m.role === "user");
  if (!firstUserMsg) return "Cuộc trò chuyện mới";
  const text = firstUserMsg.content.trim();
  if (text.length <= 40) return text;
  return text.slice(0, 40) + "...";
}

// -------------------------------------------------------------------
// GLOBAL CONVERSATIONS (For Dashboard)
// -------------------------------------------------------------------
export async function loadAllConversationsGlobally(): Promise<Conversation[]> {
  try {
    const res = await fetch(`${API_BASE}/conversations-global`);
    if (!res.ok) return [];
    return await res.json() as Conversation[];
  } catch {
    return [];
  }
}

// -------------------------------------------------------------------
// PROJECTS
// -------------------------------------------------------------------
function getProjectsStorageKey(): string {
  return `${STORAGE_PREFIX}global_projects`;
}

export function loadProjects(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(getProjectsStorageKey());
    if (!raw) return [];
    return JSON.parse(raw) as Project[];
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]): void {
  if (typeof window === "undefined") return;
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

