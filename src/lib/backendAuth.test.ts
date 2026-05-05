import test from "node:test";
import assert from "node:assert/strict";

import {
  BACKEND_AUTH_EXPIRED_EVENT,
  getBackendTokenRemainingMs,
  isBackendTokenExpired,
  notifyBackendAuthExpired,
  parseBackendTokenPayload,
  shouldRefreshBackendToken,
} from "./backendAuth";

function installBrowserShim(onDispatch?: (event: Event) => void): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const shim = {
    atob(input: string) {
      return Buffer.from(input, "base64").toString("binary");
    },
    dispatchEvent(event: Event) {
      onDispatch?.(event);
      return true;
    },
  } as unknown as Window & typeof globalThis;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: shim,
  });

  return () => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, "window", originalDescriptor);
      return;
    }
    delete (globalThis as { window?: Window }).window;
  };
}

function makeBackendToken(payload: object): string {
  return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("backend auth helper parses custom backend token payload", () => {
  const cleanup = installBrowserShim();
  try {
    const token = makeBackendToken({ exp: Date.now() + 60_000, employeeId: "pho_phong" });
    assert.equal(parseBackendTokenPayload(token)?.exp !== undefined, true);
    assert.equal(isBackendTokenExpired(token), false);
  } finally {
    cleanup();
  }
});

test("backend auth helper treats expired or malformed tokens as expired", () => {
  const cleanup = installBrowserShim();
  try {
    assert.equal(isBackendTokenExpired(makeBackendToken({ exp: Date.now() - 1 })), true);
    assert.equal(isBackendTokenExpired("not-a-token"), true);
    assert.equal(isBackendTokenExpired(null), true);
  } finally {
    cleanup();
  }
});

test("backend auth helper detects tokens that should be refreshed soon", () => {
  const cleanup = installBrowserShim();
  try {
    const nearExpiryToken = makeBackendToken({ exp: Date.now() + 5 * 60_000 });
    const freshToken = makeBackendToken({ exp: Date.now() + 60 * 60_000 });

    assert.ok(getBackendTokenRemainingMs(nearExpiryToken) > 0);
    assert.equal(shouldRefreshBackendToken(nearExpiryToken, 10 * 60_000), true);
    assert.equal(shouldRefreshBackendToken(freshToken, 10 * 60_000), false);
  } finally {
    cleanup();
  }
});

test("auth context uses refresh endpoint before clearing expired backend sessions", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(process.cwd(), "src/context/AuthContext.tsx"), "utf8");
  const apiSource = fs.readFileSync(path.join(process.cwd(), "src/lib/api.ts"), "utf8");

  assert.match(apiSource, /buildBackendApiUrl\("auth\/refresh"\)/);
  assert.match(source, /refreshBackendSession/);
  assert.match(source, /window\.addEventListener\(BACKEND_AUTH_EXPIRED_EVENT, handleBackendAuthExpired\)/);
  assert.match(source, /shouldRefreshBackendToken\(auth\.backendToken\)/);
  assert.doesNotMatch(source, /!parsed\.backendToken \|\| isBackendTokenExpired\(parsed\.backendToken\)/);
});

test("auth bootstrap refreshes stored backend token before leaving loading state", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const source = fs.readFileSync(path.join(process.cwd(), "src/context/AuthContext.tsx"), "utf8");

  assert.match(source, /const prepareStoredAuth = useCallback/);
  assert.match(source, /shouldRefreshBackendToken\(stored\.backendToken\)/);
  assert.match(source, /refreshBackendSessionForAuth\(stored, canApply\)/);
  assert.match(source, /const authPromise = prepareStoredAuth\(stored, \(\) => !cancelled\)/);
  assert.match(source, /Promise\.allSettled\(\[bootstrapPromise, authPromise\]\)\.finally/);
  assert.match(source, /setIsLoading\(false\)/);
});

test("notifyBackendAuthExpired dispatches the shared auth expiry event", () => {
  let dispatched = false;
  const cleanup = installBrowserShim((event) => {
    dispatched = event.type === BACKEND_AUTH_EXPIRED_EVENT;
  });
  try {
    notifyBackendAuthExpired();
    assert.equal(dispatched, true);
  } finally {
    cleanup();
  }
});
