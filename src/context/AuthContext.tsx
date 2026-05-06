"use client";

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import { AuthState, AccessPolicy, BootstrapConfig } from "@/lib/types";
import { fetchBootstrapConfig, login as apiLogin } from "@/lib/api";

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
    managerInstanceId: null,
  });
  const [bootstrapConfig, setBootstrapConfig] = useState<BootstrapConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stored = loadAuthFromStorage();
    if (stored && stored.isAuthenticated) {
      setAuth(stored);
    }

    fetchBootstrapConfig()
      .then((config) => setBootstrapConfig(config))
      .catch(() => setError("Không thể kết nối đến server Uptek-AI"))
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await apiLogin(email, password);
      if (result.bootstrapConfig) {
        setBootstrapConfig(result.bootstrapConfig);
      }
      const newAuth: AuthState = {
        isAuthenticated: true,
        token: result.token || null,
        backendToken: result.backendToken || null,
        accessPolicy: result.accessPolicy || null,
        employeeName: result.accessPolicy?.employeeName || email.split("@")[0],
        employeeId: result.accessPolicy?.employeeId || email.split("@")[0],
        managerInstanceId: result.accessPolicy?.managerInstanceId || null,
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
      managerInstanceId: null,
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
