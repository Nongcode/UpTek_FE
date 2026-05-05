import { BACKEND_BASE } from "./api";

export interface MediaVariant {
  url?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
}

export interface MediaVariants {
  thumb?: MediaVariant | null;
  small?: MediaVariant | null;
  medium?: MediaVariant | null;
}

export interface GalleryImageItem {
  id: string;
  url?: string | null;
  mediaFileId?: string | null;
  companyId: string;
  departmentId: string;
  source: string;
  uploaderId?: string | null;
  createdAt: number;
  productModel?: string | null;
  prefix?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  originalUrl?: string | null;
  variants?: MediaVariants | null;
}

export function resolveMediaUrl(value?: string | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  // CDN/public URLs from the backend are already browser-ready.
  if (/^(https?:|data:|blob:)/i.test(raw)) {
    return raw;
  }

  // Local filesystem paths are not browser-readable. Fall back to a legacy URL if available.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    return null;
  }


  if (raw.startsWith("/storage/")) {
    return `/backend-storage${raw.slice("/storage".length)}`;
  }

  if (raw.startsWith("/api/media/")) {
    return `${BACKEND_BASE}${raw.slice("/api".length)}`;
  }

  return raw;
}

export function getGalleryGridImageSrc(image: GalleryImageItem): string | null {
  return (
    resolveMediaUrl(image.variants?.thumb?.url) ||
    resolveMediaUrl(image.variants?.small?.url) ||
    resolveMediaUrl(image.url)
  );
}

export function getGalleryOpenImageSrc(image: GalleryImageItem): string | null {
  return (
    resolveMediaUrl(image.originalUrl) ||
    resolveMediaUrl(image.variants?.medium?.url) ||
    resolveMediaUrl(image.url)
  );
}

export function getGalleryImageAlt(image: GalleryImageItem): string {
  const label = image.productModel || image.prefix || image.source || "Gallery image";
  return `${label} gallery image`;
}

export async function fetchGalleryImages(token?: string | null): Promise<GalleryImageItem[]> {
  const res = await fetch(`${BACKEND_BASE}/gallery`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });

  if (!res.ok) {
    throw new Error("Loi khi tai anh");
  }

  return (await res.json()) as GalleryImageItem[];
}

export async function uploadGalleryImages(formData: FormData, token?: string | null): Promise<void> {
  const res = await fetch(`${BACKEND_BASE}/gallery/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message || data?.message || "Tai len that bai");
  }
}
