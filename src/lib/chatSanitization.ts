const CTA_LINE_PATTERN =
  /^(Duyet|Sua|Dang ngay|Hen gio|Tao video|Sep muon duyet|Muon sua|Co muon|Anh se dang|Video se dang|Permalink:|Post ID|Post IDs|Page IDs)/i;
const INTERNAL_PATH_PATTERN =
  /(?:[A-Za-z]:[\\/]|\/Users\/Administrator\/|\/home\/[^/]+\/)(?:[^:\n]*?)(?:\.openclaw|workspace_|artifacts|logos)/i;

function normalizeText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function isPlaceholderOnlyAssistantContent(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  return normalized === "." || normalized === ".." || normalized === "...";
}

export function shouldRenderMediaAttachment(filePath: string): boolean {
  const normalized = String(filePath || "").trim().replace(/\\/g, "/").toLowerCase();
  if (!normalized) {
    return false;
  }
  if (normalized.includes("/assets/logos/")) {
    return false;
  }
  if (normalized.includes("/workspace_content/artifacts/references/")) {
    return false;
  }
  return true;
}

export function sanitizeAssistantDisplayContent(content: string | null | undefined): string {
  if (isPlaceholderOnlyAssistantContent(content)) {
    return "";
  }

  const lines = String(content || "").split("\n");
  const sanitized: string[] = [];
  let droppingPromptBlock = false;

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const trimmed = line.trim();

    if (/^PROMPT (ANH|VIDEO) DA DUNG:?$/i.test(trimmed)) {
      droppingPromptBlock = true;
      continue;
    }

    if (droppingPromptBlock) {
      if (!trimmed) {
        droppingPromptBlock = false;
        continue;
      }
      if (!CTA_LINE_PATTERN.test(trimmed)) {
        continue;
      }
      droppingPromptBlock = false;
    }

    if (
      /^(IMAGE_DOWNLOAD_DIR|PRIMARY_PRODUCT_IMAGE|GENERATED_IMAGE_PATH|GENERATED_VIDEO_PATH)\b/i.test(trimmed)
      || /^(Anh san pham goc da dung:|Logo da dung:|Anh goc san pham de doi chieu:)\s*/i.test(trimmed)
      || /^MEDIA:\s*["']?(.+?)["']?\s*$/i.test(trimmed)
      || INTERNAL_PATH_PATTERN.test(trimmed)
    ) {
      continue;
    }

    sanitized.push(line);
  }

  return sanitized.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
