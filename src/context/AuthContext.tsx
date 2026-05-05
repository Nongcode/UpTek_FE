"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { AuthState, AccessPolicy, BootstrapConfig } from "@/lib/types";
import { fetchBootstrapConfig, login as apiLogin, refreshBackendAuth } from "@/lib/api";
import {
  BACKEND_AUTH_EXPIRED_EVENT,
  getBackendTokenRemainingMs,
  isBackendTokenExpired,
  shouldRefreshBackendToken,
} from "@/lib/backendAuth";

interface AuthContextType extends AuthState {
  bootstrapConfig: BootstrapConfig | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
  error: string | null;
}

const AuthContext = createContext<AuthContextType | null>(null);

const AUTH_STORAGE_KEY = "openclaw_auth";

function loadAuthFromStorage(): AuthState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthState>;
    if (parsed.isAuthenticated && !parsed.backendToken) {
      clearAuthFromStorage();
      return null;
    }
    return parsed as AuthState;
  } catch {
    return null;
  }
}

function saveAuthToStorage(state: AuthState): void {
  if (typeof window === "undefined") return;
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(state));
}

function clearAuthFromStorage(): void {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({
    isAuthenticated: false,
    token: null,
    backendToken: null,
    accessPolicy: null,
    employeeName: null,
    employeeId: null,
  });
  const [bootstrapConfig, setBootstrapConfig] = useState<BootstrapConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshInFlightRef = useRef<Promise<AuthState | null> | null>(null);

  const clearExpiredAuth = useCallback(() => {
    setAuth({
      isAuthenticated: false,
      token: null,
      backendToken: null,
      accessPolicy: null,
      employeeName: null,
      employeeId: null,
    });
    clearAuthFromStorage();
    setError("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.");
  }, []);

  const refreshBackendSessionForAuth = useCallback(async (
    baseAuth: AuthState,
    canApply: () => boolean = () => true,
  ): Promise<boolean> => {
    if (!baseAuth.isAuthenticated || !baseAuth.token || !baseAuth.employeeId) {
      return false;
    }
    if (!refreshInFlightRef.current) {
      refreshInFlightRef.current = refreshBackendAuth({
        token: baseAuth.token,
        employeeId: baseAuth.employeeId,
        employeeName: baseAuth.employeeName,
      })
        .then((result) => {
          const nextAuth: AuthState = {
            ...baseAuth,
            token: result.token || baseAuth.token,
            backendToken: result.backendToken || null,
            accessPolicy: result.accessPolicy || baseAuth.accessPolicy,
            employeeName: result.accessPolicy?.employeeName || baseAuth.employeeName,
            employeeId: result.accessPolicy?.employeeId || baseAuth.employeeId,
            isAuthenticated: true,
          };
          if (!nextAuth.backendToken || isBackendTokenExpired(nextAuth.backendToken)) {
            return null;
          }
          return nextAuth;
        })
        .catch(() => null)
        .finally(() => {
          refreshInFlightRef.current = null;
        });
    }

    const nextAuth = await refreshInFlightRef.current;
    if (!nextAuth) {
      return false;
    }
    if (canApply()) {
      setAuth(nextAuth);
      saveAuthToStorage(nextAuth);
      setError(null);
    }
    return true;
  }, []);

  const refreshBackendSession = useCallback(async (): Promise<boolean> => {
    return refreshBackendSessionForAuth(auth);
  }, [auth, refreshBackendSessionForAuth]);

  const prepareStoredAuth = useCallback(async (
    stored: AuthState | null,
    canApply: () => boolean = () => true,
  ): Promise<void> => {
    if (!stored?.isAuthenticated) {
      return;
    }

    if (!stored.backendToken || shouldRefreshBackendToken(stored.backendToken)) {
      const refreshed = await refreshBackendSessionForAuth(stored, canApply);
      if (!canApply()) {
        return;
      }
      if (!refreshed) {
        if (!stored.backendToken || isBackendTokenExpired(stored.backendToken)) {
          clearExpiredAuth();
          return;
        }
        setAuth(stored);
      }
      return;
    }

    if (!canApply()) {
      return;
    }
    setAuth(stored);
  }, [clearExpiredAuth, refreshBackendSessionForAuth]);

  useEffect(() => {
    let cancelled = false;
    const stored = loadAuthFromStorage();
    const authPromise = prepareStoredAuth(stored, () => !cancelled);

    const bootstrapPromise = fetchBootstrapConfig()
      .then((config) => {
        if (!cancelled) {
          setBootstrapConfig(config);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Không thể kết nối đến server Uptek-AI");
        }
      });

    Promise.allSettled([bootstrapPromise, authPromise]).finally(() => {
      if (!cancelled) {
        setIsLoading(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [prepareStoredAuth]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const handleBackendAuthExpired = () => {
      void refreshBackendSession().then((ok) => {
        if (!ok) {
          clearExpiredAuth();
        }
      });
    };

    window.addEventListener(BACKEND_AUTH_EXPIRED_EVENT, handleBackendAuthExpired);
    return () => {
      window.removeEventListener(BACKEND_AUTH_EXPIRED_EVENT, handleBackendAuthExpired);
    };
  }, [clearExpiredAuth, refreshBackendSession]);

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.backendToken) {
      return;
    }

    if (shouldRefreshBackendToken(auth.backendToken)) {
      void refreshBackendSession().then((ok) => {
        if (!ok && isBackendTokenExpired(auth.backendToken)) {
          clearExpiredAuth();
        }
      });
      return;
    }

    const refreshDelayMs = Math.max(
      30_000,
      getBackendTokenRemainingMs(auth.backendToken) - 10 * 60 * 1000,
    );
    const timer = window.setTimeout(() => {
      void refreshBackendSession();
    }, refreshDelayMs);
    return () => window.clearTimeout(timer);
  }, [auth.backendToken, auth.isAuthenticated, clearExpiredAuth, refreshBackendSession]);

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.backendToken) {
      return;
    }

    const refreshIfNeeded = () => {
      if (shouldRefreshBackendToken(auth.backendToken)) {
        void refreshBackendSession().then((ok) => {
          if (!ok && isBackendTokenExpired(auth.backendToken)) {
            clearExpiredAuth();
          }
        });
      }
    };

    window.addEventListener("focus", refreshIfNeeded);
    document.addEventListener("visibilitychange", refreshIfNeeded);
    return () => {
      window.removeEventListener("focus", refreshIfNeeded);
      document.removeEventListener("visibilitychange", refreshIfNeeded);
    };
  }, [auth.backendToken, auth.isAuthenticated, clearExpiredAuth, refreshBackendSession]);

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await apiLogin(email, password);
      const newAuth: AuthState = {
        isAuthenticated: true,
        token: result.token || null,
        backendToken: result.backendToken || null,
        accessPolicy: result.accessPolicy || null,
        employeeName: result.accessPolicy?.employeeName || email.split("@")[0],
        employeeId: result.accessPolicy?.employeeId || email.split("@")[0],
      };
      setAuth(newAuth);
      saveAuthToStorage(newAuth);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Đăng nhập thất bại";
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    setAuth({
      isAuthenticated: false,
      token: null,
      backendToken: null,
      accessPolicy: null,
      employeeName: null,
      employeeId: null,
    });
    clearAuthFromStorage();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        ...auth,
        bootstrapConfig,
        login,
        logout,
        isLoading,
        error,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
