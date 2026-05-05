export const BACKEND_AUTH_EXPIRED_EVENT = "openclaw-auth-expired";

type BackendTokenPayload = {
  exp?: number;
};

function decodeBase64Url(input: string): string | null {
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    if (typeof window === "undefined" || typeof window.atob !== "function") {
      return null;
    }
    const binary = window.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return null;
  }
}

export function parseBackendTokenPayload(token: string | null | undefined): BackendTokenPayload | null {
  const rawToken = String(token || "").trim();
  if (!rawToken) {
    return null;
  }

  const [encodedPayload] = rawToken.split(".");
  if (!encodedPayload) {
    return null;
  }

  const decoded = decodeBase64Url(encodedPayload);
  if (!decoded) {
    return null;
  }

  try {
    return JSON.parse(decoded) as BackendTokenPayload;
  } catch {
    return null;
  }
}

export function isBackendTokenExpired(token: string | null | undefined): boolean {
  const payload = parseBackendTokenPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return true;
  }
  return payload.exp <= Date.now();
}

export function getBackendTokenRemainingMs(token: string | null | undefined): number {
  const payload = parseBackendTokenPayload(token);
  if (!payload || typeof payload.exp !== "number") {
    return 0;
  }
  return Math.max(0, payload.exp - Date.now());
}

export function shouldRefreshBackendToken(
  token: string | null | undefined,
  refreshWindowMs = 10 * 60 * 1000,
): boolean {
  return getBackendTokenRemainingMs(token) <= refreshWindowMs;
}

export function notifyBackendAuthExpired(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new CustomEvent(BACKEND_AUTH_EXPIRED_EVENT));
}
