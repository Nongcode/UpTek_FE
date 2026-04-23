"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import type { DemoLoginAccount } from "@/lib/types";
import { getAdminDashboardUrl } from "@/lib/runtimeUrls";

export default function LoginPage() {
  const { login, bootstrapConfig, isLoading, error, isAuthenticated, employeeId } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      if (employeeId === "admin" || employeeId === "Admin" || employeeId === "main") {
        window.location.href = getAdminDashboardUrl();
      } else {
        router.push("/");
      }
    }
  }, [isAuthenticated, router, employeeId]);

  const demoAccounts = bootstrapConfig?.demoLogin?.enabled
    ? bootstrapConfig.demoLogin.accounts
    : [];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setIsSubmitting(true);
    try {
      await login(email, password);
    } catch (err) {
      setLoginError(
        err instanceof Error ? err.message : "Đăng nhập thất bại"
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQuickLogin = async (account: DemoLoginAccount) => {
    setLoginError(null);
    setIsSubmitting(true);
    const fullAccount = bootstrapConfig?.demoLogin?.accounts.find(
      (a) => a.email === account.email
    );
    if (!fullAccount) return;
    setEmail(account.email);
    setPassword("");
    setIsSubmitting(false);
  };

  if (isLoading) {
    return (
      <div className="login-container">
        <div className="login-loading">
          <div className="loading-spinner" />
          <p>Đang kết nối đến Uptek-AI...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-header">
          <div className="login-logo">
            <img src="/dbc2d982-780a-40a7-9588-5406dac6054d.jpg" alt="Uptek Logo" className="login-logo-img" />
          </div>
          <h1>Uptek-AI</h1>
          <p className="login-subtitle">Đăng nhập để bắt đầu trò chuyện với AI Agent</p>
        </div>

        {(error || loginError) && (
          <div className="login-error">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM7.25 5a.75.75 0 011.5 0v3a.75.75 0 01-1.5 0V5zm.75 6.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
            </svg>
            <span>{loginError || error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Nhập email của bạn"
              required
              autoComplete="email"
            />
          </div>
          <div className="form-group">
            <label htmlFor="password">Mật khẩu</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Nhập mật khẩu"
              required
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            className="login-button"
            disabled={isSubmitting || !email || !password}
          >
            {isSubmitting ? (
              <span className="button-loading">
                <div className="loading-spinner small" />
                Đang đăng nhập...
              </span>
            ) : (
              "Đăng nhập"
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
