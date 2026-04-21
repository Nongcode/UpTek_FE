import { AccessPolicy, Conversation } from "@/lib/types";

export type ChatLane = "user" | "automation";
export type AutomationStatus = "active" | "pending_approval" | "approved" | "cancelled";

const AUTOMATION_ALLOWED_IDS = new Set([
  "pho_phong",
  "quan_ly",
  "truong_phong",
  "main",
  "admin",
]);

export function detectLane(sessionKey: string | undefined): ChatLane {
  const key = String(sessionKey || "");
  if (key.startsWith("automation:") || key.includes(":automation:") || key.includes(":wf_")) {
    return "automation";
  }
  return "user";
}

export function hydrateConversationLane(conversation: Conversation): Conversation {
  return {
    ...conversation,
    lane: conversation.lane || detectLane(conversation.sessionKey),
  };
}

export function extractAutomationWorkflowId(
  conversation: Pick<Conversation, "id" | "sessionKey" | "workflowId">,
): string | null {
  if (conversation.workflowId) return conversation.workflowId;

  const sessionKey = String(conversation.sessionKey || "");
  const id = String(conversation.id || "");

  const sessionMatch = sessionKey.match(/^automation:[^:]+:(.+)$/i);
  const sessionWorkflowId = sessionMatch?.[1]?.trim();
  if (sessionWorkflowId && !sessionWorkflowId.startsWith("conv_") && !sessionWorkflowId.includes(":conv_")) {
    return sessionWorkflowId;
  }

  const idMatch = id.match(/^auto_[^_]+_(.+)$/i);
  const idWorkflowId = idMatch?.[1]?.trim();
  if (idWorkflowId && !idWorkflowId.startsWith("conv_")) {
    return idWorkflowId;
  }

  return null;
}

export function detectAutomationCancellationIntent(content: string): boolean {
  const lower = String(content || "").toLowerCase();
  return (
    lower.includes("huy workflow") ||
    lower.includes("hủy workflow") ||
    lower.includes("dung workflow") ||
    lower.includes("dừng workflow") ||
    lower.includes("ngừng workflow") ||
    lower.includes("dừng lại") ||
    lower.includes("thôi không chạy") ||
    lower.includes("tạm dừng workflow") ||
    lower.includes("stop workflow") ||
    lower.includes("cancel workflow") ||
    lower.includes("xác nhận hủy") ||
    lower.includes("đã hủy")
  );
}

export function normalizeAutomationStatus(content: string): AutomationStatus {
  const lower = String(content || "").toLowerCase();
  if (detectAutomationCancellationIntent(lower)) {
    return "cancelled";
  }

  if (
    lower.includes("chờ duyệt") ||
    lower.includes("đang chờ duyệt") ||
    lower.includes("duyệt content") ||
    lower.includes("duyệt ảnh") ||
    lower.includes("duyệt content") ||
    lower.includes("duyệt ảnh")
  ) {
    return "pending_approval";
  }

  if (
    lower.includes("đăng thành công") ||
    lower.includes("hẹn giờ đăng") ||
    lower.includes("đã được cập nhật") ||
    lower.includes("đã được đăng")
  ) {
    return "approved";
  }

  return "active";
}

export function canAccessAutomationLane(
  employeeId: string | null,
  accessPolicy: AccessPolicy | null,
): boolean {
  if (accessPolicy?.canViewAllSessions) {
    return true;
  }

  const normalized = String(employeeId || "").trim().toLowerCase();
  return AUTOMATION_ALLOWED_IDS.has(normalized);
}
