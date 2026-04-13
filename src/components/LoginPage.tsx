"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import type { DemoLoginAccount } from "@/lib/types";

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
        window.location.href = "http://localhost:18789/";
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
    // Find the full account with password from bootstrapConfig
    const fullAccount = bootstrapConfig?.demoLogin?.accounts.find(
      (a) => a.email === account.email
    );
    if (!fullAccount) return;
    setEmail(account.email);
    // We need the password - it's available in the config's demoLogin
    // The bootstrap config only returns email/label/employeeId, not password
    // So we'll pre-fill the email and let user type password
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
            {bootstrapConfig?.assistantAvatar ? (
              <img src={bootstrapConfig.assistantAvatar} alt="Uptek-AI Logo" width="48" height="48" style={{ borderRadius: '50%', objectFit: 'cover' }} />
            ) : (
              <svg
                width="48"
                height="48"
                viewBox="0 0 48 48"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="24" cy="24" r="24" fill="url(#logo-gradient)" />
                <path
                  d="M16 20C16 17.7909 17.7909 16 20 16H28C30.2091 16 32 17.7909 32 20V28C32 30.2091 30.2091 32 28 32H20C17.7909 32 16 30.2091 16 28V20Z"
                  fill="rgba(255,255,255,0.2)"
                />
                <path
                  d="M20 24L23 27L28 21"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <defs>
                  <linearGradient
                    id="logo-gradient"
                    x1="0"
                    y1="0"
                    x2="48"
                    y2="48"
                  >
                    <stop stopColor="#6366f1" />
                    <stop offset="1" stopColor="#8b5cf6" />
                  </linearGradient>
                </defs>
              </svg>
            )}
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
