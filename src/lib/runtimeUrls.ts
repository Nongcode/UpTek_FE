const BACKEND_API_BASE = process.env.NEXT_PUBLIC_BACKEND_API_BASE || "/api";
const GATEWAY_PROXY_BASE = "/api/gateway";
const STORAGE_BASE = "/storage";

function joinUrlPath(base: string, path?: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = String(path || "").replace(/^\/+/, "");
  return normalizedPath ? `${normalizedBase}/${normalizedPath}` : `${normalizedBase}/`;
}

function getWindowOrigin(): string {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "http://localhost";
}

export function buildBackendApiUrl(path?: string): string {
  return joinUrlPath(BACKEND_API_BASE, path);
}

export function buildGatewayProxyUrl(path?: string): string {
  return joinUrlPath(GATEWAY_PROXY_BASE, path);
}

export function buildStorageUrl(path: string): string {
  const value = String(path || "").trim();
  if (!value) {
    return "/";
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith(STORAGE_BASE)) {
    return value;
  }
  return value.startsWith("/") ? value : `/${value}`;
}

export function buildBackendMediaPreviewUrl(
  filePath: string,
  backendToken?: string | null,
): string {
  const url = new URL(buildBackendApiUrl("media-preview"), getWindowOrigin());
  url.searchParams.set("path", filePath);
  if (backendToken) {
    url.searchParams.set("token", backendToken);
  }
  return url.toString();
}

export function getAdminDashboardUrl(): string {
  return process.env.NEXT_PUBLIC_ADMIN_DASHBOARD_URL || buildGatewayProxyUrl();
}
