"use client";

import React, { useEffect, useRef, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import toast from "react-hot-toast";
import SmartImage from "@/components/SmartImage";
import {
  fetchGalleryImages,
  GalleryImageItem,
  getGalleryGridImageSrc,
  getGalleryImageAlt,
  getGalleryOpenImageSrc,
  resolveMediaUrl,
  uploadGalleryImages,
} from "@/lib/media";

const ALL_TAB = "Tất cả";
const COMPANY_TABS = [ALL_TAB, "UpTek", "Công ty A", "Công ty B", "Công ty C"] as const;

function normalizeImageSource(source?: string | null): "AI" | "USER" {
  return source?.trim().toLowerCase() === "ai" ? "AI" : "USER";
}

export default function GalleryPage() {
  const { backendToken, isAuthenticated, isLoading, employeeId, accessPolicy } = useAuth();
  const [images, setImages] = useState<GalleryImageItem[]>([]);
  const [filteredImages, setFilteredImages] = useState<GalleryImageItem[]>([]);
  const [activeTab, setActiveTab] = useState<string>(ALL_TAB);
  const [fetching, setFetching] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dateFilter, setDateFilter] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [modelFilter, setModelFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"ALL" | "AI" | "USER">("ALL");
  const [uploadModel, setUploadModel] = useState("");
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [selectedPreview, setSelectedPreview] = useState<{
    src: string;
    fallbackSrc: string;
    alt: string;
    model: string;
    uploader: string;
    createdAt: number;
    source: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      window.location.href = "/";
    }
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (backendToken) {
      void fetchImages();
    }
  }, [backendToken]);

  useEffect(() => {
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyHeight = document.body.style.height;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousHtmlHeight = document.documentElement.style.height;

    document.body.style.overflow = "auto";
    document.body.style.height = "auto";
    document.documentElement.style.overflow = "auto";
    document.documentElement.style.height = "auto";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.height = previousBodyHeight;
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.documentElement.style.height = previousHtmlHeight;
    };
  }, []);

  useEffect(() => {
    applyFilter();
  }, [images, dateFilter, modelFilter, activeTab, sourceFilter]);

  useEffect(() => {
    if (!selectedPreview) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedPreview(null);
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedPreview]);

  const fetchImages = async () => {
    try {
      setFetching(true);
      const data = await fetchGalleryImages(backendToken);
      setImages(data);
    } catch (error: any) {
      toast.error(error.message || "Đã xảy ra lỗi");
    } finally {
      setFetching(false);
    }
  };

  const applyFilter = () => {
    let result = [...images];

    if (dateFilter.start) {
      const startMs = new Date(dateFilter.start).getTime();
      result = result.filter((img) => img.createdAt >= startMs);
    }

    if (dateFilter.end) {
      const endMs = new Date(dateFilter.end).getTime() + 86400000 - 1;
      result = result.filter((img) => img.createdAt <= endMs);
    }

    if (modelFilter.trim() !== "") {
      const query = modelFilter.toLowerCase().trim();
      result = result.filter(
        (img) =>
          img.productModel?.toLowerCase().includes(query) ||
          img.prefix?.toLowerCase().includes(query),
      );
    }

    if (sourceFilter !== "ALL") {
      result = result.filter((img) => normalizeImageSource(img.source) === sourceFilter);
    }

    if (activeTab !== ALL_TAB) {
      const targetCompany =
        activeTab === "Công ty A"
          ? "CongTyA"
          : activeTab === "Công ty B"
            ? "CongTyB"
            : activeTab === "Công ty C"
              ? "CongTyC"
              : "UpTek";
      result = result.filter((img) => img.companyId === targetCompany);
    }

    setFilteredImages(result);
  };

  const handleUploadClick = () => {
    setUploadModel("");
    setSelectedFiles([]);
    setPreviewUrls([]);
    setShowUploadModal(true);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const validFiles = files.filter((file) => file.type.startsWith("image/"));
    if (validFiles.length < files.length) {
      toast.error("Một số file không phải hình ảnh và đã bị loại bỏ.");
    }

    if (validFiles.length === 0) return;

    setSelectedFiles((prev) => [...prev, ...validFiles]);

    validFiles.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewUrls((prev) => [...prev, reader.result as string]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviewUrls((prev) => prev.filter((_, i) => i !== index));
  };

  const confirmUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error("Vui lòng chọn ít nhất một ảnh!");
      return;
    }

    if (!uploadModel.trim()) {
      toast.error("Vui lòng nhập Model sản phẩm!");
      return;
    }

    try {
      setUploading(true);
      const formData = new FormData();

      let targetCompany = "UpTek";
      if (activeTab === "Công ty A") targetCompany = "CongTyA";
      else if (activeTab === "Công ty B") targetCompany = "CongTyB";
      else if (activeTab === "Công ty C") targetCompany = "CongTyC";

      formData.append("companyId", targetCompany);
      formData.append("departmentId", accessPolicy?.departmentId || "default_dept");
      formData.append("productModel", uploadModel.trim());

      selectedFiles.forEach((file) => {
        formData.append("images", file);
      });

      await uploadGalleryImages(formData, backendToken);

      toast.success(`Đã thêm ${selectedFiles.length} ảnh thành công!`);
      setShowUploadModal(false);
      void fetchImages();
    } catch (error: any) {
      toast.error(error.message || "Lỗi upload");
    } finally {
      setUploading(false);
    }
  };

  const clearFilters = () => {
    setDateFilter({ start: "", end: "" });
    setModelFilter("");
    setSourceFilter("ALL");
  };

  if (isLoading) {
    return <div style={{ color: "var(--text-primary)", padding: "2rem" }}>Đang tải...</div>;
  }

  return (
    <div className="gallery-page-shell">
      <style
        dangerouslySetInnerHTML={{
          __html: `
            .gallery-page-shell {
              min-height: 100vh;
              overflow-y: auto;
              color: var(--text-primary);
              padding: 24px;
              background:
                radial-gradient(circle at top left, rgba(96, 165, 250, 0.18), transparent 30%),
                radial-gradient(circle at top right, rgba(168, 85, 247, 0.18), transparent 32%),
                linear-gradient(180deg, rgba(15, 23, 42, 0.98) 0%, rgba(15, 23, 42, 1) 100%);
            }
            .gallery-page {
              max-width: 1440px;
              margin: 0 auto;
              display: flex;
              flex-direction: column;
              gap: 20px;
            }
            .gallery-topbar {
              display: flex;
              align-items: flex-start;
              justify-content: space-between;
              gap: 16px;
              padding: 24px;
              background: linear-gradient(145deg, rgba(15, 23, 42, 0.88), rgba(30, 41, 59, 0.72));
              border: 1px solid rgba(148, 163, 184, 0.16);
              border-radius: 28px;
              box-shadow: 0 24px 60px rgba(2, 6, 23, 0.35);
              backdrop-filter: blur(24px);
            }
            .gallery-title-group {
              display: flex;
              align-items: flex-start;
              gap: 14px;
              min-width: 0;
            }
            .gallery-back-btn {
              width: 48px;
              height: 48px;
              border-radius: 16px;
              border: 1px solid rgba(148, 163, 184, 0.18);
              background: rgba(255, 255, 255, 0.05);
              color: var(--text-primary);
              display: inline-flex;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              transition: transform 0.2s ease, background 0.2s ease, border-color 0.2s ease;
              flex-shrink: 0;
            }
            .gallery-back-btn:hover {
              transform: translateX(-2px);
              background: rgba(99, 102, 241, 0.16);
              border-color: rgba(129, 140, 248, 0.5);
            }
            .gallery-kicker {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              padding: 6px 12px;
              border-radius: 999px;
              background: rgba(99, 102, 241, 0.14);
              color: #c7d2fe;
              font-size: 0.78rem;
              font-weight: 700;
              letter-spacing: 0.02em;
              margin-bottom: 10px;
            }
            .gallery-page h1 {
              margin: 0;
              font-size: clamp(2rem, 4vw, 3.2rem);
              line-height: 1.05;
              font-weight: 800;
              letter-spacing: -0.04em;
              background: linear-gradient(135deg, #f8fafc 0%, #93c5fd 46%, #c4b5fd 100%);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
            }
            .gallery-subtitle {
              margin-top: 10px;
              color: #94a3b8;
              font-size: 0.98rem;
              max-width: 720px;
            }
            .gallery-primary-action {
              min-height: 52px;
              padding: 0 18px;
              border: none;
              border-radius: 18px;
              background: linear-gradient(135deg, #4f46e5 0%, #2563eb 100%);
              color: #fff;
              font-weight: 700;
              font-size: 0.95rem;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
              cursor: pointer;
              box-shadow: 0 18px 40px rgba(37, 99, 235, 0.28);
              transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;
              flex-shrink: 0;
            }
            .gallery-primary-action:hover {
              transform: translateY(-2px);
              box-shadow: 0 24px 44px rgba(37, 99, 235, 0.38);
            }
            .gallery-primary-action:disabled {
              cursor: not-allowed;
              opacity: 0.7;
              transform: none;
              box-shadow: none;
            }
            .gallery-panel {
              background: linear-gradient(180deg, rgba(15, 23, 42, 0.82), rgba(15, 23, 42, 0.7));
              border: 1px solid rgba(148, 163, 184, 0.16);
              border-radius: 24px;
              padding: 18px;
              backdrop-filter: blur(18px);
              box-shadow: 0 16px 38px rgba(2, 6, 23, 0.22);
            }
            .gallery-tabs {
              display: flex;
              flex-wrap: wrap;
              gap: 10px;
            }
            .gallery-tab {
              border: 1px solid transparent;
              background: rgba(255, 255, 255, 0.04);
              color: var(--text-secondary);
              border-radius: 999px;
              padding: 11px 16px;
              font-size: 0.9rem;
              font-weight: 700;
              cursor: pointer;
              transition: all 0.2s ease;
            }
            .gallery-tab:hover {
              color: var(--text-primary);
              background: rgba(255, 255, 255, 0.08);
            }
            .gallery-tab.active {
              color: #fff;
              background: linear-gradient(135deg, rgba(99, 102, 241, 0.95), rgba(59, 130, 246, 0.9));
              border-color: rgba(255, 255, 255, 0.12);
              box-shadow: 0 10px 24px rgba(79, 70, 229, 0.25);
            }
            .gallery-filter-wrap {
              display: grid;
              grid-template-columns: minmax(0, 1fr) auto auto;
              gap: 14px;
              align-items: stretch;
            }
            .gallery-advanced-panel {
              display: grid;
              grid-template-columns: minmax(0, 1.2fr) minmax(240px, 0.8fr);
              gap: 14px;
              margin-top: 14px;
            }
            .gallery-filter-card {
              display: flex;
              flex-direction: column;
              gap: 12px;
              min-width: 0;
              padding: 16px;
              border-radius: 20px;
              background: rgba(255, 255, 255, 0.03);
              border: 1px solid rgba(148, 163, 184, 0.12);
            }
            .gallery-filter-label {
              display: flex;
              align-items: center;
              gap: 8px;
              color: #cbd5e1;
              font-size: 0.88rem;
              font-weight: 700;
            }
            .gallery-date-row {
              display: grid;
              grid-template-columns: 1fr auto 1fr;
              gap: 10px;
              align-items: center;
            }
            .gallery-date-input-wrap {
              position: relative;
            }
            .gallery-date-input-wrap .gallery-input {
              padding-right: 46px;
            }
            .gallery-date-picker-btn {
              position: absolute;
              top: 50%;
              right: 10px;
              transform: translateY(-50%);
              width: 30px;
              height: 30px;
              border: none;
              border-radius: 10px;
              background: transparent;
              color: #94a3b8;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              cursor: pointer;
              transition: background 0.2s ease, color 0.2s ease;
            }
            .gallery-date-picker-btn:hover {
              background: rgba(255, 255, 255, 0.08);
              color: #e2e8f0;
            }
            .gallery-date-divider {
              color: #64748b;
              font-size: 0.85rem;
              text-align: center;
            }
            .gallery-input {
              width: 100%;
              min-height: 48px;
              border-radius: 14px;
              border: 1px solid rgba(148, 163, 184, 0.18);
              background: rgba(15, 23, 42, 0.75);
              color: var(--text-primary);
              padding: 0 14px;
              outline: none;
              font-size: 0.95rem;
              transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease;
            }
            .gallery-input::placeholder {
              color: #64748b;
            }
            .gallery-input[type="date"]::-webkit-calendar-picker-indicator {
              opacity: 0;
              pointer-events: none;
            }
            .gallery-input:focus {
              border-color: rgba(129, 140, 248, 0.8);
              box-shadow: 0 0 0 4px rgba(129, 140, 248, 0.14);
              background: rgba(15, 23, 42, 0.92);
            }
            .gallery-clear-btn {
              min-height: 48px;
              padding: 0 16px;
              border-radius: 16px;
              border: 1px solid rgba(148, 163, 184, 0.18);
              background: rgba(255, 255, 255, 0.04);
              color: var(--text-primary);
              font-weight: 700;
              cursor: pointer;
              transition: all 0.2s ease;
            }
            .gallery-advanced-btn {
              min-height: 48px;
              padding: 0 18px;
              border-radius: 16px;
              border: 1px solid rgba(129, 140, 248, 0.4);
              background: #e0e7ff;
              color: #312e81;
              font-weight: 700;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              gap: 10px;
              cursor: pointer;
              transition: all 0.2s ease;
            }
            .gallery-advanced-btn:hover {
              background: #c7d2fe;
              border-color: rgba(129, 140, 248, 0.6);
              color: #1e1b4b;
            }
            .gallery-advanced-btn.active {
              background: linear-gradient(135deg, #818cf8, #6366f1);
              border-color: rgba(129, 140, 248, 0.5);
              color: #ffffff;
            }
            .gallery-clear-btn:hover {
              background: rgba(255, 255, 255, 0.08);
              border-color: rgba(129, 140, 248, 0.45);
            }
            .gallery-source-pills {
              display: flex;
              flex-wrap: wrap;
              gap: 10px;
            }
            .gallery-source-pill {
              min-height: 42px;
              padding: 0 14px;
              border-radius: 999px;
              border: 1px solid rgba(148, 163, 184, 0.16);
              background: rgba(255, 255, 255, 0.04);
              color: var(--text-secondary);
              font-size: 0.88rem;
              font-weight: 700;
              cursor: pointer;
              transition: all 0.2s ease;
            }
            .gallery-source-pill:hover {
              color: var(--text-primary);
              background: rgba(255, 255, 255, 0.08);
            }
            .gallery-source-pill.active {
              background: linear-gradient(135deg, rgba(99, 102, 241, 0.94), rgba(59, 130, 246, 0.9));
              border-color: rgba(255, 255, 255, 0.12);
            }
            .gallery-summary {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 14px;
              color: #cbd5e1;
              padding: 0 4px;
            }
            .gallery-summary-count {
              display: inline-flex;
              align-items: center;
              gap: 10px;
              font-size: 0.95rem;
              font-weight: 700;
            }
            .gallery-summary-count strong {
              font-size: 1.2rem;
            }
            .gallery-summary-note {
              color: #94a3b8;
              font-size: 0.88rem;
            }
            .gallery-grid {
              display: grid;
              grid-template-columns: repeat(4, minmax(0, 1fr));
              gap: 18px;
            }
            .gallery-item {
              position: relative;
              overflow: hidden;
              border-radius: 24px;
              border: 1px solid rgba(148, 163, 184, 0.15);
              background:
                linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01)),
                linear-gradient(180deg, rgba(30, 41, 59, 0.88), rgba(15, 23, 42, 0.94));
              box-shadow: 0 18px 42px rgba(2, 6, 23, 0.24);
              cursor: pointer;
              transition: transform 0.25s ease, box-shadow 0.25s ease, border-color 0.25s ease;
            }
            .gallery-item:hover {
              transform: translateY(-6px);
              box-shadow: 0 28px 60px rgba(2, 6, 23, 0.36);
              border-color: rgba(129, 140, 248, 0.42);
            }
            .gallery-image-wrap {
              position: relative;
              padding: 14px;
              background:
                radial-gradient(circle at top, rgba(129, 140, 248, 0.12), transparent 42%),
                linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0));
            }
            .gallery-image-frame {
              position: relative;
              z-index: 1;
              overflow: hidden;
              border-radius: 22px;
              background:
                linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(241, 245, 249, 0.96));
              min-height: 320px;
              border: 1px solid rgba(255, 255, 255, 0.65);
              box-shadow:
                inset 0 1px 0 rgba(255, 255, 255, 0.9),
                0 14px 28px rgba(15, 23, 42, 0.08);
            }
            .gallery-image-frame img {
              width: 100%;
              height: 320px;
              object-fit: contain;
              display: block;
              padding: 10px;
              transition: transform 0.3s ease;
            }
            .gallery-badge-row {
              position: absolute;
              top: 24px;
              left: 24px;
              right: 24px;
              z-index: 3;
              display: flex;
              justify-content: space-between;
              gap: 8px;
              pointer-events: none;
              opacity: 0;
              transform: translateY(-8px);
              transition: opacity 0.22s ease, transform 0.22s ease;
            }
            .gallery-item:hover .gallery-badge-row {
              opacity: 1;
              transform: translateY(0);
            }
            .gallery-item:hover .gallery-image-frame img {
              transform: scale(1.02);
            }
            .gallery-badge,
            .gallery-chip {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              min-height: 30px;
              padding: 0 12px;
              border-radius: 999px;
              font-size: 0.72rem;
              font-weight: 800;
              letter-spacing: 0.03em;
              backdrop-filter: blur(10px);
            }
            .gallery-badge.ai {
              background: rgba(168, 85, 247, 0.88);
              color: #fff;
            }
            .gallery-badge.user {
              background: rgba(219, 234, 254, 0.92);
              color: #1d4ed8;
            }
            .gallery-chip {
              background: rgba(15, 23, 42, 0.72);
              color: #e2e8f0;
              border: 1px solid rgba(148, 163, 184, 0.18);
            }
            .gallery-item-footer {
              display: flex;
              flex-direction: column;
              gap: 14px;
              padding: 18px 18px 20px;
            }
            .gallery-item-head {
              display: flex;
              align-items: flex-start;
              justify-content: space-between;
              gap: 12px;
            }
            .gallery-model {
              display: inline-flex;
              align-items: center;
              max-width: 100%;
              padding: 8px 12px;
              border-radius: 14px;
              background: rgba(99, 102, 241, 0.16);
              color: #c7d2fe;
              font-size: 0.83rem;
              font-weight: 800;
              word-break: break-word;
            }
            .gallery-prefix {
              display: inline-flex;
              align-items: center;
              padding: 8px 10px;
              border-radius: 14px;
              background: rgba(255, 255, 255, 0.05);
              color: #94a3b8;
              font-size: 0.78rem;
              font-weight: 700;
              flex-shrink: 0;
            }
            .gallery-meta {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
              color: #cbd5e1;
              font-size: 0.86rem;
            }
            .gallery-uploader {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              min-width: 0;
              font-weight: 700;
            }
            .gallery-uploader span {
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .gallery-date {
              flex-shrink: 0;
              color: #94a3b8;
              font-size: 0.8rem;
              font-weight: 600;
            }
            .gallery-empty,
            .gallery-loading {
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              text-align: center;
              min-height: 320px;
              padding: 32px 24px;
              border-radius: 28px;
              border: 1px dashed rgba(148, 163, 184, 0.25);
              background: linear-gradient(180deg, rgba(15, 23, 42, 0.72), rgba(30, 41, 59, 0.5));
            }
            .gallery-empty-icon {
              width: 84px;
              height: 84px;
              border-radius: 28px;
              display: flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 18px;
              background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(59, 130, 246, 0.18));
              border: 1px solid rgba(129, 140, 248, 0.22);
            }
            .gallery-empty h2 {
              font-size: 1.4rem;
              margin-bottom: 8px;
            }
            .gallery-empty p {
              max-width: 520px;
              color: #94a3b8;
            }
            .gallery-spinner {
              width: 46px;
              height: 46px;
              border: 4px solid rgba(148, 163, 184, 0.2);
              border-top-color: #818cf8;
              border-radius: 50%;
              animation: gallery-spin 0.9s linear infinite;
              margin-bottom: 16px;
            }
            .gallery-modal {
              width: min(720px, 100%);
              max-height: min(88vh, 900px);
              overflow: hidden;
              border-radius: 28px;
              border: 1px solid rgba(148, 163, 184, 0.16);
              background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.94));
              box-shadow: 0 30px 80px rgba(2, 6, 23, 0.55);
            }
            .gallery-modal-header {
              display: flex;
              align-items: flex-start;
              justify-content: space-between;
              gap: 12px;
              padding: 20px 20px 16px;
              border-bottom: 1px solid rgba(148, 163, 184, 0.14);
            }
            .gallery-modal-title {
              margin: 0;
              font-size: 1.3rem;
              font-weight: 800;
              color: #f8fafc;
            }
            .gallery-modal-subtitle {
              margin-top: 6px;
              color: #94a3b8;
              font-size: 0.9rem;
            }
            .gallery-close-btn {
              width: 40px;
              height: 40px;
              border-radius: 14px;
              border: 1px solid rgba(148, 163, 184, 0.14);
              background: rgba(255, 255, 255, 0.05);
              color: #cbd5e1;
              cursor: pointer;
              flex-shrink: 0;
            }
            .gallery-modal-body {
              display: flex;
              flex-direction: column;
              gap: 18px;
              padding: 20px;
              max-height: calc(88vh - 92px);
              overflow-y: auto;
            }
            .gallery-upload-dropzone {
              border: 1.5px dashed rgba(129, 140, 248, 0.34);
              border-radius: 22px;
              padding: 22px 18px;
              background: linear-gradient(180deg, rgba(99, 102, 241, 0.08), rgba(15, 23, 42, 0.1));
              text-align: center;
              cursor: pointer;
              transition: border-color 0.2s ease, transform 0.2s ease, background 0.2s ease;
            }
            .gallery-upload-dropzone:hover {
              border-color: rgba(129, 140, 248, 0.65);
              transform: translateY(-1px);
            }
            .gallery-upload-dropzone svg {
              margin-bottom: 10px;
            }
            .gallery-upload-title {
              color: #f8fafc;
              font-weight: 700;
              margin-bottom: 4px;
            }
            .gallery-upload-hint {
              color: #94a3b8;
              font-size: 0.88rem;
            }
            .gallery-preview-grid {
              display: grid;
              grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
              gap: 12px;
            }
            .gallery-preview-card {
              position: relative;
              overflow: hidden;
              border-radius: 18px;
              border: 1px solid rgba(148, 163, 184, 0.16);
              background: rgba(255, 255, 255, 0.04);
              aspect-ratio: 1 / 1;
            }
            .gallery-preview-card img {
              width: 100%;
              height: 100%;
              object-fit: cover;
              display: block;
            }
            .gallery-preview-remove {
              position: absolute;
              top: 8px;
              right: 8px;
              width: 28px;
              height: 28px;
              border: none;
              border-radius: 999px;
              background: rgba(15, 23, 42, 0.78);
              color: #fff;
              cursor: pointer;
            }
            .gallery-lightbox-overlay {
              position: fixed;
              inset: 0;
              z-index: 2100;
              background: rgba(2, 6, 23, 0.82);
              backdrop-filter: blur(10px);
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .gallery-lightbox {
              width: min(1100px, 100%);
              max-height: min(92vh, 1000px);
              display: grid;
              grid-template-rows: auto minmax(0, 1fr) auto;
              gap: 14px;
              padding: 18px;
              border-radius: 28px;
              border: 1px solid rgba(148, 163, 184, 0.18);
              background: rgba(15, 23, 42, 0.96);
              box-shadow: 0 30px 80px rgba(2, 6, 23, 0.55);
            }
            .gallery-lightbox-header,
            .gallery-lightbox-footer {
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
            }
            .gallery-lightbox-title {
              margin: 0;
              font-size: 1.05rem;
              font-weight: 800;
              color: #f8fafc;
            }
            .gallery-lightbox-subtitle {
              margin-top: 4px;
              color: #94a3b8;
              font-size: 0.88rem;
            }
            .gallery-lightbox-image-wrap {
              min-height: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              border-radius: 22px;
              overflow: hidden;
              background:
                radial-gradient(circle at top, rgba(129, 140, 248, 0.14), transparent 42%),
                rgba(255, 255, 255, 0.04);
              border: 1px solid rgba(148, 163, 184, 0.12);
            }
            .gallery-lightbox-image-wrap img {
              width: 100%;
              max-height: calc(92vh - 220px);
              object-fit: contain;
              display: block;
            }
            .gallery-lightbox-close {
              width: 42px;
              height: 42px;
              border-radius: 14px;
              border: 1px solid rgba(148, 163, 184, 0.16);
              background: rgba(255, 255, 255, 0.06);
              color: #fff;
              cursor: pointer;
              flex-shrink: 0;
            }
            .gallery-lightbox-badges {
              display: flex;
              flex-wrap: wrap;
              gap: 8px;
            }
            .gallery-modal-actions {
              display: flex;
              gap: 12px;
              justify-content: flex-end;
            }
            .gallery-secondary-action {
              min-height: 50px;
              padding: 0 18px;
              border-radius: 16px;
              border: 1px solid rgba(148, 163, 184, 0.18);
              background: rgba(255, 255, 255, 0.04);
              color: var(--text-primary);
              font-weight: 700;
              cursor: pointer;
            }
            html[data-theme="light"] .gallery-page-shell {
              background:
                radial-gradient(circle at top left, rgba(59, 130, 246, 0.16), transparent 28%),
                radial-gradient(circle at top right, rgba(167, 139, 250, 0.18), transparent 30%),
                linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%);
            }
            html[data-theme="light"] .gallery-topbar,
            html[data-theme="light"] .gallery-panel,
            html[data-theme="light"] .gallery-item,
            html[data-theme="light"] .gallery-modal,
            html[data-theme="light"] .gallery-lightbox {
              background: rgba(255, 255, 255, 0.88);
              border-color: rgba(15, 23, 42, 0.08);
              box-shadow: 0 18px 42px rgba(15, 23, 42, 0.08);
            }
            html[data-theme="light"] .gallery-subtitle,
            html[data-theme="light"] .gallery-summary-note,
            html[data-theme="light"] .gallery-empty p,
            html[data-theme="light"] .gallery-modal-subtitle,
            html[data-theme="light"] .gallery-upload-hint,
            html[data-theme="light"] .gallery-date,
            html[data-theme="light"] .gallery-prefix {
              color: #526277;
            }
            html[data-theme="light"] .gallery-kicker {
              background: rgba(79, 70, 229, 0.08);
              color: #4338ca;
            }
            html[data-theme="light"] .gallery-page h1 {
              background: linear-gradient(135deg, #1e293b 0%, #2563eb 52%, #4f46e5 100%);
              -webkit-background-clip: text;
              -webkit-text-fill-color: transparent;
            }
            html[data-theme="light"] .gallery-filter-label,
            html[data-theme="light"] .gallery-summary,
            html[data-theme="light"] .gallery-lightbox-title,
            html[data-theme="light"] .gallery-modal-title,
            html[data-theme="light"] .gallery-empty h2 {
              color: #1e293b;
            }
            html[data-theme="light"] .gallery-summary-count strong,
            html[data-theme="light"] .gallery-uploader,
            html[data-theme="light"] .gallery-model,
            html[data-theme="light"] .gallery-clear-btn,
            html[data-theme="light"] .gallery-secondary-action,
            html[data-theme="light"] .gallery-source-pill {
              color: #334155;
            }
            html[data-theme="light"] .gallery-input::placeholder {
              color: #64748b;
              opacity: 1;
            }
            html[data-theme="light"] .gallery-date-divider,
            html[data-theme="light"] .gallery-summary-note,
            html[data-theme="light"] .gallery-empty p,
            html[data-theme="light"] .gallery-lightbox-subtitle {
              color: #64748b;
            }
            html[data-theme="light"] .gallery-filter-card,
            html[data-theme="light"] .gallery-upload-dropzone,
            html[data-theme="light"] .gallery-preview-card {
              background: rgba(248, 250, 252, 0.92);
              border-color: rgba(15, 23, 42, 0.08);
            }
            html[data-theme="light"] .gallery-advanced-btn {
              background: linear-gradient(180deg, rgba(241, 245, 249, 0.96), rgba(226, 232, 240, 0.92));
              color: #111827;
              border-color: rgba(148, 163, 184, 0.28);
              box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
            }
            html[data-theme="light"] .gallery-advanced-btn svg {
              color: #111827;
            }
            html[data-theme="light"] .gallery-advanced-btn:hover {
              background: linear-gradient(180deg, rgba(226, 232, 240, 0.98), rgba(203, 213, 225, 0.96));
              color: #0f172a;
              border-color: rgba(100, 116, 139, 0.32);
            }
            html[data-theme="light"] .gallery-advanced-btn:hover svg {
              color: #0f172a;
            }
            html[data-theme="light"] .gallery-advanced-btn.active {
              color: #111827;
            }
            html[data-theme="light"] .gallery-advanced-btn.active svg {
              color: #111827;
            }
            html[data-theme="light"] .gallery-input {
              background: rgba(255, 255, 255, 0.92);
              border-color: rgba(15, 23, 42, 0.08);
              color: #0f172a;
            }
            html[data-theme="light"] .gallery-date-picker-btn {
              color: #64748b;
            }
            html[data-theme="light"] .gallery-date-picker-btn:hover {
              background: rgba(15, 23, 42, 0.06);
              color: #0f172a;
            }
            html[data-theme="light"] .gallery-badge.user {
              background: rgba(219, 234, 254, 0.92);
              color: #1d4ed8;
            }
            html[data-theme="light"] .gallery-lightbox-title {
              color: #0f172a;
            }
            html[data-theme="light"] .gallery-lightbox-subtitle {
              color: #64748b;
            }
            html[data-theme="light"] .gallery-summary-count,
            html[data-theme="light"] .gallery-summary-note,
            html[data-theme="light"] .gallery-filter-label svg,
            html[data-theme="light"] .gallery-date-picker-btn,
            html[data-theme="light"] .gallery-uploader svg {
              color: #64748b;
            }
            html[data-theme="light"] .gallery-lightbox-image-wrap {
              background:
                radial-gradient(circle at top, rgba(129, 140, 248, 0.1), transparent 42%),
                rgba(248, 250, 252, 0.92);
              border-color: rgba(15, 23, 42, 0.08);
            }
            html[data-theme="light"] .gallery-chip {
              background: rgba(255, 255, 255, 0.9);
              color: #334155;
              border-color: rgba(15, 23, 42, 0.08);
            }
            html[data-theme="light"] .gallery-model {
              background: rgba(79, 70, 229, 0.08);
              color: #4338ca;
            }
            @keyframes gallery-spin {
              to { transform: rotate(360deg); }
            }
            @media (max-width: 960px) {
              .gallery-grid {
                grid-template-columns: repeat(2, minmax(0, 1fr));
              }
              .gallery-filter-wrap {
                grid-template-columns: 1fr;
              }
              .gallery-advanced-panel {
                grid-template-columns: 1fr;
              }
              .gallery-clear-btn {
                width: 100%;
              }
            }
            @media (max-width: 768px) {
              .gallery-page-shell {
                padding: 14px;
              }
              .gallery-page {
                gap: 14px;
              }
              .gallery-topbar {
                padding: 18px;
                border-radius: 24px;
                flex-direction: column;
              }
              .gallery-title-group {
                gap: 12px;
              }
              .gallery-back-btn {
                width: 42px;
                height: 42px;
                border-radius: 14px;
              }
              .gallery-primary-action {
                width: 100%;
              }
              .gallery-panel {
                padding: 14px;
                border-radius: 20px;
              }
              .gallery-tabs {
                flex-wrap: nowrap;
                overflow-x: auto;
                padding-bottom: 4px;
                scrollbar-width: none;
              }
              .gallery-tabs::-webkit-scrollbar {
                display: none;
              }
              .gallery-tab {
                white-space: nowrap;
                flex-shrink: 0;
              }
              .gallery-date-row {
                grid-template-columns: 1fr;
              }
              .gallery-date-divider {
                text-align: left;
              }
              .gallery-summary {
                flex-direction: column;
                align-items: flex-start;
              }
              .gallery-grid {
                grid-template-columns: 1fr;
                gap: 14px;
              }
              .gallery-image-frame,
              .gallery-image-frame img {
                min-height: 280px;
                height: 280px;
              }
              .gallery-item-footer {
                padding: 14px;
              }
              .gallery-item-head,
              .gallery-meta,
              .gallery-modal-actions {
                flex-direction: column;
                align-items: stretch;
              }
              .gallery-prefix,
              .gallery-date {
                align-self: flex-start;
              }
              .gallery-modal {
                border-radius: 24px;
              }
              .gallery-lightbox {
                padding: 14px;
                border-radius: 22px;
              }
              .gallery-lightbox-header,
              .gallery-lightbox-footer {
                flex-direction: column;
                align-items: stretch;
              }
              .gallery-lightbox-image-wrap img {
                max-height: calc(92vh - 260px);
              }
              .gallery-modal-header,
              .gallery-modal-body {
                padding: 16px;
              }
              .gallery-secondary-action,
              .gallery-modal-actions .gallery-primary-action {
                width: 100%;
              }
            }
          `,
        }}
      />

      <div className="gallery-page">
        <section className="gallery-topbar">
          <div className="gallery-title-group">
            <button
              type="button"
              className="gallery-back-btn"
              onClick={() => {
                window.location.href = "/";
              }}
              title="Quay lại chat"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <div>
              <div className="gallery-kicker">
                <span>Kho ảnh sản phẩm</span>
              </div>
              <h1>Thư viện ảnh</h1>
            </div>
          </div>

          <div>
            <input
              type="file"
              ref={fileInputRef}
              style={{ display: "none" }}
              accept="image/*"
              multiple
              onChange={handleFileChange}
            />
            <button
              type="button"
              className="gallery-primary-action"
              onClick={handleUploadClick}
              disabled={uploading}
            >
              {uploading ? (
                <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeDasharray="32" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              )}
              <span>{uploading ? "Đang tải lên..." : "Tải lên ảnh mới"}</span>
            </button>
          </div>
        </section>

        {(employeeId === "admin" || employeeId === "giam_doc") && (
          <section className="gallery-panel">
            <div className="gallery-tabs">
              {COMPANY_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`gallery-tab ${activeTab === tab ? "active" : ""}`}
                  onClick={() => {
                    setActiveTab(tab);
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="gallery-panel">
          <div className="gallery-filter-wrap">
            <div className="gallery-filter-card">
              <div className="gallery-filter-label">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <span>Tìm theo model hoặc tiền tố</span>
              </div>
              <input
                type="text"
                placeholder="Ví dụ: EXACT LINEAR, AL..."
                className="gallery-input"
                value={modelFilter}
                onChange={(e) => {
                  setModelFilter(e.target.value);
                }}
              />
            </div>

            <button
              type="button"
              className={`gallery-advanced-btn ${showAdvancedFilters ? "active" : ""}`}
              onClick={() => {
                setShowAdvancedFilters((value) => !value);
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
              </svg>
              <span>Bộ lọc nâng cao</span>
            </button>

            {(dateFilter.start || dateFilter.end || modelFilter || sourceFilter !== "ALL") && (
              <button type="button" className="gallery-clear-btn" onClick={clearFilters}>
                Xóa bộ lọc
              </button>
            )}
          </div>

          {showAdvancedFilters && (
            <div className="gallery-advanced-panel">
              <div className="gallery-filter-card">
                <div className="gallery-filter-label">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                  <span>Lọc theo ngày</span>
                </div>
                <div className="gallery-date-row">
                  <div className="gallery-date-input-wrap">
                    <input
                      type="date"
                      className="gallery-input"
                      value={dateFilter.start}
                      onChange={(e) => {
                        setDateFilter({ ...dateFilter, start: e.target.value });
                      }}
                    />
                    <button
                      type="button"
                      className="gallery-date-picker-btn"
                      aria-label="Chọn ngày bắt đầu"
                      onClick={(event) => {
                        const input = event.currentTarget.previousElementSibling as HTMLInputElement | null;
                        input?.showPicker?.();
                        input?.focus();
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                    </button>
                  </div>
                  <span className="gallery-date-divider">Đến</span>
                  <div className="gallery-date-input-wrap">
                    <input
                      type="date"
                      className="gallery-input"
                      value={dateFilter.end}
                      onChange={(e) => {
                        setDateFilter({ ...dateFilter, end: e.target.value });
                      }}
                    />
                    <button
                      type="button"
                      className="gallery-date-picker-btn"
                      aria-label="Chọn ngày kết thúc"
                      onClick={(event) => {
                        const input = event.currentTarget.previousElementSibling as HTMLInputElement | null;
                        input?.showPicker?.();
                        input?.focus();
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="4" width="18" height="18" rx="2" />
                        <line x1="16" y1="2" x2="16" y2="6" />
                        <line x1="8" y1="2" x2="8" y2="6" />
                        <line x1="3" y1="10" x2="21" y2="10" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              <div className="gallery-filter-card">
                <div className="gallery-filter-label">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M20.4 14.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>Nguồn ảnh</span>
                </div>
                <div className="gallery-source-pills">
                  {[
                    { label: "Tất cả", value: "ALL" },
                    { label: "Agent tạo", value: "AI" },
                    { label: "Người dùng thêm", value: "USER" },
                  ].map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`gallery-source-pill ${sourceFilter === option.value ? "active" : ""}`}
                      onClick={() => {
                        setSourceFilter(option.value as "ALL" | "AI" | "USER");
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <div className="gallery-summary">
          <div className="gallery-summary-count">
            <span>Kết quả</span>
            <strong>{filteredImages.length}</strong>
            <span>ảnh</span>
          </div>
          <div className="gallery-summary-note">
            Chạm vào ảnh để xem ảnh phóng to ngay trên màn hình.
          </div>
        </div>

        {fetching ? (
          <div className="gallery-loading">
            <div className="gallery-spinner" />
            <p>Đang tải thư viện ảnh...</p>
          </div>
        ) : filteredImages.length === 0 ? (
          <div className="gallery-empty">
            <div className="gallery-empty-icon">
              <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="1.6">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </div>
            <h2>Chưa có hình ảnh phù hợp</h2>
            <p>
              Hãy thử thay đổi bộ lọc hoặc tải thêm ảnh sản phẩm mới để làm phong phú thư viện.
            </p>
          </div>
        ) : (
          <div className="gallery-grid">
            {filteredImages.map((img) => {
              const gridSrc = getGalleryGridImageSrc(img);
              const fallbackSrc = resolveMediaUrl(img.url);
              const openSrc = getGalleryOpenImageSrc(img);

              return (
                <article
                  key={img.id}
                  className="gallery-item"
                  onClick={() => {
                    setSelectedPreview({
                      src: openSrc || gridSrc || fallbackSrc || "",
                      fallbackSrc: fallbackSrc || "",
                      alt: getGalleryImageAlt(img),
                      model: img.productModel || "Chưa có model",
                      uploader: img.uploaderId || "Ẩn danh",
                      createdAt: Number(img.createdAt),
                      source: normalizeImageSource(img.source),
                    });
                  }}
                >
                  <div className="gallery-image-wrap">
                    <div className="gallery-badge-row">
                      <span className={`gallery-badge ${normalizeImageSource(img.source) === "AI" ? "ai" : "user"}`}>
                        {normalizeImageSource(img.source) === "AI" ? "AI Generated" : "User Upload"}
                      </span>
                      {img.companyId && <span className="gallery-chip">{img.companyId}</span>}
                    </div>

                    <div className="gallery-image-frame">
                      <SmartImage
                        src={gridSrc}
                        fallbackSrc={fallbackSrc}
                        alt={getGalleryImageAlt(img)}
                      />
                    </div>
                  </div>

                  <div className="gallery-item-footer">
                    <div className="gallery-item-head">
                      <span className="gallery-model">{img.productModel || "Chưa có model"}</span>
                      {img.prefix && <span className="gallery-prefix">{img.prefix}</span>}
                    </div>

                    <div className="gallery-meta">
                      <div className="gallery-uploader">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        <span>{img.uploaderId}</span>
                      </div>
                      <span className="gallery-date">
                        {new Date(Number(img.createdAt)).toLocaleDateString("vi-VN")}
                      </span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {selectedPreview && (
        <div
          className="gallery-lightbox-overlay"
          onMouseDown={() => {
            setSelectedPreview(null);
          }}
        >
          <div
            className="gallery-lightbox"
            onMouseDown={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="gallery-lightbox-header">
              <div>
                <h3 className="gallery-lightbox-title">{selectedPreview.model}</h3>
                <div className="gallery-lightbox-subtitle">
                  {selectedPreview.uploader} • {new Date(selectedPreview.createdAt).toLocaleDateString("vi-VN")}
                </div>
              </div>
              <button
                type="button"
                className="gallery-lightbox-close"
                onClick={() => {
                  setSelectedPreview(null);
                }}
              >
                ✕
              </button>
            </div>

            <div className="gallery-lightbox-image-wrap">
              <SmartImage
                src={selectedPreview.src}
                fallbackSrc={selectedPreview.fallbackSrc}
                alt={selectedPreview.alt}
              />
            </div>

            <div className="gallery-lightbox-footer">
              <div className="gallery-lightbox-badges">
                <span className={`gallery-badge ${selectedPreview.source === "AI" ? "ai" : "user"}`}>
                  {selectedPreview.source === "AI" ? "AI Generated" : "User Upload"}
                </span>
              </div>
              <div className="gallery-lightbox-subtitle">Nhấn Esc hoặc chạm ra ngoài để đóng.</div>
            </div>
          </div>
        </div>
      )}

      {showUploadModal && (
        <div
          className="search-modal-overlay"
          onMouseDown={() => {
            setShowUploadModal(false);
          }}
        >
          <div
            className="gallery-modal"
            onMouseDown={(e) => {
              e.stopPropagation();
            }}
          >
            <div className="gallery-modal-header">
              <div>
                <h3 className="gallery-modal-title">Tải lên ảnh mới</h3>
                <p className="gallery-modal-subtitle">
                  Nhập model sản phẩm và chọn ảnh cần thêm vào thư viện.
                </p>
              </div>
              <button
                type="button"
                className="gallery-close-btn"
                onClick={() => {
                  setShowUploadModal(false);
                }}
              >
                ✕
              </button>
            </div>

            <div className="gallery-modal-body">
              <div className="form-group">
                <label style={{ color: "var(--text-secondary)", fontSize: "0.88rem", fontWeight: 700 }}>
                  Mã / Model sản phẩm
                </label>
                <input
                  type="text"
                  placeholder="Ví dụ: IPHONE-15-PRO"
                  className="gallery-input"
                  value={uploadModel}
                  onChange={(e) => {
                    setUploadModel(e.target.value);
                  }}
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label style={{ color: "var(--text-secondary)", fontSize: "0.88rem", fontWeight: 700 }}>
                  Hình ảnh sản phẩm ({selectedFiles.length})
                </label>

                <div
                  className="gallery-upload-dropzone"
                  onClick={() => {
                    fileInputRef.current?.click();
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <div className="gallery-upload-title">Chọn ảnh từ thiết bị</div>
                  <div className="gallery-upload-hint">
                    Hỗ trợ chọn nhiều ảnh cùng lúc để tải lên nhanh hơn.
                  </div>
                </div>

                {previewUrls.length > 0 && (
                  <div className="gallery-preview-grid">
                    {previewUrls.map((url, index) => (
                      <div key={url + index} className="gallery-preview-card">
                        <img src={url} alt={`Preview ${index + 1}`} />
                        <button
                          type="button"
                          className="gallery-preview-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeFile(index);
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="gallery-modal-actions">
                <button
                  type="button"
                  className="gallery-secondary-action"
                  onClick={() => {
                    setShowUploadModal(false);
                  }}
                >
                  Hủy
                </button>
                <button
                  type="button"
                  className="gallery-primary-action"
                  onClick={confirmUpload}
                  disabled={uploading || selectedFiles.length === 0 || !uploadModel.trim()}
                >
                  {uploading ? "Đang tải lên..." : `Xác nhận tải lên (${selectedFiles.length})`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

