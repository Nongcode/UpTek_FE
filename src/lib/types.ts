export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "manager";
  type?: "regular" | "manager_note" | "approval_request";
  content: string;
  timestamp: number;
  conversationId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  lane: "user" | "automation";
  agentId: string;
  sessionKey: string;
  projectId?: string;
  workflowId?: string;
  role?: "root" | "sub_agent";
  parentConversationId?: string;
  status?: "active" | "pending_approval" | "approved" | "cancelled" | "stopped";
  employeeId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Project {
  id: string;
  name: string;
  status: "planning" | "in_progress" | "completed" | "on_hold";
  createdAt: number;
  updatedAt: number;
}

export interface Template {
  id: string;
  title: string;
  prompt: string;
  category: string;
}

export interface AccessPolicy {
  employeeId?: string;
  employeeName?: string;
  lockedAgentId?: string;
  lockedSessionKey?: string;
  companyId?: string;
  departmentId?: string;
  canViewAllSessions?: boolean;
  visibleAgentIds?: string[];
  lockAgent?: boolean;
  lockSession?: boolean;
  autoConnect?: boolean;
  enforcedByServer?: boolean;
}

export interface DemoLoginAccount {
  email: string;
  label?: string;
  employeeId?: string;
  employeeName?: string;
  lockedAgentId?: string;
}

export interface DemoLoginConfig {
  enabled: boolean;
  accounts: DemoLoginAccount[];
}

export interface BootstrapConfig {
  basePath: string;
  assistantName: string;
  assistantAvatar: string;
  assistantAgentId: string;
  serverVersion?: string;
  accessPolicy?: AccessPolicy;
  demoLogin?: DemoLoginConfig;
}

export interface LoginResponse {
  ok: true;
  token?: string | null;
  backendToken?: string | null;
  accessPolicy?: AccessPolicy;
}

export interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  backendToken: string | null;
  accessPolicy: AccessPolicy | null;
  employeeName: string | null;
  employeeId: string | null;
}
