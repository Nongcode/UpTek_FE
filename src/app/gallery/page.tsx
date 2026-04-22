"use client";

import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "@/context/AuthContext";
import toast from "react-hot-toast";

interface ImageItem {
  id: string;
  url: string;
  companyId: string;
  departmentId: string;
  source: string;
  uploaderId: string;
  createdAt: number;
  productModel?: string;
  prefix?: string;
}

export default function GalleryPage() {
  const { backendToken, isAuthenticated, isLoading, employeeId, accessPolicy } = useAuth();
  const [images, setImages] = useState<ImageItem[]>([]);
  const [filteredImages, setFilteredImages] = useState<ImageItem[]>([]);
  const [activeTab, setActiveTab] = useState<string>("Tất cả");
  const [fetching, setFetching] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dateFilter, setDateFilter] = useState<{ start: string; end: string }>({ start: "", end: "" });
  const [modelFilter, setModelFilter] = useState("");
  const [uploadModel, setUploadModel] = useState("");
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      window.location.href = "/";
    }
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (backendToken) {
      fetchImages();
    }
  }, [backendToken]);

  useEffect(() => {
    applyFilter();
  }, [images, dateFilter, modelFilter, activeTab]);

  const fetchImages = async () => {
    try {
      setFetching(true);
      const res = await fetch("http://localhost:3001/api/gallery", {
        headers: {
          Authorization: `Bearer ${backendToken}`,
        },
      });
      if (!res.ok) throw new Error("Lỗi khi tải ảnh");
      const data = await res.json();
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
      const endMs = new Date(dateFilter.end).getTime() + 86400000 - 1; // Cuối ngày
      result = result.filter((img) => img.createdAt <= endMs);
    }
    if (modelFilter.trim() !== "") {
      const query = modelFilter.toLowerCase().trim();
      result = result.filter((img) => img.productModel?.toLowerCase().includes(query) || img.prefix?.toLowerCase().includes(query));
    }
    if (activeTab !== "Tất cả") {
      const targetCompany = activeTab === "Công ty A" ? "CongTyA" 
                          : activeTab === "Công ty B" ? "CongTyB" 
                          : activeTab === "Công ty C" ? "CongTyC" : "UpTek";
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

    const validFiles = files.filter(file => file.type.startsWith("image/"));
    if (validFiles.length < files.length) {
      toast.error("Một số file không phải hình ảnh và đã bị loại bỏ.");
    }

    if (validFiles.length === 0) return;

    setSelectedFiles(prev => [...prev, ...validFiles]);
    
    validFiles.forEach(file => {
      const reader = new FileReader();
      reader.onloadend = () => {
        setPreviewUrls(prev => [...prev, reader.result as string]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
    setPreviewUrls(prev => prev.filter((_, i) => i !== index));
  };

  const confirmUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error("Vui lòng chọn ít nhất một ảnh!");
      return;
    }
    if (!uploadModel.trim()) {
      toast.error("Vui lòng nhập Model Sản Phẩm!");
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
      
      selectedFiles.forEach(file => {
        formData.append("images", file);
      });

      const res = await fetch("http://localhost:3001/api/gallery/upload", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${backendToken}`,
        },
        body: formData,
      });

      if (!res.ok) throw new Error("Tải lên thất bại");

      toast.success(`Đã thêm ${selectedFiles.length} ảnh thành công!`);
      setShowUploadModal(false);
      fetchImages();
    } catch (error: any) {
      toast.error(error.message || "Lỗi upload");
    } finally {
      setUploading(false);
    }
  };

  if (isLoading) return <div style={{ color: "var(--text-primary)", padding: "2rem" }}>Đang tải...</div>;

  return (
    <div style={{ padding: "2rem", color: "var(--text-primary)", height: "100vh", overflowY: "auto" }}>
      <style dangerouslySetInnerHTML={{
        __html: `
        .gallery-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 2rem;
          margin-top: 2rem;
        }
        .gallery-item {
          background: var(--bg-panel);
          border: 1px solid var(--border-color);
          border-radius: 20px;
          overflow: hidden;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          cursor: pointer;
          backdrop-filter: blur(10px);
          position: relative;
          box-shadow: var(--shadow-sm);
        }
        html[data-theme="light"] .gallery-item {
          background: #ffffff;
          box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05);
        }
        .gallery-item:hover {
          transform: translateY(-8px) scale(1.02);
          box-shadow: var(--shadow-lg);
          border-color: var(--accent-primary);
        }
        html[data-theme="light"] .gallery-item:hover {
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.08);
        }
        .gallery-item img {
          width: 100%;
          height: 320px;
          object-fit: contain;
          background: #ffffff;
          display: block;
          border-bottom: 1px solid var(--border-color);
        }
        .gallery-overlay {
          position: absolute;
          inset: 0;
          background: transparent;
          opacity: 0;
          transition: all 0.3s ease;
          display: flex;
          align-items: flex-start;
          justify-content: flex-start;
          padding: 12px;
          pointer-events: none;
        }
        .gallery-item:hover .gallery-overlay {
          opacity: 1;
        }
        html[data-theme="light"] .gallery-item:hover .gallery-overlay {
          transform: translateY(0);
        }
        .gallery-item-footer {
          padding: 1rem;
          font-size: 0.875rem;
          background: var(--bg-input);
          color: var(--text-primary);
        }
        .filter-bar {
          display: flex;
          gap: 1rem;
          background: var(--bg-panel);
          padding: 1rem 1.5rem;
          border-radius: 16px;
          backdrop-filter: blur(12px);
          border: 1px solid var(--border-color);
          align-items: center;
          margin-bottom: 2rem;
          flex-wrap: wrap;
          box-shadow: var(--shadow-md);
        }
        .filter-input {
          background: var(--bg-input);
          border: 1px solid var(--border-color);
          color: var(--text-primary);
          padding: 0.6rem 1rem;
          border-radius: 8px;
          outline: none;
          font-size: 0.9rem;
          transition: border-color 0.2s;
        }
        .filter-input:focus {
          border-color: var(--accent-primary);
          box-shadow: 0 0 0 2px var(--accent-ring);
        }
        .upload-btn {
          background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%);
          color: white;
          border: none;
          padding: 0.6rem 1.2rem;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 600;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.4);
        }
        .upload-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 10px 15px -3px rgba(59, 130, 246, 0.5);
          background: linear-gradient(135deg, #4338ca 0%, #2563eb 100%);
        }
        .upload-btn:active {
          transform: translateY(0);
        }
        .upload-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
          transform: none;
        }
        /* Custom scrollbar */
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: rgba(0,0,0,0.1); }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
      `}} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "2rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <button 
            onClick={() => window.location.href = "/"}
            style={{ 
              background: "var(--bg-panel)", 
              border: "1px solid var(--border-color)", 
              borderRadius: "12px", 
              padding: "0.6rem", 
              color: "var(--text-primary)", 
              cursor: "pointer", 
              display: "flex", 
              alignItems: "center", 
              justifyContent: "center",
              transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
              backdropFilter: "blur(12px)"
            }}
            onMouseOver={(e) => { e.currentTarget.style.transform = "translateX(-4px)"; e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.borderColor = "var(--accent-primary)"; }}
            onMouseOut={(e) => { e.currentTarget.style.transform = "translateX(0)"; e.currentTarget.style.background = "var(--bg-panel)"; e.currentTarget.style.borderColor = "var(--border-color)"; }}
            title="Quay lại Chat"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
          </button>
          <h1 style={{ margin: 0, fontSize: "2.5rem", fontWeight: 700, background: "linear-gradient(to right, #60a5fa, #a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", textShadow: "0 2px 10px rgba(96, 165, 250, 0.2)" }}>
            Thư Viện Ảnh
          </h1>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: "none" }}
            accept="image/*"
            multiple
            onChange={handleFileChange}
          />
          <button
            className="upload-btn"
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
            {uploading ? "Đang tải lên..." : "Tải lên ảnh mới"}
          </button>
        </div>
      </div>

      {(employeeId === "admin" || employeeId === "giam_doc") && (
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "2rem", padding: "6px", background: "var(--bg-panel)", borderRadius: "16px", width: "fit-content", backdropFilter: "blur(20px)", border: "1px solid var(--border-color)", flexWrap: "wrap", boxShadow: "var(--shadow-md)" }}>
          {["Tất cả", "UpTek", "Công ty A", "Công ty B", "Công ty C"].map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: "0.6rem 1.8rem",
                borderRadius: "12px",
                border: "none",
                fontSize: "0.9rem",
                fontWeight: 700,
                cursor: "pointer",
                transition: "all 0.3s cubic-bezier(0.4, 0, 0.2, 1)",
                background: activeTab === tab ? "linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)" : "transparent",
                color: activeTab === tab ? "#ffffff" : "var(--text-secondary)",
                boxShadow: activeTab === tab ? "0 10px 15px -3px rgba(99, 102, 241, 0.3)" : "none",
                transform: activeTab === tab ? "translateY(-1px)" : "none"
              }}
              onMouseOver={(e) => { if (activeTab !== tab) e.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseOut={(e) => { if (activeTab !== tab) e.currentTarget.style.background = "transparent"; }}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      <div className="filter-bar">
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
          </svg>
          <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>Lọc theo ngày:</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <input
            type="date"
            className="filter-input"
            value={dateFilter.start}
            onChange={(e) => setDateFilter({ ...dateFilter, start: e.target.value })}
          />
          <span style={{ color: "#64748b" }}>đến</span>
          <input
            type="date"
            className="filter-input"
            value={dateFilter.end}
            onChange={(e) => setDateFilter({ ...dateFilter, end: e.target.value })}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginLeft: "1rem", borderLeft: "1px solid rgba(255,255,255,0.1)", paddingLeft: "1rem" }}>
          <input
            type="text"
            placeholder="Tìm theo Model / Tiền tố..."
            className="filter-input"
            value={modelFilter}
            onChange={(e) => setModelFilter(e.target.value)}
            style={{ width: "200px" }}
          />
        </div>
        {(dateFilter.start || dateFilter.end || modelFilter) && (
          <button
            onClick={() => { setDateFilter({ start: "", end: "" }); setModelFilter(""); }}
            style={{ 
              background: "transparent", 
              border: "1px solid var(--border-color)", 
              color: "var(--text-secondary)", 
              padding: "0.4rem 0.8rem", 
              borderRadius: "6px", 
              cursor: "pointer", 
              marginLeft: "auto", 
              fontSize: "0.85rem", 
              transition: "all 0.2s" 
            }}
            onMouseOver={(e) => e.currentTarget.style.background = "var(--bg-hover)"}
            onMouseOut={(e) => e.currentTarget.style.background = "transparent"}
          >
            Xóa bộ lọc
          </button>
        )}
      </div>

      {fetching ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "4rem" }}>
          <div style={{ width: "40px", height: "40px", border: "4px solid var(--border-color)", borderTopColor: "var(--accent-primary)", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
          <style dangerouslySetInnerHTML={{ __html: `@keyframes spin { to { transform: rotate(360deg); } }` }} />
        </div>
      ) : filteredImages.length === 0 ? (
        <div style={{ textAlign: "center", padding: "5rem 2rem", color: "var(--text-secondary)", background: "var(--bg-panel)", borderRadius: "24px", border: "2px dashed var(--border-color)", boxShadow: "var(--shadow-sm)" }}>
          <div style={{ background: "var(--bg-hover)", width: "80px", height: "80px", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 1.5rem" }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent-primary)" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </div>
          <p style={{ fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)", marginBottom: "0.5rem" }}>Chưa có hình ảnh nào</p>
          <p style={{ fontSize: "0.95rem" }}>Bắt đầu bằng cách tải lên hình ảnh sản phẩm mới hoặc yêu cầu AI tạo ảnh cho bạn.</p>
        </div>
      ) : (
        <div className="gallery-grid">
          {filteredImages.map((img) => (
            <div key={img.id} className="gallery-item" onClick={() => window.open(`http://localhost:3001${img.url}`, '_blank')}>
              <img src={`http://localhost:3001${img.url}`} alt="Gallery item" loading="lazy" />
              <div className="gallery-overlay">
                <span style={{ 
                  background: img.source === "AI" ? "var(--accent-secondary)" : (document.documentElement.getAttribute('data-theme') === 'light' ? "#dbeafe" : "var(--accent-primary)"), 
                  color: img.source === "AI" ? "#ffffff" : (document.documentElement.getAttribute('data-theme') === 'light' ? "#1e40af" : "#ffffff"),
                  padding: "6px 12px", 
                  borderRadius: "20px", 
                  fontSize: "0.7rem", 
                  fontWeight: 700, 
                  letterSpacing: "0.5px",
                  boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
                  border: document.documentElement.getAttribute('data-theme') === 'light' ? "1px solid #bfdbfe" : "none"
                }}>
                  {img.source === "AI" ? "✨ AI GENERATED" : "👤 USER UPLOAD"}
                </span>
              </div>
              <div className="gallery-item-footer">
                <div style={{ marginBottom: "8px", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span style={{ background: "var(--active-bg)", color: "var(--accent-primary)", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 700 }}>
                    {img.productModel || "N/A"}
                  </span>
                  {img.prefix && (
                    <span style={{ background: "var(--bg-hover)", color: "var(--accent-secondary)", padding: "2px 8px", borderRadius: "4px", fontSize: "0.75rem", fontWeight: 600 }}>
                      {img.prefix}
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <span style={{ color: "var(--text-primary)", fontWeight: 600, display: "flex", alignItems: "center", gap: "6px" }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                      <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                    {img.uploaderId}
                  </span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.75rem", fontWeight: 500 }}>
                    {new Date(Number(img.createdAt)).toLocaleDateString('vi-VN')}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {showUploadModal && (
        <div className="search-modal-overlay" onMouseDown={() => setShowUploadModal(false)}>
          <div className="search-modal" onMouseDown={(e) => e.stopPropagation()} style={{ maxWidth: "500px" }}>
            <div className="search-modal-header" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Tải lên ảnh mới</h3>
              <button className="search-modal-close" onClick={() => setShowUploadModal(false)}>✕</button>
            </div>
            <div className="search-modal-body" style={{ padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
              <div className="form-group">
                <label style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem", display: "block" }}>
                  Mã / Model Sản phẩm
                </label>
                <input
                  type="text"
                  placeholder="Ví dụ: IPHONE-15-PRO"
                  className="filter-input"
                  value={uploadModel}
                  onChange={(e) => setUploadModel(e.target.value)}
                  style={{ width: "100%" }}
                  autoFocus
                />
              </div>

              <div className="form-group">
                <label style={{ color: "var(--text-secondary)", fontSize: "0.85rem", fontWeight: 600, marginBottom: "0.5rem", display: "block" }}>
                  Hình ảnh sản phẩm ({selectedFiles.length})
                </label>
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  style={{ 
                    border: "2px dashed var(--border-color)", 
                    borderRadius: "12px", 
                    padding: "0.75rem", 
                    textAlign: "center", 
                    cursor: "pointer",
                    transition: "all 0.2s",
                    marginBottom: previewUrls.length > 0 ? "1rem" : 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "0.75rem"
                  }}
                  onMouseOver={(e) => e.currentTarget.style.borderColor = "var(--accent-primary)"}
                  onMouseOut={(e) => e.currentTarget.style.borderColor = "var(--border-color)"}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>Nhấn để thêm ảnh hoặc kéo thả</p>
                </div>

                {previewUrls.length > 0 && (
                  <div style={{ 
                    display: "grid", 
                    gridTemplateColumns: "repeat(auto-fill, minmax(130px, 1fr))", 
                    gap: "12px",
                    maxHeight: "400px",
                    overflowY: "auto",
                    padding: "4px"
                  }}>
                    {previewUrls.map((url, index) => (
                      <div key={index} style={{ position: "relative", borderRadius: "8px", overflow: "hidden", border: "1px solid var(--border-color)", height: "130px" }}>
                        <img src={url} alt={`Preview ${index}`} style={{ width: "100%", height: "100%", objectFit: "cover", background: "#f8fafc" }} />
                        <button 
                          onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                          style={{ 
                            position: "absolute", 
                            top: "4px", 
                            right: "4px", 
                            background: "rgba(0,0,0,0.6)", 
                            color: "white", 
                            border: "none", 
                            borderRadius: "50%", 
                            width: "18px", 
                            height: "18px", 
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "10px"
                          }}
                        >✕</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: "flex", gap: "1rem", marginTop: "0.5rem" }}>
                <button 
                  className="upload-btn" 
                  style={{ flex: 1, justifyContent: "center" }}
                  onClick={confirmUpload}
                  disabled={uploading || selectedFiles.length === 0 || !uploadModel.trim()}
                >
                  {uploading ? "Đang tải lên..." : `Xác nhận Tải lên (${selectedFiles.length})`}
                </button>
                <button 
                  onClick={() => setShowUploadModal(false)}
                  style={{ 
                    padding: "0.6rem 1.2rem", 
                    borderRadius: "8px", 
                    border: "1px solid var(--border-color)", 
                    background: "transparent", 
                    color: "var(--text-primary)", 
                    cursor: "pointer",
                    fontWeight: 600
                  }}
                >
                  Hủy
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
